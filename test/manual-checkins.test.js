// Pedido real: "no le tomó la huella", corte de luz, reloj descompuesto --
// fichaje manual insertado directo en Checkins (mismo lugar que los 3
// motores de asistencia ya leen), con auditoria completa (quien, cuando,
// por que) en manual_checkin_log. Apagado por defecto por tenant
// (manualCheckinsEnabled) -- requiere habilitarlo a proposito.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-manual-checkins';
const TENANT_A = 999960;
const TENANT_B = 999961; // aislamiento

let headers, db;
let empId, badge, userId; // empleado con usuario de reloj vinculado
let empSinUserId, badgeSinUser; // empleado SIN usuario vinculado

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306
  });

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Fichaje Manual A (test)', 'tenant-fichaje-manual-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Fichaje Manual B (test)', 'tenant-fichaje-manual-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );

  badge = 999960001;
  userId = 999960001;
  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Fichaje Manual Test', ?, '2020-01-01', 0)`,
    [badge, TENANT_A]
  );
  empId = empResult.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Fichaje Manual Test')`,
    [userId, TENANT_A, String(badge)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT_A, empId]);

  badgeSinUser = 999960002;
  const [empResult2] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Sin Usuario Vinculado Test', ?, '2020-01-01', 0)`,
    [badgeSinUser, TENANT_A]
  );
  empSinUserId = empResult2.insertId;
});

after(async () => {
  await db.query('DELETE FROM manual_checkin_log WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM Checkins WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM users WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]).catch(() => {});
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await deleteTestUser(TEST_UID);
  await db.end();
  await closeDb();
});

test('POST /api/manual-checkins: 403 si la empresa no habilitó el fichaje manual (apagado por defecto)', async () => {
  const res = await fetch(`${BASE_URL}/api/manual-checkins?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ employeeId: badge, checktime: '2026-05-04 07:00:00', motivoCategoria: 'corte_luz' }] })
  });
  assert.equal(res.status, 403);
});

test('POST /config/manual-checkins-enabled: habilita el feature para la empresa', async () => {
  const res = await fetch(`${BASE_URL}/config/manual-checkins-enabled?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manualCheckinsEnabled: true })
  });
  assert.equal(res.status, 200);
  const getRes = await fetch(`${BASE_URL}/config/manual-checkins-enabled?tenantId=${TENANT_A}`, { headers });
  const json = await getRes.json();
  assert.equal(json.manualCheckinsEnabled, true);
});

let createdId;

test('POST /api/manual-checkins: crea el fichaje con motivo/auditoria y aparece en el listado', async () => {
  const res = await fetch(`${BASE_URL}/api/manual-checkins?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [{ employeeId: badge, checktime: '2026-05-04 07:00:00', motivoCategoria: 'corte_luz', motivoDetalle: 'Corte en la zona, aviso de la distribuidora' }]
    })
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.created.length, 1);
  assert.equal(json.unresolved.length, 0);
  createdId = json.created[0].id;

  const [rows] = await db.query('SELECT * FROM Checkins WHERE id = ?', [createdId]);
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].motivo_categoria, 'corte_luz');
  assert.equal(rows[0].USERID, userId);
  assert.ok(rows[0].created_by, 'debe registrar quien lo cargo');

  const [logRows] = await db.query(`SELECT * FROM manual_checkin_log WHERE tenant_id = ? AND action = 'created' ORDER BY id DESC LIMIT 1`, [TENANT_A]);
  assert.equal(logRows[0].employee_id, badge);
  assert.equal(logRows[0].motivo_categoria, 'corte_luz');

  const listRes = await fetch(`${BASE_URL}/api/manual-checkins?tenantId=${TENANT_A}`, { headers });
  const list = await listRes.json();
  assert.ok(list.some((r) => r.id === createdId));
});

test('POST /api/manual-checkins: un empleado sin usuario de reloj vinculado queda "unresolved", no rompe el resto del lote', async () => {
  const res = await fetch(`${BASE_URL}/api/manual-checkins?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [
        { employeeId: badge, checktime: '2026-05-05 07:00:00', motivoCategoria: 'reloj_descompuesto' },
        { employeeId: badgeSinUser, checktime: '2026-05-05 07:00:00', motivoCategoria: 'reloj_descompuesto' }
      ]
    })
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.created.length, 1);
  assert.equal(json.unresolved.length, 1);
  assert.equal(json.unresolved[0].employeeId, badgeSinUser);
});

test('/attendance-range: una llegada tarde falsa (reloj no la tomó) se corrige con un fichaje manual de entrada', async () => {
  // Sin fichaje manual: solo hay un checkin real tardio ese dia -- llega "tarde".
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, '2026-05-06 09:00:00')`, [userId, TENANT_A]);

  const before = await fetch(`${BASE_URL}/attendance-range?from=2026-05-06&to=2026-05-06&tenantId=${TENANT_A}`, { headers });
  const beforeJson = await before.json();
  const beforeRow = beforeJson.data.find((e) => String(e.employeeId) === String(badge));
  assert.ok(beforeRow, 'el empleado debe aparecer en el reporte');
  assert.ok(beforeRow.late > 0, 'sin el fichaje manual, debe marcar llegada tarde');

  // Se carga el fichaje manual de la entrada real (07:00) que el reloj no tomó.
  const postRes = await fetch(`${BASE_URL}/api/manual-checkins?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [{ employeeId: badge, checktime: '2026-05-06 07:00:00', motivoCategoria: 'no_tomo_huella', motivoDetalle: 'No tomó la huella a la entrada' }]
    })
  });
  assert.equal(postRes.status, 200);

  const after = await fetch(`${BASE_URL}/attendance-range?from=2026-05-06&to=2026-05-06&tenantId=${TENANT_A}`, { headers });
  const afterJson = await after.json();
  const afterRow = afterJson.data.find((e) => String(e.employeeId) === String(badge));
  assert.equal(afterRow.late, 0, 'con el fichaje manual de entrada, ya no debe marcar llegada tarde');
});

test('DELETE /api/manual-checkins/:id: borra el fichaje y deja registro en manual_checkin_log', async () => {
  const res = await fetch(`${BASE_URL}/api/manual-checkins/${createdId}?tenantId=${TENANT_A}`, { method: 'DELETE', headers });
  assert.equal(res.status, 200);

  const [rows] = await db.query('SELECT * FROM Checkins WHERE id = ?', [createdId]);
  assert.equal(rows.length, 0, 'el fichaje debe borrarse de verdad, no soft-delete');

  const [logRows] = await db.query(`SELECT * FROM manual_checkin_log WHERE tenant_id = ? AND action = 'deleted' ORDER BY id DESC LIMIT 1`, [TENANT_A]);
  assert.equal(logRows[0].employee_id, badge);
});

test('DELETE /api/manual-checkins/:id: no puede borrar un fichaje REAL de reloj (solo source=manual)', async () => {
  const [result] = await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, '2026-05-07 07:00:00')`, [userId, TENANT_A]);
  const res = await fetch(`${BASE_URL}/api/manual-checkins/${result.insertId}?tenantId=${TENANT_A}`, { method: 'DELETE', headers });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT * FROM Checkins WHERE id = ?', [result.insertId]);
  assert.equal(rows.length, 1, 'el fichaje real no debe borrarse');
});

test('aislamiento por tenant: la empresa B no ve ni puede borrar un fichaje manual de la empresa A', async () => {
  const listRes = await fetch(`${BASE_URL}/api/manual-checkins?tenantId=${TENANT_B}`, { headers });
  const list = await listRes.json();
  assert.equal(list.length, 0);

  const [result] = await db.query(
    `INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, source) VALUES (?, ?, '2026-05-08 07:00:00', 'manual')`,
    [userId, TENANT_A]
  );
  const delRes = await fetch(`${BASE_URL}/api/manual-checkins/${result.insertId}?tenantId=${TENANT_B}`, { method: 'DELETE', headers });
  assert.equal(delRes.status, 404, 'la empresa B no debe poder borrar un fichaje de la empresa A');
});
