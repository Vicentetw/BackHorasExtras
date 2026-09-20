// Detectar y reparar VINCULOS SOSPECHOSOS.
//
// El caso real (2026-09, AVP): 100 empleados estaban vinculados a un usuario
// de reloj que nunca ficho, mientras sus fichajes entraban con otro numero
// que no tenia fila en `users`. Resultado: 61.375 fichajes que no llegaban a
// ningun reporte, y una pantalla de matching que no podia mostrarlo, porque
// solo listaba empleados SIN vinculo -- y estos SI tenian uno. Malo, pero
// tenian.
//
// Este archivo arma esa misma situacion en chiquito y verifica que se
// detecte y se arregle sin perder nada.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999978;
const TENANT_B = 999979;
const UID_A = 'test-matching-repair-a';

const LEGAJO = 7701;          // el legajo del empleado
const USERID_FANTASMA = 301;  // fila vieja de `users`, 0 fichajes
const USERID_REAL = LEGAJO;   // con el que ficha de verdad, sin fila en `users`
const LEGAJO_B = 7702;
const USERID_FANTASMA_B = 302;

let headersA;
let empleadoId, empleadoBId;

async function cleanup() {
  for (const t of [TENANT_A, TENANT_B]) {
    await db.query('DELETE FROM user_exclusion_log WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM app_settings WHERE tenant_id = ?', [t]);
  }
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_A, 'Tenant Repair A (test)', 'tenant-repair-a-test'],
    [TENANT_B, 'Tenant Repair B (test)', 'tenant-repair-b-test']
  ]) {
    await db.query(
      'INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [id, name, code]
    );
  }
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A });
  await cleanup();

  // --- Empresa A: el caso roto, reproducido ---
  const [emp] = await db.query(
    'INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)',
    [LEGAJO, 'MALERBA, Alejandro', TENANT_A]
  );
  empleadoId = emp.insertId;

  // La fila fantasma: tiene el legajo como badge, pero nunca ficho.
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)',
    [USERID_FANTASMA, TENANT_A, String(LEGAJO), 'MALERBA']);
  await db.query(
    "INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'auto_employee_id')",
    [USERID_FANTASMA, TENANT_A, empleadoId]
  );

  // Los fichajes reales entran con USERID = legajo, que NO tiene fila en users.
  for (const t of ['2026-09-15 07:00:00', '2026-09-16 07:02:00', '2026-09-17 06:58:00']) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)',
      [USERID_REAL, TENANT_A, t]);
  }

  // Una justificacion colgando del fantasma: tiene que sobrevivir a la reparacion.
  await db.query(
    "INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, 'FULL_DAY')",
    [USERID_FANTASMA, TENANT_A, '2026-09-10', 'Vacaciones cargadas antes de reparar']
  );

  // --- Empresa B: el mismo problema, para probar el aislamiento ---
  const [empB] = await db.query(
    'INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)',
    [LEGAJO_B, 'OTRA EMPRESA, Empleado', TENANT_B]
  );
  empleadoBId = empB.insertId;
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)',
    [USERID_FANTASMA_B, TENANT_B, String(LEGAJO_B), 'OTRA']);
  await db.query(
    "INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'auto_employee_id')",
    [USERID_FANTASMA_B, TENANT_B, empleadoBId]
  );
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)',
    [LEGAJO_B, TENANT_B, '2026-09-15 08:00:00']);
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('detecta el vínculo roto y explica por qué', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/suspicious`, { headers: headersA });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.count, 1);
  assert.equal(json.activeCount, 1);
  assert.equal(json.recoverableCheckins, 3, 'los 3 fichajes que hoy no llegan a ningun reporte');

  const c = json.items[0];
  assert.equal(c.employeeId, empleadoId);
  assert.equal(c.linkedUserId, USERID_FANTASMA, 'a quien esta vinculado hoy (0 fichajes)');
  assert.equal(Number(c.suggestedUserId), USERID_REAL, 'con quien ficha de verdad');
  assert.equal(Number(c.suggestedCheckinCount), 3);
});

test('NO muestra los casos de otra empresa', async () => {
  const json = await (await fetch(`${BASE_URL}/api/matching/suspicious`, { headers: headersA })).json();
  const ajeno = json.items.find((i) => Number(i.employeeId) === empleadoBId);
  assert.equal(ajeno, undefined, 'el caso de la otra empresa no debe aparecer');
});

test('rechaza reparar si los datos cambiaron desde que se vio la pantalla', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/repair`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: empleadoId, suggestedUserId: 999999 })
  });
  assert.equal(res.status, 409, 'no debe aplicar algo distinto de lo que la persona aprobo');

  const [rows] = await db.query('SELECT USERID FROM user_employee_map WHERE employee_id = ?', [empleadoId]);
  assert.equal(rows[0].USERID, USERID_FANTASMA, 'el vinculo no debe haberse tocado');
});

test('repara: crea el usuario que faltaba, mueve el vínculo y no pierde nada', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/repair`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: empleadoId, suggestedUserId: USERID_REAL })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.recoveredCheckins, 3);

  // La fila que faltaba existe, con el legajo como badge.
  const [[nuevo]] = await db.query('SELECT Badgenumber, Name FROM `users` WHERE USERID = ? AND tenant_id = ?',
    [USERID_REAL, TENANT_A]);
  assert.ok(nuevo, 'debe existir la fila de users que faltaba');
  assert.equal(nuevo.Badgenumber, String(LEGAJO));

  // El fantasma ya no esta.
  const [fantasma] = await db.query('SELECT USERID FROM `users` WHERE USERID = ? AND tenant_id = ?',
    [USERID_FANTASMA, TENANT_A]);
  assert.equal(fantasma.length, 0, 'la fila fantasma debe haberse borrado');

  // El vinculo apunta al usuario correcto.
  const [[link]] = await db.query('SELECT USERID, match_type FROM user_employee_map WHERE employee_id = ?', [empleadoId]);
  assert.equal(Number(link.USERID), USERID_REAL);
  assert.equal(link.match_type, 'reparado');

  // La justificacion cargada antes NO se perdio: se movio al usuario real.
  const [[exc]] = await db.query('SELECT userId, reason FROM userexclusions WHERE tenant_id = ?', [TENANT_A]);
  assert.equal(Number(exc.userId), USERID_REAL, 'la justificacion debe seguir viva, apuntando al usuario correcto');
  assert.equal(exc.reason, 'Vacaciones cargadas antes de reparar');
});

test('lo importante: los fichajes dejan de estar huérfanos', async () => {
  // Esta es la razon de ser de toda la operacion. Antes de reparar, estos 3
  // fichajes no se podian resolver a ningun empleado.
  const [[r]] = await db.query(`
    SELECT COUNT(*) n
    FROM Checkins c
    JOIN \`users\` u ON u.USERID = c.USERID AND u.tenant_id = c.tenant_id
    JOIN user_employee_map m ON m.USERID = u.USERID AND m.tenant_id = u.tenant_id
    WHERE c.tenant_id = ? AND m.employee_id = ?`, [TENANT_A, empleadoId]);
  assert.equal(r.n, 3, 'los 3 fichajes ahora llegan al empleado');

  const [[huerfanos]] = await db.query(`
    SELECT COUNT(*) n FROM Checkins c
    LEFT JOIN \`users\` u ON u.USERID = c.USERID AND u.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? AND u.USERID IS NULL`, [TENANT_A]);
  assert.equal(huerfanos.n, 0, 'no debe quedar ningun fichaje sin usuario');
});

test('ya reparado, deja de aparecer como sospechoso', async () => {
  const json = await (await fetch(`${BASE_URL}/api/matching/suspicious`, { headers: headersA })).json();
  assert.equal(json.count, 0);
});

test('no se puede reparar un empleado de OTRA empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/repair`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: empleadoBId, suggestedUserId: LEGAJO_B })
  });
  assert.equal(res.status, 404);

  const [[link]] = await db.query('SELECT USERID FROM user_employee_map WHERE employee_id = ?', [empleadoBId]);
  assert.equal(Number(link.USERID), USERID_FANTASMA_B, 'la otra empresa no debe haberse tocado');
});
