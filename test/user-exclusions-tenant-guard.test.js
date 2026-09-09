// Bug real de seguridad encontrado en una auditoria general (no un reporte
// de un usuario): NINGUNO de los endpoints de /config/user-exclusions* y
// /config/*-exclusion-permanent chequeaba que el USERID/exclusion
// perteneciera a un empleado del tenant de quien llama -- un usuario con
// permiso 'exclusions:*' de CUALQUIER empresa podia crear/editar/borrar
// una justificacion (o alternar la exclusion permanente) de un empleado de
// OTRA empresa, con solo conocer/adivinar su USERID de reloj (secuencial).
// Esto alimenta DIRECTO resolveLateJustification -- no es solo lectura.
// Ver horasdedica2.js (userBelongsToCallerTenant/exclusionBelongsToCallerTenant).
//
// Tenants descartables propios (999970/999971), NUNCA AVP (id 4). USERIDs
// de reloj descartables propios (8890030+), fuera de cualquier rango real.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999970;
const TENANT_B = 999971;
const UID_A = 'test-user-exclusions-tenant-guard-a';
const USERID_A = 8890030; // vinculado a un empleado de TENANT_A
const USERID_B = 8890031; // vinculado a un empleado de TENANT_B

let headersA;
let empAId, empBId;
let existingExclusionBId; // exclusion YA cargada para el empleado de TENANT_B, para probar PUT/DELETE por id

async function cleanup() {
  await db.query('DELETE FROM userexclusions WHERE userId IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Exclusions Guard A (test)', 'tenant-exclusions-guard-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Exclusions Guard B (test)', 'tenant-exclusions-guard-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  headersA = await getTestAuthHeaders(UID_A, {
    isSuperadmin: false,
    tenantId: TENANT_A,
    permissions: ['exclusions:read', 'exclusions:create', 'exclusions:update', 'exclusions:delete'],
  });

  await cleanup();

  const [empAResult] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [900700, 'Empleado Exclusion Guard A', TENANT_A]);
  empAId = empAResult.insertId;
  const [empBResult] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [900701, 'Empleado Exclusion Guard B', TENANT_B]);
  empBId = empBResult.insertId;

  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_A, TENANT_A, '900700', 'Empleado Exclusion Guard A']);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_B, TENANT_B, '900701', 'Empleado Exclusion Guard B']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_A, TENANT_A, empAId, 'manual']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_B, TENANT_B, empBId, 'manual']);

  const [excResult] = await db.query(
    `INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, 'FULL_DAY')`,
    [USERID_B, TENANT_B, '2099-02-01', 'Exclusion de otra empresa (test)']
  );
  existingExclusionBId = excResult.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('POST /config/user-exclusions sobre un USERID de OTRA empresa -> 404, no crea nada', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_B, excDate: '2099-02-02', reason: 'intento cross-tenant' }),
  });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_B, '2099-02-02']);
  assert.equal(rows.length, 0);
});

test('POST /config/user-exclusions/range sobre un USERID de OTRA empresa -> 404, no crea nada', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions/range`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_B, dateFrom: '2099-02-03', dateTo: '2099-02-04', reason: 'intento cross-tenant' }),
  });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate BETWEEN ? AND ?', [USERID_B, '2099-02-03', '2099-02-04']);
  assert.equal(rows.length, 0);
});

test('PUT /config/user-exclusions/:id sobre una exclusion de OTRA empresa -> 404, no la modifica', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions/${existingExclusionBId}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'pisado desde otra empresa' }),
  });
  assert.equal(res.status, 404);
  const [[row]] = await db.query('SELECT reason FROM userexclusions WHERE id = ?', [existingExclusionBId]);
  assert.equal(row.reason, 'Exclusion de otra empresa (test)', 'no debe haberse modificado');
});

test('DELETE /config/user-exclusions/:id sobre una exclusion de OTRA empresa -> 404, no la borra', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions/${existingExclusionBId}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT id FROM userexclusions WHERE id = ?', [existingExclusionBId]);
  assert.equal(rows.length, 1, 'la exclusion de la otra empresa debe seguir existiendo');
});

test('POST /config/toggle-user-exclusion sobre un USERID de OTRA empresa -> 404, no crea nada', async () => {
  const res = await fetch(`${BASE_URL}/config/toggle-user-exclusion`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_B, excDate: '2099-02-05', exclude: true }),
  });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_B, '2099-02-05']);
  assert.equal(rows.length, 0);
});

test('PUT /config/toggle-user-exclusion-permanent/:userId de OTRA empresa -> 404, no lo toca', async () => {
  const res = await fetch(`${BASE_URL}/config/toggle-user-exclusion-permanent/${USERID_B}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ exclude: true }),
  });
  assert.equal(res.status, 404);
  const [[row]] = await db.query('SELECT isExcluded FROM users WHERE USERID = ?', [USERID_B]);
  assert.equal(Number(row.isExcluded), 0, 'no debe haberse marcado excluido');
});

test('DELETE /config/user-exclusion/:userId de OTRA empresa -> 404, no lo toca', async () => {
  await db.query('UPDATE users SET isExcluded = 1 WHERE USERID = ?', [USERID_B]);
  const res = await fetch(`${BASE_URL}/config/user-exclusion/${USERID_B}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 404);
  const [[row]] = await db.query('SELECT isExcluded FROM users WHERE USERID = ?', [USERID_B]);
  assert.equal(Number(row.isExcluded), 1, 'debe seguir excluido -- no se le debe haber sacado la marca desde otra empresa');
});

test('GET /config/excluded-users: no expone el nombre del empleado de OTRA empresa', async () => {
  const res = await fetch(`${BASE_URL}/config/excluded-users?limit=1000`, { headers: headersA });
  const json = await res.json();
  const rowB = json.data.find((u) => u.USERID === USERID_B);
  assert.equal(rowB, undefined, 'el usuario vinculado a un empleado de OTRA empresa no debe aparecer');
});

test('operaciones sobre el PROPIO tenant siguen funcionando normalmente', async () => {
  const createRes = await fetch(`${BASE_URL}/config/user-exclusions`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_A, excDate: '2099-02-10', reason: 'propio, debe andar' }),
  });
  assert.equal(createRes.status, 200, JSON.stringify(await createRes.clone().json()));

  const [[row]] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_A, '2099-02-10']);
  assert.ok(row);

  const deleteRes = await fetch(`${BASE_URL}/config/user-exclusions/${row.id}`, { method: 'DELETE', headers: headersA });
  assert.equal(deleteRes.status, 200);
});
