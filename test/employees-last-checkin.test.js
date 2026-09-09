// Pedido real: mostrar en /empleados cuántos días hace que cada empleado
// no ficha. GET /api/employees ahora expone last_checkin por fila, y el
// filtro ?inactiveDays=N (ya existía) se reescribió para usar el mismo
// cálculo -- antes hacía una subquery CORRELACIONADA con un JOIN sin
// índice utilizable (CAST(a)=CAST(b) en ambos lados), 8+ segundos con los
// ~480 empleados reales. Este test cubre que el resultado siga siendo
// exactamente el mismo tras la reescritura (no solo más rápido).
//
// Tenant descartable propio (999997), NUNCA AVP (id 4). USERIDs de reloj
// descartables propios (8890001+), fuera de cualquier rango real.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999997;
const UID = 'test-employees-last-checkin';
const USERID_RECENT = 8890001;
const USERID_OLD = 8890002;

let headers;
let empRecentId, empOldId, empNeverId;

async function cleanup() {
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [USERID_RECENT, USERID_OLD]);
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?)', [USERID_RECENT, USERID_OLD]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [USERID_RECENT, USERID_OLD]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Last Checkin (test)', 'tenant-last-checkin-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT]
  );
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: TENANT, permissions: ['employees:create', 'employees:read'] });

  await cleanup();

  const mkEmployee = async (n) => {
    const res = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: 900400 + n, nombre: `Last Checkin Test ${n}` }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    return json.id;
  };
  empRecentId = await mkEmployee(1);
  empOldId = await mkEmployee(2);
  empNeverId = await mkEmployee(3); // nunca fichó -- sin fila en users/Checkins/user_employee_map

  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_RECENT, TENANT, String(USERID_RECENT), 'Recent Fichaje']);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_OLD, TENANT, String(USERID_OLD), 'Old Fichaje']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_RECENT, TENANT, empRecentId, 'manual']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_OLD, TENANT, empOldId, 'manual']);

  // Recent: fichó hace 5 días -- NO debe aparecer en inactiveDays=30.
  await db.query(
    'INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 5 DAY), NULL, NULL)',
    [USERID_RECENT, TENANT]
  );
  // Old: último fichaje hace 200 días -- SI debe aparecer en inactiveDays=30.
  await db.query(
    'INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 200 DAY), NULL, NULL)',
    [USERID_OLD, TENANT]
  );
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]);
  await closeDb();
});

test('GET /api/employees expone last_checkin -- null para quien nunca fichó', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0`, { headers });
  const json = await res.json();
  assert.equal(res.status, 200);

  const recent = json.data.find((e) => e.id === empRecentId);
  const old = json.data.find((e) => e.id === empOldId);
  const never = json.data.find((e) => e.id === empNeverId);

  assert.ok(recent.last_checkin, 'debe tener last_checkin');
  assert.ok(old.last_checkin, 'debe tener last_checkin');
  assert.equal(never.last_checkin, null, 'sin ningun fichaje, last_checkin debe ser null');

  const diasRecent = (Date.now() - new Date(recent.last_checkin.replace(' ', 'T') + 'Z').getTime()) / 86400000;
  assert.ok(diasRecent < 6, `esperaba ~5 días, dio ${diasRecent}`);
});

test('GET /api/employees?inactiveDays=30 incluye a quien no fichó en 30 días (o nunca), excluye a quien fichó hace 5', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0&inactiveDays=30`, { headers });
  const json = await res.json();
  assert.equal(res.status, 200);

  const ids = json.data.map((e) => e.id);
  assert.ok(!ids.includes(empRecentId), 'fichó hace 5 días -- NO debe aparecer como inactivo a 30 días');
  assert.ok(ids.includes(empOldId), 'último fichaje hace 200 días -- SI debe aparecer');
  assert.ok(ids.includes(empNeverId), 'nunca fichó -- SI debe aparecer');
});

test('GET /api/employees?inactiveDays=300 ya no incluye al que dejó de fichar hace 200 días', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0&inactiveDays=300`, { headers });
  const json = await res.json();
  const ids = json.data.map((e) => e.id);
  assert.ok(!ids.includes(empOldId), 'fichó hace 200 días -- con una ventana de 300 no debe contar como inactivo');
  assert.ok(ids.includes(empNeverId), 'nunca fichó -- sigue apareciendo con cualquier ventana');
});
