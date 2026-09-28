// "Afectado a campaña / viajes": solo los empleados marcados pueden llevarse
// un marcador de campaña, si la empresa lo activa. Ver migracion 20261004 y
// `soloPuedenConsumir` en movementsCalculations.js (sus casos finos estan en
// marcadores-corregidos.test.js).
//
// EL DIA DE PRUEBA (reloj unico)
//   DIA 08:00:00  marcador 8 (salida a campaña)
//   DIA 08:00:02  W ficha   <- es de oficina, pero sin el ajuste se lleva la campaña
//   DIA 08:00:04  X ficha   <- el que de verdad sale al campo
//   DIA+4 18:00   marcador 7 + X ficha (regreso)
//
// Las fechas son recientes a proposito: la sugerencia de a quien marcar mira
// los ultimos 6 meses.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999941/999942), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999941;
const TENANT_B = 999942;
const UID_A = 'test-campana-afectados-a';
const UID_B = 'test-campana-afectados-b';

const LEGAJO_W = 900791;
const LEGAJO_X = 900792;
const USERID_W = 8890091;
const USERID_X = 8890092;
const USERID_SALE = 8890093;
const USERID_VUELVE = 8890094;

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoy = new Date();
const DIA = fmt(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 20));
const REGRESO = fmt(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 16));
const HASTA = fmt(hoy);

let headersA;
let headersB;
let idEmpleadoX;

async function cleanup() {
  for (const tabla of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees', 'app_settings']) {
    await db.query(`DELETE FROM ${tabla} WHERE tenant_id IN (?, ?)`, [TENANT_A, TENANT_B]).catch(() => {});
  }
}

const json = (headers, method, body) => ({
  method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function campanas() {
  const res = await fetch(`${BASE_URL}/campana-range?from=${DIA}&to=${HASTA}`, { headers: headersA });
  assert.equal(res.status, 200);
  return (await res.json()).rows;
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_A, 'Tenant Campana Afectados A (test)', 'tenant-campana-afectados-a-test'],
    [TENANT_B, 'Tenant Campana Afectados B (test)', 'tenant-campana-afectados-b-test'],
  ]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, name, code]);
  }
  const permisos = ['attendance:read', 'schedules:read', 'schedules:update', 'employees:read', 'employees:update'];
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A, permissions: permisos });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B, permissions: permisos });

  await cleanup();

  for (const [legajo, userId, nombre] of [[LEGAJO_W, USERID_W, 'W De Oficina'], [LEGAJO_X, USERID_X, 'X Del Campo']]) {
    const [emp] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)`,
      [legajo, nombre, TENANT_A]
    );
    if (legajo === LEGAJO_X) idEmpleadoX = emp.insertId;
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, TENANT_A, String(legajo), nombre]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [userId, TENANT_A, emp.insertId]);
  }
  // Un empleado de OTRA empresa con el mismo legajo que X: no se tiene que
  // marcar nunca desde la empresa A.
  await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, 'X de otra empresa', ?, 1)`, [LEGAJO_X, TENANT_B]);

  for (const [userId, badge, dir] of [[USERID_SALE, '8', 'SALIDA'], [USERID_VUELVE, '7', 'REGRESO']]) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')`, [userId, TENANT_A, badge]);
    await db.query(
      `INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', 'CAMPANA', ?, 1)`,
      [userId, TENANT_A, badge, dir]
    );
  }
  for (const [userId, cuando] of [
    [USERID_SALE, `${DIA} 08:00:00`], [USERID_W, `${DIA} 08:00:02`], [USERID_X, `${DIA} 08:00:04`],
    [USERID_VUELVE, `${REGRESO} 18:00:00`], [USERID_X, `${REGRESO} 18:00:03`],
  ]) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, TENANT_A, cuando]);
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('por default no cambia nada: la campaña se la lleva W, como siempre', async () => {
  const res = await fetch(`${BASE_URL}/config/campana-solo-afectados`, { headers: headersA });
  assert.deepEqual(await res.json(), { campanaSoloAfectados: false, afectados: 0 });
  const rows = await campanas();
  assert.deepEqual(rows.map(r => String(r.employeeId)), [String(LEGAJO_W)]);
});

test('no se puede activar con nadie marcado (desaparecerian todas las campañas)', async () => {
  const res = await fetch(`${BASE_URL}/config/campana-solo-afectados`, json(headersA, 'POST', { campanaSoloAfectados: true }));
  assert.equal(res.status, 400);
});

test('la sugerencia lista a quienes tuvieron campañas, aunque el ajuste este activo o no', async () => {
  const res = await fetch(`${BASE_URL}/campana/afectados-sugeridos`, { headers: headersA });
  const { rows } = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(rows.map(r => r.employeeId), [String(LEGAJO_W)],
    'hoy la unica campaña detectada es la de W (el error): justamente por eso conviene mirar la lista antes de marcar');
  assert.equal(rows[0].campanas, 1);
});

test('marcar en lote solo toca empleados de la propia empresa', async () => {
  const res = await fetch(`${BASE_URL}/campana/afectados`, json(headersA, 'POST', { legajos: [String(LEGAJO_X)], afectado: true }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).updated, 1);
  const [[otra]] = await db.query('SELECT afectado_campana FROM employees WHERE tenant_id = ? AND employee_id = ?', [TENANT_B, LEGAJO_X]);
  assert.equal(otra.afectado_campana, 0, 'el mismo legajo en otra empresa no se toca');
});

test('activado: W deja pasar el marcador y la campaña es de X, con su regreso', async () => {
  const res = await fetch(`${BASE_URL}/config/campana-solo-afectados`, json(headersA, 'POST', { campanaSoloAfectados: true }));
  assert.equal(res.status, 200);
  const rows = await campanas();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].employeeId), String(LEGAJO_X));
  assert.equal(rows[0].hasReturn, true);
  assert.equal(rows[0].timeIn.slice(0, 10), REGRESO);
});

test('el ajuste es por empresa: la otra sigue apagada', async () => {
  const res = await fetch(`${BASE_URL}/config/campana-solo-afectados`, { headers: headersB });
  assert.equal((await res.json()).campanaSoloAfectados, false);
});

test('editar el legajo desde un cliente que no conoce la tilde no la borra', async () => {
  const res = await fetch(`${BASE_URL}/api/employees/${idEmpleadoX}`,
    json(headersA, 'PUT', { employee_id: LEGAJO_X, nombre: 'X Del Campo (editado)' }));
  assert.equal(res.status, 200, await res.text());
  const [[x]] = await db.query('SELECT afectado_campana FROM employees WHERE id = ?', [idEmpleadoX]);
  assert.equal(x.afectado_campana, 1);
});

test('y desde el formulario se puede sacar', async () => {
  const res = await fetch(`${BASE_URL}/api/employees/${idEmpleadoX}`,
    json(headersA, 'PUT', { employee_id: LEGAJO_X, nombre: 'X Del Campo', afectado_campana: false }));
  assert.equal(res.status, 200);
  const [[x]] = await db.query('SELECT afectado_campana FROM employees WHERE id = ?', [idEmpleadoX]);
  assert.equal(x.afectado_campana, 0);
});
