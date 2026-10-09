// Fase 4.6: POST /config/user-exclusions/range reemplaza el patron del
// dashboard.html original (un POST por dia, en un loop del cliente, sin
// manejo de fallo parcial -- ver la bitacora de migracion). Este test
// confirma: (1) crea una fila por cada dia del rango en un solo request,
// (2) si un dia ya tenia una exclusion cargada, no aborta el resto -- lo
// reporta como "skipped" y sigue con los demas.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const UID = 'test-exclusions-range-ci';
// Empresa y usuario de reloj propios del test. Antes usaba el USERID 205, un
// usuario real de la empresa de fixture 4: en una base vacia (el CI) no
// existia y el test fallaba sin haber probado nada.
const TENANT_ID = 999951;
const TEST_USER_ID = 8890101;
// Rango lejos de cualquier dato real -- año de prueba dedicado.
const DATE_FROM = '2099-01-10';
const DATE_TO = '2099-01-14'; // 5 dias
const PRELOADED_DATE = '2099-01-12'; // el del medio, cargado a mano antes

async function cleanup() {
  await db.query('DELETE FROM user_exclusion_log WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT_ID]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Exclusions Range (test)', 'tenant-exclusions-range-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  await cleanup();
  const [emp] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (900801, 'Exclusions Range Test', ?, 1)`,
    [TENANT_ID]
  );
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '900801', 'Exclusions Range Test')`, [TEST_USER_ID, TENANT_ID]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [TEST_USER_ID, TENANT_ID, emp.insertId]);
});

after(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]);
  await deleteTestUser(UID);
  await closeDb();
});

test('POST /config/user-exclusions/range crea un dia por fila y reporta honestamente los que ya existian', async () => {
  const headers = await getTestAuthHeaders(UID);

  // Precargar UN dia del medio del rango a mano, para simular "ya estaba justificado".
  // userexclusions.tenant_id ya es NOT NULL (migracion 20260909) -- se
  // resuelve del tenant real del USERID en vez de inventar uno.
  const [[rawUser]] = await db.query('SELECT tenant_id FROM users WHERE USERID = ?', [TEST_USER_ID]);
  await db.query(
    `INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, 'FULL_DAY')`,
    [TEST_USER_ID, rawUser.tenant_id, PRELOADED_DATE, 'Cargado antes, a mano']
  );

  const res = await fetch(`${BASE_URL}/config/user-exclusions/range`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: TEST_USER_ID,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      reason: 'Vacaciones de prueba CI',
      type: 'FULL_DAY',
    }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.totalDays, 5);
  assert.equal(json.created, 4, 'deberia crear los 4 dias que no estaban cargados');
  assert.equal(json.skipped.length, 1, 'deberia reportar el dia precargado como salteado, no como error fatal');
  assert.equal(json.skipped[0].excDate, PRELOADED_DATE);

  const [rows] = await db.query(
    'SELECT excDate, reason FROM userexclusions WHERE userId = ? AND excDate BETWEEN ? AND ? ORDER BY excDate',
    [TEST_USER_ID, DATE_FROM, DATE_TO]
  );
  assert.equal(rows.length, 5, 'las 5 fechas del rango deberian existir en la base (4 nuevas + 1 precargada)');
  assert.equal(rows.find((r) => r.excDate === PRELOADED_DATE).reason, 'Cargado antes, a mano', 'el dia precargado no se debe haber pisado');
});

test('GET /config/user-exclusions?userId=X&excDate=Y devuelve exactamente esa fila', async () => {
  const headers = await getTestAuthHeaders(UID);
  const res = await fetch(`${BASE_URL}/config/user-exclusions?userId=${TEST_USER_ID}&excDate=${PRELOADED_DATE}`, { headers });
  const json = await res.json();
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].reason, 'Cargado antes, a mano');
});

// Fase 4.7 (Licencias): al crear una licencia multi-dia, el frontend
// consulta este mismo rango para avisar (no bloquear) si se superpone con
// justificaciones puntuales ya cargadas.
test('GET /config/user-exclusions?userId=X&dateFrom=Y&dateTo=Z devuelve todas las filas del rango', async () => {
  const headers = await getTestAuthHeaders(UID);
  const res = await fetch(`${BASE_URL}/config/user-exclusions?userId=${TEST_USER_ID}&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`, { headers });
  const json = await res.json();
  assert.equal(json.data.length, 5, 'las 5 filas creadas en el test anterior deberian aparecer');
  assert.ok(json.data.some((r) => r.excDate === PRELOADED_DATE));
});

// 2026-10-09: el listado informa QUIÉN cargó cada justificación (Presentismo
// lo muestra al editarla: "Cargada por ...").
test('GET /config/user-exclusions informa quién la cargó', async () => {
  const headers = await getTestAuthHeaders(UID);
  const r = await fetch(`${BASE_URL}/config/user-exclusions?userId=${TEST_USER_ID}&excDate=${DATE_FROM}&tenantId=${TENANT_ID}`, { headers });
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].createdByEmail, `${UID}@test.local`);
});
