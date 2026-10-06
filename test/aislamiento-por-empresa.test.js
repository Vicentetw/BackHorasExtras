// Aislamiento por empresa (AISLAMIENTO_POR_EMPRESA.md, letra A).
//
// Pedido del dueño (2026-10-06): "cada empresa debe tener todo propio" -- ej.
// el 05/10 (Dia del Camino) es feriado solo para AVP. Se encontro que casi
// todo lo "global" era en realidad dato de AVP cargado sin empresa: feriados
// que se aplicaban a todas (y no se veian), horario por fecha, escala de
// vacaciones, ciudades. Estos tests fijan que lo de una empresa nunca afecta
// a otra, y que el superadmin no puede crear datos "de todos" por accidente.
//
// Requiere el backend local corriendo (puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999931;
const TENANT_B = 999932;
const UID_A = 'test-aislamiento-a';
const UID_B = 'test-aislamiento-b';
const UID_SUPER = 'test-aislamiento-super';
const DIA_DEL_CAMINO = '2026-10-05'; // lunes: feriado SOLO de A
const LEGAJO_B = 999932001;
const USERID_B = 999932001;

let headersA;
let headersB;
let headersSuper;

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

before(async () => {
  for (const [id, code] of [[TENANT_A, 'aislamiento-a'], [TENANT_B, 'aislamiento-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `Aislamiento ${code}`, code]);
  }
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B });
  headersSuper = await getTestAuthHeaders(UID_SUPER, { isSuperadmin: true });

  // Feriado propio de A.
  await db.query(
    `INSERT INTO holidays (tenant_id, ciudad_id, date, year, name, type, isWorkDay, recurring)
     VALUES (?, NULL, ?, 2026, 'Dia del Camino (test)', 'LOCAL', 0, 0)`,
    [TENANT_A, DIA_DEL_CAMINO]
  );
  // Escala de vacaciones propia de A (distinta de la ley).
  await db.query('INSERT INTO vacation_scale (tenant_id, min_years, max_years, days) VALUES (?, 0, NULL, 99)', [TENANT_A]);

  // Un empleado de B, que NO ficha el dia del feriado de A.
  const [emp] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, 'Empleado de B', ?, '2020-01-01', 0, 1)`,
    [LEGAJO_B, TENANT_B]
  );
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Empleado de B')`, [USERID_B, TENANT_B, String(LEGAJO_B)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [USERID_B, TENANT_B, emp.insertId]);
});

after(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    await db.query('DELETE FROM holidays WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM vacation_scale WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
  }
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await deleteTestUser(UID_SUPER);
  for (const t of [TENANT_A, TENANT_B]) await db.query('DELETE FROM tenants WHERE id = ?', [t]).catch(() => {});
  await closeDb();
});

test('el feriado de una empresa no aparece ni cuenta para otra', async () => {
  const { body } = await json(await fetch(`${BASE_URL}/api/holidays?year=2026`, { headers: headersB }));
  assert.ok(!(body.holidays || []).some((h) => h.date && String(h.date).startsWith(DIA_DEL_CAMINO)), 'B no deberia ver el feriado de A');

  const res = await fetch(`${BASE_URL}/attendance-range?from=${DIA_DEL_CAMINO}&to=${DIA_DEL_CAMINO}&employeeId=${LEGAJO_B}`, { headers: headersB });
  const data = await res.json();
  const dia = data.data[0].days.find((d) => d.date === DIA_DEL_CAMINO);
  assert.ok(!/Holiday/.test(dia.status), `para B el ${DIA_DEL_CAMINO} no es feriado (status: ${dia.status})`);
});

test('el superadmin no puede crear un feriado "de todos" por accidente', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/holidays`, {
    method: 'POST',
    headers: { ...headersSuper, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-10-06', name: 'Sin empresa (test)', type: 'LOCAL' }),
  }));
  assert.equal(status, 400);
  const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM holidays WHERE name = 'Sin empresa (test)'");
  assert.equal(n, 0);
});

test('el superadmin eligiendo la empresa crea el feriado para ESA empresa', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/holidays`, {
    method: 'POST',
    headers: { ...headersSuper, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-10-07', name: 'Elegido por superadmin (test)', type: 'LOCAL', tenant_id: TENANT_A }),
  }));
  assert.equal(status, 200, JSON.stringify(body));
  const [[row]] = await db.query('SELECT tenant_id FROM holidays WHERE id = ?', [body.id]);
  assert.equal(row.tenant_id, TENANT_A);
});

test('importar feriados en una empresa no modifica los de otra con la misma fecha', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/holidays/import`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ holidays: [{ date: DIA_DEL_CAMINO, name: 'Importado por B (test)', type: 'LOCAL' }] }),
  }));
  assert.equal(status, 200);
  const [[a]] = await db.query('SELECT name FROM holidays WHERE tenant_id = ? AND date = ?', [TENANT_A, DIA_DEL_CAMINO]);
  assert.equal(a.name, 'Dia del Camino (test)', 'el feriado de A no se toca');
  const [[b]] = await db.query('SELECT name FROM holidays WHERE tenant_id = ? AND date = ?', [TENANT_B, DIA_DEL_CAMINO]);
  assert.equal(b.name, 'Importado por B (test)', 'B tiene el suyo propio');
});

test('cada empresa ve su escala de vacaciones; sin escala propia, la de la ley', async () => {
  const a = (await json(await fetch(`${BASE_URL}/api/leave-balances/vacation-scale`, { headers: headersA }))).body;
  assert.equal(a.scale[0].days, 99, 'A ve la suya');
  const b = (await json(await fetch(`${BASE_URL}/api/leave-balances/vacation-scale`, { headers: headersB }))).body;
  assert.deepEqual(b.scale.map((s) => s.days), [14, 21, 28, 35], 'B, sin escala propia, ve la de la Ley de Contrato de Trabajo');
  assert.equal(b.esLaDeLaLey, true);
});

test('el superadmin no puede guardar una escala de vacaciones "de todos"', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/leave-balances/vacation-scale`, {
    method: 'POST',
    headers: { ...headersSuper, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: [{ minYears: 0, maxYears: null, days: 1 }] }),
  }));
  assert.equal(status, 400);
});

test('la configuracion de una empresa no la hereda otra', async () => {
  await fetch(`${BASE_URL}/config/overtime-settings`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtimeCutoffTime: '11:11', overtimeCapMinutes: 111 }),
  });
  const a = (await json(await fetch(`${BASE_URL}/config/overtime-settings`, { headers: headersA }))).body;
  assert.equal(a.overtimeCutoffTime, '11:11', 'A guardo la suya');
  const b = (await json(await fetch(`${BASE_URL}/config/overtime-settings`, { headers: headersB }))).body;
  assert.notEqual(b.overtimeCutoffTime, '11:11', 'B no hereda la de A');
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
});
