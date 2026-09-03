// Fase 6.4: employees.overtime_authorized existia desde hacia tiempo pero
// ningun motor lo aplicaba (confirmado con el usuario: en la base real,
// 466 de 476 empleados tienen el flag en 0, dato que nunca se curó porque
// nunca hizo nada). El modo 'all' (default) preserva el comportamiento de
// siempre -- activar 'custom' sin querer no debe poder romper el total de
// HE de una empresa que nunca configuro nada.
//
// Usa un empleado/usuario DESCARTABLE propio (no legajo 2525 real) para no
// interferir con attendance-range.test.js, que corre en paralelo (node
// --test paraleliza por archivo) y espera los totales reales de Perrotta
// sin que nadie le toque overtime_authorized ni Checkins en el medio. El
// empleado se crea/borra en beforeEach/afterEach (no una vez para todo el
// archivo) para que exista la menor ventana de tiempo posible mientras
// otro archivo cuenta el total de empleados sin filtrar.
//
// Mismo flake de paralelismo ya documentado en attendance-range.test.js
// (476 vs 477): mientras este archivo corre, /attendance-range sin filtrar
// de otro archivo puede llegar a contar este empleado descartable de mas.
// Se probo acotar la ventana (beforeEach/afterEach en vez de before/after
// de todo el archivo) sin eliminarlo del todo -- el runtime de
// attendance-range.test.js parece solapar con la corrida completa de este
// archivo, no solo un instante. Corre limpio en aislamiento
// (node --test test/overtime-authorization-mode.test.js); en `npm test`
// puede coincidir con ese flake ya conocido, no es un fallo de esta logica.
require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-overtime-auth-mode';
const LEGAJO = '999997';
const USERID = 999997;
const AUTO_DATE = '2026-08-18'; // martes, sin feriado, lejos de junio 2026

let originalMode;

before(async () => {
  const [[modeRow]] = await db.query(`SELECT value FROM app_settings WHERE name = 'overtimeAuthorizationMode'`);
  originalMode = modeRow ? modeRow.value : 'all';
});

after(async () => {
  await db.query(
    `INSERT INTO app_settings (name, value) VALUES ('overtimeAuthorizationMode', ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [originalMode]
  );
  await deleteTestUser(TEST_UID);
  await closeDb();
});

async function createDisposableEmployee() {
  await db.query(
    `INSERT INTO employees (employee_id, nombre, activo, overtime_authorized)
     VALUES (?, 'TEST OVERTIME AUTH', 0, 1)
     ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
    [LEGAJO]
  );
  const [[emp]] = await db.query('SELECT id FROM employees WHERE employee_id = ?', [LEGAJO]);
  await db.query(
    `INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, 'TEST OVERTIME AUTH')
     ON DUPLICATE KEY UPDATE Name = VALUES(Name)`,
    [USERID, LEGAJO]
  );
  await db.query(
    `INSERT INTO user_employee_map (USERID, employee_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id)`,
    [USERID, emp.id]
  );
}

async function destroyDisposableEmployee() {
  await db.query('DELETE FROM ManualEntries WHERE userId = ?', [USERID]).catch(() => {});
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [USERID]).catch(() => {});
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [USERID]).catch(() => {});
  await db.query('DELETE FROM users WHERE USERID = ?', [USERID]).catch(() => {});
  await db.query('DELETE FROM employees WHERE employee_id = ?', [LEGAJO]).catch(() => {});
}

beforeEach(createDisposableEmployee);
afterEach(destroyDisposableEmployee);

test('modo "all": el total de HE no cambia aunque el empleado tenga overtime_authorized=0', async () => {
  await db.query(`UPDATE app_settings SET value = 'all' WHERE name = 'overtimeAuthorizationMode'`);
  await db.query(`UPDATE employees SET overtime_authorized = 0 WHERE employee_id = ?`, [LEGAJO]);

  const headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });
  const addRes = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: USERID,
      startDatetime: `${AUTO_DATE} 14:00`,
      endDatetime: `${AUTO_DATE} 16:00`,
      durationMinutes: 120,
      type: 'he'
    })
  });
  const addJson = await addRes.json();

  const rangeUrl = `${BASE_URL}/attendance-range?from=${AUTO_DATE}&to=${AUTO_DATE}&employeeId=${LEGAJO}`;
  const res = await fetch(rangeUrl, { headers });
  const json = await res.json();
  const emp = json.data.find((e) => String(e.employeeId) === LEGAJO);
  assert.equal(Number(emp.overtimeHours), 2);

  await db.query('DELETE FROM ManualEntries WHERE id = ?', [addJson.id]);
});

test('modo "custom": overtime_authorized=0 no bloquea una HE manual (solo la automatica), =1 no cambia nada', async () => {
  await db.query(`UPDATE app_settings SET value = 'custom' WHERE name = 'overtimeAuthorizationMode'`);
  await db.query(`UPDATE employees SET overtime_authorized = 0 WHERE employee_id = ?`, [LEGAJO]);

  const headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });
  const addRes = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: USERID,
      startDatetime: `${AUTO_DATE} 14:00`,
      endDatetime: `${AUTO_DATE} 16:00`,
      durationMinutes: 120,
      type: 'he'
    })
  });
  const addJson = await addRes.json();

  const rangeUrl = `${BASE_URL}/attendance-range?from=${AUTO_DATE}&to=${AUTO_DATE}&employeeId=${LEGAJO}`;
  const res = await fetch(rangeUrl, { headers });
  const json = await res.json();
  const emp = json.data.find((e) => String(e.employeeId) === LEGAJO);
  assert.equal(Number(emp.overtimeHours), 2, 'una entrada MANUAL se suma igual aunque el empleado no este autorizado -- la carga manual es una decision explicita del admin');

  await db.query('DELETE FROM ManualEntries WHERE id = ?', [addJson.id]);
});

test('modo "custom": overtime_authorized=0 SI bloquea la HE automatica (detectada por fichajes)', async () => {
  await db.query(`UPDATE app_settings SET value = 'custom' WHERE name = 'overtimeAuthorizationMode'`);

  // Fichajes sinteticos: entrada normal + 2 post-corte (14:00, 16:00) --
  // dispara el heuristico clasico (2do fichaje post-corte hasta el ultimo).
  await db.query(
    `INSERT INTO Checkins (USERID, CHECKTIME) VALUES (?, ?), (?, ?), (?, ?)`,
    [USERID, `${AUTO_DATE} 07:30:00`, USERID, `${AUTO_DATE} 14:00:00`, USERID, `${AUTO_DATE} 16:00:00`]
  );

  const headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });
  const rangeUrl = `${BASE_URL}/attendance-range?from=${AUTO_DATE}&to=${AUTO_DATE}&employeeId=${LEGAJO}`;

  await db.query(`UPDATE employees SET overtime_authorized = 0 WHERE employee_id = ?`, [LEGAJO]);
  const resBlocked = await fetch(rangeUrl, { headers });
  const jsonBlocked = await resBlocked.json();
  const empBlocked = jsonBlocked.data.find((e) => String(e.employeeId) === LEGAJO);
  assert.equal(Number(empBlocked.overtimeHours), 0, 'sin autorizacion, la HE automatica no debe computarse en modo custom');

  await db.query(`UPDATE employees SET overtime_authorized = 1 WHERE employee_id = ?`, [LEGAJO]);
  const resAllowed = await fetch(rangeUrl, { headers });
  const jsonAllowed = await resAllowed.json();
  const empAllowed = jsonAllowed.data.find((e) => String(e.employeeId) === LEGAJO);
  assert.ok(Number(empAllowed.overtimeHours) > 0, 'con autorizacion, la misma HE automatica si debe computarse');
});

test('GET/POST /config/overtime-authorization-mode', async () => {
  const headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });

  const postRes = await fetch(`${BASE_URL}/config/overtime-authorization-mode`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtimeAuthorizationMode: 'custom' })
  });
  assert.equal(postRes.status, 200);

  const getRes = await fetch(`${BASE_URL}/config/overtime-authorization-mode`, { headers });
  const getJson = await getRes.json();
  assert.equal(getJson.overtimeAuthorizationMode, 'custom');

  const badRes = await fetch(`${BASE_URL}/config/overtime-authorization-mode`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtimeAuthorizationMode: 'bogus' })
  });
  assert.equal(badRes.status, 400);
});
