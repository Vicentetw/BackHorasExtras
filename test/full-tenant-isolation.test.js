// Red de seguridad de aislamiento entre empresas (pedido explicito del
// usuario: "me da miedo que se mezclen datos entre empresas").
//
// Arma DOS empresas descartables con TODO igual a proposito -- mismo
// legajo, mismo USERID de reloj, mismo badge, mismas fechas de fichaje --
// y verifica que un usuario de la empresa A, en CADA pantalla que lee
// datos, ve SOLO lo suyo y NUNCA nada de la empresa B.
//
// Empresas descartables 999931/999932, USERIDs de reloj 8890050/8890051,
// NUNCA la empresa real (AVP). Borra todo al terminar.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TA = 999931, TB = 999932;
const UID = 'test-full-tenant-isolation-a';
const SHARED_LEGAJO = 900900;       // mismo legajo en las dos empresas
const USERID_A = 8890050, USERID_B = 8890051;
const SHARED_BADGE = '77';          // mismo badge en las dos
const DATE = '2026-05-04';          // lunes, laborable por defecto

let headersA;
let empAId, empBId;

async function cleanup() {
  for (const t of [TA, TB]) {
    await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_leave_balances WHERE employee_id IN (SELECT id FROM employees WHERE tenant_id = ?)', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM agent_sync_status WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM app_users WHERE tenant_id = ?', [t]);
  }
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TA, TB]);
}

async function seedTenant(tid, label, userId) {
  const [emp] = await db.query(
    'INSERT INTO employees (employee_id, nombre, documento, tenant_id, activo, fecha_alta) VALUES (?, ?, ?, ?, 1, ?)',
    [SHARED_LEGAJO, `AISLAMIENTO ${label}`, `DOC${label}`, tid, '2020-01-01']
  );
  const empId = emp[0] ? emp[0].insertId : emp.insertId;
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, tid, SHARED_BADGE, `RELOJ ${label}`]);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [userId, tid, empId, 'manual']);
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)',
    [userId, tid, `${DATE} 07:05:00`, userId, tid, `${DATE} 15:10:00`]);
  await db.query('INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, ?)',
    [userId, tid, DATE, `EXCL ${label}`, 'LLEGADA_TARDE']);
  await db.query('INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [userId, tid, SHARED_BADGE, `MARCADOR ${label}`, 'PARTICULAR', 'SALIDA']);
  return empId;
}

before(async () => {
  await cleanup();
  for (const [id, name] of [[TA, 'A'], [TB, 'B']]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?)`, [id, `Aislamiento ${name} (test)`, `aislamiento-${name.toLowerCase()}-test`]);
  }
  headersA = await getTestAuthHeaders(UID, {
    isSuperadmin: false, tenantId: TA,
    permissions: ['employees:read', 'attendance:read', 'matching:read', 'leaves:read', 'exclusions:read', 'settings:read'],
  });
  empAId = await seedTenant(TA, 'A', USERID_A);
  empBId = await seedTenant(TB, 'B', USERID_B);
});

after(async () => {
  await deleteTestUser(UID).catch(() => {});
  await cleanup();
  await closeDb();
});

// Helper: el texto de la respuesta NO debe contener ninguna marca de la
// empresa B, y SI debe contener la de A (cuando corresponde).
function assertNoLeak(bodyText, screen) {
  assert.ok(!/AISLAMIENTO B|RELOJ B|EXCL B|MARCADOR B|DOCB/.test(bodyText),
    `[${screen}] la respuesta filtro datos de la empresa B: ${bodyText.slice(0, 400)}`);
}

test('Empleados (GET /api/employees): la empresa A no ve al empleado de la B', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=500`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'empleados');
  assert.ok(/AISLAMIENTO A/.test(text), 'deberia ver a su propio empleado');
});

test('Presentismo / Horas Extra (GET /attendance-range): solo filas de la empresa A', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${DATE}&to=${DATE}&days=1`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'attendance-range');
  const json = JSON.parse(text);
  const badges = (json.data || []).map((r) => String(r.badge));
  assert.ok(badges.every((b) => b === SHARED_BADGE || b === String(SHARED_LEGAJO)) || (json.data || []).length <= 1,
    'attendance-range no debe traer mas de un empleado con ese badge/legajo compartido');
});

test('Motor diario (GET /api/labor-engine/attendance/:date): solo la empresa A', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${DATE}`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'motor-diario');
});

test('Matching (GET /api/matching/diagnosis/report): no ve usuarios/empleados de la B', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/diagnosis/report`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'matching');
});

test('Justificaciones (GET /config/user-exclusions): solo las de la empresa A', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions?limit=200`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'user-exclusions');
});

test('Bajas y Exclusiones (GET /config/excluded-users): no expone al de la B', async () => {
  const res = await fetch(`${BASE_URL}/config/excluded-users?limit=500`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'excluded-users');
});

test('Marcadores (GET /config/special-users): solo los de la empresa A', async () => {
  const res = await fetch(`${BASE_URL}/config/special-users`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'special-users');
});

test('Licencias / Vacaciones (GET /api/leave-balances): solo empleados de la empresa A', async () => {
  const res = await fetch(`${BASE_URL}/api/leave-balances?year=2026`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'leave-balances');
});

test('Salidas (GET /movements-range): no mezcla movimientos de la B', async () => {
  const res = await fetch(`${BASE_URL}/movements-range?from=${DATE}&to=${DATE}&category=PARTICULAR`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'movements-range');
});

test('Buscar empleado por legajo compartido (GET /api/employees?employee_id=): trae SOLO el de la empresa A', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?employee_id=${SHARED_LEGAJO}`, { headers: headersA });
  const text = await res.text();
  assert.equal(res.status, 200);
  assertNoLeak(text, 'buscar-por-legajo');
  const json = JSON.parse(text);
  const rows = json.data || json;
  assert.equal(rows.length, 1, 'un legajo compartido debe resolver a UN solo empleado (el de la empresa que pregunta)');
  assert.match(rows[0].nombre, /AISLAMIENTO A/);
});
