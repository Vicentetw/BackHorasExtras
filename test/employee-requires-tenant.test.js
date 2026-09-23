// Bug real reportado el 2026-09-23 desde la pantalla de Matching.
//
// EL SINTOMA
// ----------
// El usuario de reloj 105 fichaba (240 veces en total, 41 en el ultimo mes) y
// existia el empleado con legajo 105, "Aguilar Grabriel". Los numeros
// coincidian. Y sin embargo Matching nunca lo proponia para vincular, y
// asociarlo a mano no quedaba.
//
// LA CAUSA
// --------
// Ese empleado se habia creado con tenant_id NULL, porque el superadmin lo dio
// de alta sin elegir empresa y el endpoint lo aceptaba. El JOIN de Matching
// exige `u.tenant_id = e.tenant_id`, y en SQL `6 = NULL` no da falso: da NULL.
// O sea que un empleado sin empresa no empareja con NINGUN usuario de reloj,
// nunca, y no hay nada en la pantalla que lo explique.
//
// Y ADEMAS
// --------
// El tope de empleados del plan se controla `if (effectiveTenantId != null)`,
// asi que un alta sin empresa tambien se salteaba el limite contratado.
//
// Por eso ahora el alta exige empresa. Estos tests cuidan las dos mitades: que
// no se pueda crear sin empresa, y que crear CON empresa siga andando igual.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_ID = 999933;
const UID_SUPER = 'test-empleado-exige-empresa-super';
const UID_ADMIN = 'test-empleado-exige-empresa-admin';
const LEGAJO = '9990105';

let headersSuper;
let headersAdmin;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Exige Empresa (test)', 'tenant-exige-empresa-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_ID]);
  headersSuper = await getTestAuthHeaders(UID_SUPER, { isSuperadmin: true });
  headersAdmin = await getTestAuthHeaders(UID_ADMIN, {
    isSuperadmin: false, tenantId: TENANT_ID, permissions: ['employees:create', 'employees:read'],
  });
});

after(async () => {
  await db.query('DELETE FROM employees WHERE employee_id = ?', [LEGAJO]);
  await deleteTestUser(UID_SUPER);
  await deleteTestUser(UID_ADMIN);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]);
  await db.end().catch(() => {});
  await closeDb();
});

// El alta responde 200 (no 201): es el contrato que ya tenia el endpoint y
// no se cambia por esto -- el frontend lo espera asi.
const OK = 200;

// Cada test arranca sin la fila del anterior: si no, el segundo choca con el
// control de legajo duplicado y falla por un motivo que no es el que prueba.
const limpiar = () => db.query('DELETE FROM employees WHERE employee_id = ?', [LEGAJO]);

const alta = (headers, body) =>
  fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('el superadmin NO puede crear un empleado sin elegir empresa', async () => {
  await limpiar();
  const res = await alta(headersSuper, { employee_id: LEGAJO, nombre: 'Sin Empresa' });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  // El mensaje tiene que explicar la CONSECUENCIA, no solo decir "falta un
  // campo": el sintoma que se vio en la vida real fue "lo cargué y no aparece
  // en Matching", y nadie relaciona eso con un campo vacío.
  assert.match(error, /empresa/i);
  assert.match(error, /informes|vincular|reloj/i, 'tiene que decir qué se rompe si falta');

  const [filas] = await db.query('SELECT id FROM employees WHERE employee_id = ?', [LEGAJO]);
  assert.equal(filas.length, 0, 'no se tiene que haber creado nada');
});

test('el superadmin SI puede crear indicando la empresa', async () => {
  await limpiar();
  const res = await alta(headersSuper, {
    employee_id: LEGAJO, nombre: 'Con Empresa', tenant_id: TENANT_ID,
  });
  assert.equal(res.status, OK);

  const [[fila]] = await db.query(
    'SELECT tenant_id FROM employees WHERE employee_id = ?', [LEGAJO]);
  assert.equal(fila.tenant_id, TENANT_ID);
});

test('un admin de empresa sigue sin tener que indicarla: sale de su usuario', async () => {
  await limpiar();
  const res = await alta(headersAdmin, { employee_id: LEGAJO, nombre: 'De Su Empresa' });
  assert.equal(res.status, OK, 'el caso normal no se tiene que haber roto');

  const [[fila]] = await db.query(
    'SELECT tenant_id FROM employees WHERE employee_id = ?', [LEGAJO]);
  assert.equal(fila.tenant_id, TENANT_ID, 'la empresa sale del usuario logueado, no del body');
});

test('un admin de empresa no puede crear para OTRA empresa aunque lo mande en el body', async () => {
  await limpiar();
  const res = await alta(headersAdmin, {
    employee_id: LEGAJO, nombre: 'Intento Cruzado', tenant_id: 999999,
  });
  assert.equal(res.status, OK);
  const [[fila]] = await db.query(
    'SELECT tenant_id FROM employees WHERE employee_id = ?', [LEGAJO]);
  assert.equal(fila.tenant_id, TENANT_ID, 'el tenant_id del body se ignora para un usuario normal');
});
