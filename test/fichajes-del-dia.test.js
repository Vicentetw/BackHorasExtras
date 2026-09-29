// GET /api/fichajes-del-dia: que es cada fichaje, por la API y con la base.
// Los casos finos estan en tipos-de-fichaje.test.js (funcion pura).
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999991/999992), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999991;
const OTRA = 999992;
const UID = 'test-fichajes-del-dia';
const UID_OTRA = 'test-fichajes-del-dia-otra';
const DIA = '2099-05-04';
const LEGAJO = 900831;
const USERID = 8890131;
const MARCADORES = [[8890132, '6', 'PARTICULAR', 'SALIDA'], [8890133, '5', 'PARTICULAR', 'REGRESO'], [8890134, '9', 'HE', 'SALIDA'], [8890135, '10', 'HE', 'REGRESO']];

let headers;
let headersOtra;

async function cleanup() {
  for (const t of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [TENANT]);
  }
}

before(async () => {
  for (const [id, code] of [[TENANT, 'tenant-fichajes-dia-test'], [OTRA, 'tenant-fichajes-dia-otra-test']]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, `${code} (test)`, code]);
  }
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: TENANT, permissions: ['attendance:read'] });
  headersOtra = await getTestAuthHeaders(UID_OTRA, { isSuperadmin: false, tenantId: OTRA, permissions: ['attendance:read'] });
  await cleanup();

  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, 'Siete Fichajes', ?, 1)`, [LEGAJO, TENANT]);
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Siete Fichajes')`, [USERID, TENANT, String(LEGAJO)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [USERID, TENANT, emp.insertId]);
  for (const [userId, badge, cat, dir] of MARCADORES) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')`, [userId, TENANT, badge]);
    await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', ?, ?, 1)`,
      [userId, TENANT, badge, cat, dir]);
  }
  const filas = [
    [USERID, '06:56:00'],
    [8890132, '09:39:58'], [USERID, '09:40:00'],
    [8890133, '10:14:58'], [USERID, '10:15:00'],
    [USERID, '13:38:00'],
    [8890134, '14:01:58'], [USERID, '14:02:00'],
    [8890135, '17:29:58'], [USERID, '17:30:00'],
    [USERID, '17:30:10'],
  ];
  for (const [userId, hora] of filas) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, TENANT, `${DIA} ${hora}`]);
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await deleteTestUser(UID_OTRA);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT, OTRA]);
  await closeDb();
});

test('los 7 fichajes del dia con su tipo y el marcador que lo genero', async () => {
  const res = await fetch(`${BASE_URL}/api/fichajes-del-dia?fecha=${DIA}`, { headers });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  const f = json.empleados[String(LEGAJO)];
  assert.deepEqual(f.map((x) => [x.hora, x.base, x.tipos.map((t) => t.texto)]), [
    ['06:56', 'Entrada', []],
    ['09:40', 'Intermedio', ['Salida particular']],
    ['10:15', 'Intermedio', ['Regreso particular']],
    ['13:38', 'Intermedio', []],
    ['14:02', 'Intermedio', ['Inicio de horas extra']],
    ['17:30', 'Intermedio', ['Fin de horas extra']],
    ['17:30', 'Repetido', []],
  ]);
  assert.equal(f[1].tipos[0].marcador.badge, '6');
  assert.equal(f[1].tipos[0].marcador.at, `${DIA} 09:39:58`, 'la hora exacta del marcador, para poder corregirlo');
});

test('se puede pedir un solo empleado', async () => {
  const json = await (await fetch(`${BASE_URL}/api/fichajes-del-dia?fecha=${DIA}&employeeId=${LEGAJO}`, { headers })).json();
  assert.deepEqual(Object.keys(json.empleados), [String(LEGAJO)]);
});

test('otra empresa no ve nada de esta', async () => {
  const json = await (await fetch(`${BASE_URL}/api/fichajes-del-dia?fecha=${DIA}`, { headers: headersOtra })).json();
  assert.deepEqual(json.empleados, {});
});

test('la fecha es obligatoria', async () => {
  assert.equal((await fetch(`${BASE_URL}/api/fichajes-del-dia`, { headers })).status, 400);
});
