// Bug real de seguridad encontrado en una auditoria general (no un reporte
// de un usuario): casi ninguna ruta de /api/matching filtraba por tenant --
// un usuario normal (no superadmin) con permiso 'matching:*' de CUALQUIER
// empresa podia ver los matches, sugerencias y "would_match" de TODAS las
// empresas, y hasta BORRAR el match de un empleado de otra empresa con
// solo conocer/adivinar su USERID de reloj. Ver routes/matching.routes.js.
//
// Tenants descartables propios (999975/999976), NUNCA AVP (id 4). USERIDs
// de reloj descartables propios (8890020+), fuera de cualquier rango real.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999975;
const TENANT_B = 999976;
const UID_A = 'test-matching-tenant-guard-a';
const USERID_UNMATCHED_A = 8890020;
const USERID_UNMATCHED_B = 8890021;
const USERID_MATCHED_A = 8890022;
const USERID_MATCHED_B = 8890023;

let headersA;
let empAId, empBId, empAUnmatchedId, empBUnmatchedId;

async function cleanup() {
  const ids = [USERID_UNMATCHED_A, USERID_UNMATCHED_B, USERID_MATCHED_A, USERID_MATCHED_B];
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?)', [ids]);
  await db.query('DELETE FROM users WHERE USERID IN (?)', [ids]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Matching Guard A (test)', 'tenant-matching-guard-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Matching Guard B (test)', 'tenant-matching-guard-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A, permissions: ['matching:read', 'matching:delete'] });

  await cleanup();

  const [empAResult] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [900600, 'Empleado Guard A', TENANT_A]);
  empAId = empAResult.insertId;
  const [empBResult] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [900601, 'Empleado Guard B', TENANT_B]);
  empBId = empBResult.insertId;
  // Empleados aparte, SIN ningun USERID vinculado nunca (ni siquiera vía
  // otro USERID) -- empAId/empBId de arriba quedan matcheados mas abajo
  // (via USERID_MATCHED_*), asi que no sirven para probar /unmatched-employees.
  const [empAUnmatchedResult] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [900602, 'Empleado Guard A Sin Match', TENANT_A]);
  empAUnmatchedId = empAUnmatchedResult.insertId;
  const [empBUnmatchedResult] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [900603, 'Empleado Guard B Sin Match', TENANT_B]);
  empBUnmatchedId = empBUnmatchedResult.insertId;

  // Sin vincular todavia -- badge = legajo, para que /auto|/predict|/manual-bulk los prediga.
  await db.query('INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, ?)', [USERID_UNMATCHED_A, '900600', 'Empleado Guard A']);
  await db.query('INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, ?)', [USERID_UNMATCHED_B, '900601', 'Empleado Guard B']);

  // Ya vinculados -- para GET / y DELETE.
  await db.query('INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, ?)', [USERID_MATCHED_A, 'badgeA', 'Ya Vinculado A']);
  await db.query('INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, ?)', [USERID_MATCHED_B, 'badgeB', 'Ya Vinculado B']);
  await db.query('INSERT INTO user_employee_map (USERID, employee_id, match_type) VALUES (?, ?, ?)', [USERID_MATCHED_A, empAId, 'manual']);
  await db.query('INSERT INTO user_employee_map (USERID, employee_id, match_type) VALUES (?, ?, ?)', [USERID_MATCHED_B, empBId, 'manual']);
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('GET /api/matching: solo ve los matches de su propia empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/matching`, { headers: headersA });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.some((r) => r.USERID === USERID_MATCHED_A), 'debe ver su propio match');
  assert.ok(!rows.some((r) => r.USERID === USERID_MATCHED_B), 'NO debe ver el match de la otra empresa');
});

test('GET /api/matching/unmatched-employees: solo empleados sin match de su propia empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/unmatched-employees`, { headers: headersA });
  const rows = await res.json();
  assert.ok(rows.some((e) => e.id === empAUnmatchedId), 'debe ver su propio empleado sin match');
  assert.ok(!rows.some((e) => e.id === empBUnmatchedId), 'NO debe ver el empleado sin match de la otra empresa');
});

test('GET /api/matching/suggestions: no sugiere contra empleados de otra empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/suggestions`, { headers: headersA });
  const rows = await res.json();
  assert.ok(!rows.some((r) => r.employee_id === empBId), 'NO debe sugerir el empleado de la otra empresa');
});

for (const path of ['/api/matching/auto', '/api/matching/manual-bulk', '/api/matching/predict']) {
  test(`POST ${path}: predice solo contra empleados de su propia empresa`, async () => {
    const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: headersA });
    assert.equal(res.status, 200);
    const json = await res.json();
    const predictions = json.predictions || json.matches;
    assert.ok(predictions.some((p) => p.employee_id === empAId), 'debe predecir su propio empleado');
    assert.ok(!predictions.some((p) => p.employee_id === empBId), 'NO debe predecir el empleado de la otra empresa');
  });
}

test('GET /api/matching/diagnosis/report: el "reason" no delata un legajo coincidente de otra empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/diagnosis/report`, { headers: headersA });
  const json = await res.json();
  const rowB = json.data.unmatchedUsers.find((u) => u.USERID === USERID_UNMATCHED_B);
  assert.ok(rowB, 'el usuario crudo del reloj sigue siendo visible (lista global a proposito)');
  assert.equal(rowB.reason, 'No existe employee_id coincidente', 'no debe delatar que ese legajo coincide con un empleado de OTRA empresa');

  const rowA = json.data.unmatchedUsers.find((u) => u.USERID === USERID_UNMATCHED_A);
  assert.match(rowA.reason, /coincidente/, 'para su PROPIO empleado si debe detectar la coincidencia');
});

test('DELETE /api/matching/:user_id de un match de OTRA empresa -> 404, no borra nada', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/${USERID_MATCHED_B}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 404);

  const [rows] = await db.query('SELECT USERID FROM user_employee_map WHERE USERID = ?', [USERID_MATCHED_B]);
  assert.equal(rows.length, 1, 'el match de la otra empresa debe seguir existiendo, sin tocar');
});

test('DELETE /api/matching/:user_id de un match PROPIO -> funciona normal', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/${USERID_MATCHED_A}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 200);

  const [rows] = await db.query('SELECT USERID FROM user_employee_map WHERE USERID = ?', [USERID_MATCHED_A]);
  assert.equal(rows.length, 0, 'el propio match SI debe poder borrarse');
});
