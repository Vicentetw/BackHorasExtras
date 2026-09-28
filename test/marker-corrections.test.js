// /marker-corrections: corregir a mano de quien era un marcador, con auditoria.
// Ver migrations/20261003_marker_corrections.sql y "Correcciones manuales" en
// movementsCalculations.js. Los casos finos del motor estan en
// marcadores-corregidos.test.js; aca se prueba el camino completo: la
// pantalla pide la correccion, queda el rastro, y el reporte de Salidas
// cambia.
//
// EL DIA DE PRUEBA (2099-04-01, reloj unico)
//   07:00:00  W entra            07:00:05  X entra
//   10:00:00  marcador 6 (salida particular)
//   10:00:02  W ficha            <- el sistema le da la salida a W
//   10:00:08  X ficha            <- pero el marcador era de X
//   12:00:00  W ficha            12:30:00  X ficha (regreso)
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999931/999932), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999931;
const TENANT_B = 999932;
const UID_A = 'test-marker-corrections-a';
const UID_B = 'test-marker-corrections-b';
const DIA = '2099-04-01';

const LEGAJO_W = 900781;
const LEGAJO_X = 900782;
const USERID_W = 8890081;
const USERID_X = 8890082;
const USERID_MARCADOR = 8890083;
const MARCADOR_AT = `${DIA} 10:00:00`;

let headersA;
let headersB;
let appUserAId;

async function cleanup() {
  await db.query('DELETE FROM marker_correction_log WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM marker_corrections WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  for (const tabla of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${tabla} WHERE tenant_id IN (?, ?)`, [TENANT_A, TENANT_B]);
  }
}

async function salidas() {
  const res = await fetch(`${BASE_URL}/movements-range?from=${DIA}&to=${DIA}&category=PARTICULAR&groupBy=day`, { headers: headersA });
  assert.equal(res.status, 200);
  return (await res.json()).rows;
}

function corregir(headers, body) {
  return fetch(`${BASE_URL}/marker-corrections`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_A, 'Tenant Marker Corrections A (test)', 'tenant-marker-corrections-a-test'],
    [TENANT_B, 'Tenant Marker Corrections B (test)', 'tenant-marker-corrections-b-test'],
  ]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, name, code]);
  }
  const permisos = ['attendance:read', 'attendance:update'];
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A, permissions: permisos });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B, permissions: permisos });
  const [[appUserA]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_A]);
  appUserAId = appUserA.id;

  await cleanup();

  for (const [legajo, userId, nombre] of [[LEGAJO_W, USERID_W, 'W Se Lo Llevo'], [LEGAJO_X, USERID_X, 'X Era Suyo']]) {
    const [emp] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)`,
      [legajo, nombre, TENANT_A]
    );
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, TENANT_A, String(legajo), nombre]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [userId, TENANT_A, emp.insertId]);
  }
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '6', 'Marcador Salida')`, [USERID_MARCADOR, TENANT_A]);
  await db.query(
    `INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, '6', 'Marcador Salida', 'PARTICULAR', 'SALIDA', 1)`,
    [USERID_MARCADOR, TENANT_A]
  );

  const fichajes = [
    [USERID_W, '07:00:00'], [USERID_X, '07:00:05'],
    [USERID_MARCADOR, '10:00:00'], [USERID_W, '10:00:02'], [USERID_X, '10:00:08'],
    [USERID_W, '12:00:00'], [USERID_X, '12:30:00'],
  ];
  for (const [userId, hora] of fichajes) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, TENANT_A, `${DIA} ${hora}`]);
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('antes de corregir: la salida se la lleva W, y la fila trae el marcador exacto para poder corregirlo', async () => {
  const rows = await salidas();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].employeeId), String(LEGAJO_W));
  assert.equal(rows[0].salidaMarkerUserId, USERID_MARCADOR);
  assert.equal(rows[0].salidaMarkerAt, MARCADOR_AT);
  assert.equal(rows[0].salidaCorreccion, null);
});

test('no se puede asignar el marcador a alguien que no ficho despues de apretarlo', async () => {
  // Un empleado sin fichajes ese dia.
  await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (900789, 'Sin Fichajes', ?, 1)`, [TENANT_A]);
  const res = await corregir(headersA, {
    markerUserId: USERID_MARCADOR, markerAt: MARCADOR_AT, fromEmployeeId: LEGAJO_W, toEmployeeId: 900789, reason: 'prueba',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no fichó/);
});

test('el motivo es obligatorio', async () => {
  const res = await corregir(headersA, {
    markerUserId: USERID_MARCADOR, markerAt: MARCADOR_AT, fromEmployeeId: LEGAJO_W, toEmployeeId: LEGAJO_X, reason: '  ',
  });
  assert.equal(res.status, 400);
});

test('otra empresa no puede corregir un marcador ajeno', async () => {
  const res = await corregir(headersB, {
    markerUserId: USERID_MARCADOR, markerAt: MARCADOR_AT, toEmployeeId: null, reason: 'intento cruzado',
  });
  assert.equal(res.status, 400);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM marker_corrections WHERE marker_user_id = ?', [USERID_MARCADOR]);
  assert.equal(n, 0);
});

let correctionId;

test('"era de X": la salida pasa a X, y queda quien lo corrigio, cuando y por que', async () => {
  const res = await corregir(headersA, {
    markerUserId: USERID_MARCADOR, markerAt: MARCADOR_AT, fromEmployeeId: LEGAJO_W, toEmployeeId: LEGAJO_X,
    reason: 'W se metio en el medio; lo confirmo el encargado',
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  correctionId = json.id;

  const rows = await salidas();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].employeeId), String(LEGAJO_X));
  assert.equal(rows[0].timeIn.slice(11, 16), '12:30');
  assert.equal(rows[0].salidaCorreccion.id, correctionId);
  assert.match(rows[0].salidaCorreccion.reason, /encargado/);
  assert.ok(rows[0].salidaCorreccion.correctedBy, 'se muestra quien corrigio');

  const [[fila]] = await db.query('SELECT * FROM marker_corrections WHERE id = ?', [correctionId]);
  assert.equal(fila.created_by, appUserAId);
  assert.equal(fila.previous_employee_id, LEGAJO_W, 'queda a quien se lo habia dado el sistema');

  const [log] = await db.query('SELECT * FROM marker_correction_log WHERE correction_id = ?', [correctionId]);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'created');
  assert.equal(log[0].performed_by, appUserAId);
});

test('cambiar la correccion a "no era de nadie": la salida desaparece y el log guarda como estaba', async () => {
  const res = await corregir(headersA, {
    markerUserId: USERID_MARCADOR, markerAt: MARCADOR_AT, fromEmployeeId: LEGAJO_X, toEmployeeId: null,
    reason: 'en realidad nadie salio',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, correctionId, 'es la misma correccion, actualizada');

  assert.equal((await salidas()).length, 0);

  const [[fila]] = await db.query('SELECT * FROM marker_corrections WHERE id = ?', [correctionId]);
  assert.equal(fila.assigned_employee_id, null);
  assert.equal(fila.previous_employee_id, LEGAJO_W, 'sigue siendo a quien se lo dio el sistema al principio');
  assert.equal(fila.updated_by, appUserAId);

  const [[log]] = await db.query(`SELECT * FROM marker_correction_log WHERE correction_id = ? AND action = 'updated'`, [correctionId]);
  const antes = typeof log.previous_data === 'string' ? JSON.parse(log.previous_data) : log.previous_data;
  assert.equal(antes.assigned_employee_id, LEGAJO_X);
});

test('la lista de correcciones del periodo la ve solo la empresa duena', async () => {
  const resA = await fetch(`${BASE_URL}/marker-corrections?from=${DIA}&to=${DIA}`, { headers: headersA });
  const { rows } = await resA.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].markerBadge, '6');
  assert.equal(rows[0].previousEmployeeName, 'W Se Lo Llevo');

  const resB = await fetch(`${BASE_URL}/marker-corrections?from=${DIA}&to=${DIA}`, { headers: headersB });
  assert.equal((await resB.json()).rows.length, 0);
});

test('otra empresa no puede deshacer la correccion adivinando el id', async () => {
  const res = await fetch(`${BASE_URL}/marker-corrections/${correctionId}`, { method: 'DELETE', headers: headersB });
  assert.equal(res.status, 404);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM marker_corrections WHERE id = ?', [correctionId]);
  assert.equal(n, 1);
});

test('deshacer: vuelve la atribucion automatica, y el historial completo sobrevive', async () => {
  const res = await fetch(`${BASE_URL}/marker-corrections/${correctionId}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 200);

  const rows = await salidas();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].employeeId), String(LEGAJO_W));

  const [log] = await db.query('SELECT action FROM marker_correction_log WHERE correction_id = ? ORDER BY id', [correctionId]);
  assert.deepEqual(log.map(l => l.action), ['created', 'updated', 'deleted']);
});
