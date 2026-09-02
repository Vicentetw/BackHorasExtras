// Fase 4.6: POST /config/user-exclusions/range reemplaza el patron del
// dashboard.html original (un POST por dia, en un loop del cliente, sin
// manejo de fallo parcial -- ver la bitacora de migracion). Este test
// confirma: (1) crea una fila por cada dia del rango en un solo request,
// (2) si un dia ya tenia una exclusion cargada, no aborta el resto -- lo
// reporta como "skipped" y sigue con los demas.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const UID = 'test-exclusions-range-ci';
// USERID real de AVP2 (tenant de prueba, no la empresa real).
const TEST_USER_ID = 205;
// Rango lejos de cualquier dato real -- año de prueba dedicado.
const DATE_FROM = '2099-01-10';
const DATE_TO = '2099-01-14'; // 5 dias
const PRELOADED_DATE = '2099-01-12'; // el del medio, cargado a mano antes

after(async () => {
  await db.query('DELETE FROM userexclusions WHERE userId = ? AND excDate BETWEEN ? AND ?', [TEST_USER_ID, DATE_FROM, DATE_TO]);
  await deleteTestUser(UID);
  await closeDb();
});

test('POST /config/user-exclusions/range crea un dia por fila y reporta honestamente los que ya existian', async () => {
  const headers = await getTestAuthHeaders(UID);

  // Precargar UN dia del medio del rango a mano, para simular "ya estaba justificado".
  await db.query(
    `INSERT INTO userexclusions (userId, excDate, reason, type) VALUES (?, ?, ?, 'FULL_DAY')`,
    [TEST_USER_ID, PRELOADED_DATE, 'Cargado antes, a mano']
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
