// Pedido real: Vialidad tiene sedes en varias ciudades y cada una tiene su
// propio "Dia de la Ciudad" -- un feriado que debe aplicar SOLO a los
// empleados de esa ciudad, no a toda la empresa. Este test cubre los 3
// motores que calculan asistencia (motor diario, Legacy de comparacion,
// /attendance-range) mas la validacion de duplicados de routes/holidays.js.
//
// De paso confirma el bug fix de aislamiento por tenant en el motor Legacy
// y en /attendance-range (ninguno de los dos filtraba holidays por
// tenant_id antes de este cambio -- ver attendanceService.js y
// horasdedica2.js, Fase 21).
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-holidays-by-ciudad';
const TENANT_A = 999950;
const TENANT_B = 999951; // sin feriados propios -- control de aislamiento
const FERIADO_CIUDAD = '2026-09-08'; // "Dia de la Ciudad" -- SOLO Rawson
const FERIADO_EMPRESA = '2026-09-09'; // feriado nacional -- toda la empresa

let headers, db;
let ciudadRawsonId, ciudadTrelewId;
let empRawsonId, badgeRawson, userRawson;
let empTrelewId, badgeTrelew, userTrelew;
let empSinCiudadId, badgeSinCiudad, userSinCiudad;
let empControlId, badgeControl, userControl;
let tplA, tplB;
let holidayCiudadId, holidayEmpresaId;

async function seedEmpleado(tenantId, templateId, badge, userId, nombre, ciudadId) {
  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, ciudad_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, ?, '2020-01-01', 0)`,
    [badge, nombre, tenantId, ciudadId]
  );
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, tenantId, String(badge), nombre]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, tenantId, empResult.insertId]);
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`,
    [empResult.insertId, tenantId, templateId]
  );
  return empResult.insertId;
}

async function seedTemplate(tenantId, nombre) {
  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)`,
    [tenantId, nombre]
  );
  for (let dow = 0; dow <= 6; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Administrativo', '08:00:00', '16:00:00', 'WORK', 0, 1)`,
      [tplResult.insertId, dow]
    );
  }
  return tplResult.insertId;
}

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
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Feriado Ciudad A (test)', 'tenant-feriado-ciudad-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Feriado Ciudad B (test)', 'tenant-feriado-ciudad-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );

  const [ciudadRawson] = await db.query(
    `INSERT INTO ciudades (tenant_id, nombre, active) VALUES (?, 'Rawson (test)', 1)`, [TENANT_A]
  );
  ciudadRawsonId = ciudadRawson.insertId;
  const [ciudadTrelew] = await db.query(
    `INSERT INTO ciudades (tenant_id, nombre, active) VALUES (?, 'Trelew (test)', 1)`, [TENANT_A]
  );
  ciudadTrelewId = ciudadTrelew.insertId;

  tplA = await seedTemplate(TENANT_A, 'Administrativo A (test, feriado ciudad)');
  tplB = await seedTemplate(TENANT_B, 'Administrativo B (test, feriado ciudad)');

  // badge === USERID a proposito: los 4 motores usan convenciones de join
  // distintas entre Checkins y users (por USERID directo, por Badgenumber,
  // o con fallback a cualquiera de los dos) -- igualando ambos valores el
  // fichaje matchea en los 4 sin tener que duplicar filas de Checkins.
  const seed = Date.now() % 1000000;
  badgeRawson = 940000 + (seed % 20000);
  userRawson = badgeRawson;
  badgeTrelew = 943000 + (seed % 20000);
  userTrelew = badgeTrelew;
  badgeSinCiudad = 946000 + (seed % 20000);
  userSinCiudad = badgeSinCiudad;
  badgeControl = 949000 + (seed % 20000);
  userControl = badgeControl;

  empRawsonId = await seedEmpleado(TENANT_A, tplA, badgeRawson, userRawson, 'Empleado Rawson', ciudadRawsonId);
  empTrelewId = await seedEmpleado(TENANT_A, tplA, badgeTrelew, userTrelew, 'Empleado Trelew', ciudadTrelewId);
  empSinCiudadId = await seedEmpleado(TENANT_A, tplA, badgeSinCiudad, userSinCiudad, 'Empleado Sin Ciudad', null);
  empControlId = await seedEmpleado(TENANT_B, tplB, badgeControl, userControl, 'Empleado Control Tenant B', null);

  // El empleado de Rawson SI fichó el dia del feriado de su ciudad -> deberia
  // dar WorkedHoliday. Los demas no fichan ese dia.
  // OJO: Checkins.USERID guarda el ID crudo que reporta el reloj -- segun el
  // motor, se lo empareja con users.USERID O con users.Badgenumber (fallback
  // por si el reloj reporta el legajo en vez del USERID interno). El Legacy
  // de un solo dia (horasdedica2.js, GET /attendance/:date) SOLO empareja
  // por Badgenumber -- se usa el badge ademas del USERID para que matchee en
  // los 3 motores por igual.
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`,
    [badgeRawson, TENANT_A, `${FERIADO_CIUDAD} 08:03:00`]);

  // Feriado acotado a Rawson -- SOLO deberia afectar a empRawson.
  const [holidayCiudad] = await db.query(
    `INSERT INTO holidays (tenant_id, ciudad_id, date, year, name, description, type, isWorkDay, recurring)
     VALUES (?, ?, ?, 2026, 'Dia de la Ciudad de Rawson (test)', 'Feriado de ciudad de prueba', 'LOCAL', 0, 0)`,
    [TENANT_A, ciudadRawsonId, FERIADO_CIUDAD]
  );
  holidayCiudadId = holidayCiudad.insertId;

  // Feriado de toda la empresa (sin ciudad) -- deberia afectar a los 3
  // empleados de TENANT_A, incluido el que no tiene ciudad asignada.
  const [holidayEmpresa] = await db.query(
    `INSERT INTO holidays (tenant_id, ciudad_id, date, year, name, description, type, isWorkDay, recurring)
     VALUES (?, NULL, ?, 2026, 'Feriado Nacional (test)', 'Feriado nacional de prueba', 'NATIONAL', 0, 0)`,
    [TENANT_A, FERIADO_EMPRESA]
  );
  holidayEmpresaId = holidayEmpresa.insertId;
});

after(async () => {
  await db.query('DELETE FROM holidays WHERE id IN (?, ?)', [holidayCiudadId, holidayEmpresaId]);
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?, ?, ?)', [userRawson, userTrelew, userSinCiudad, userControl]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id IN (?, ?, ?, ?)', [empRawsonId, empTrelewId, empSinCiudadId, empControlId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id IN (?, ?)', [tplA, tplB]);
  await db.query('DELETE FROM work_schedule_templates WHERE id IN (?, ?)', [tplA, tplB]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?, ?, ?)', [userRawson, userTrelew, userSinCiudad, userControl]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?, ?, ?)', [userRawson, userTrelew, userSinCiudad, userControl]);
  await db.query('DELETE FROM employees WHERE id IN (?, ?, ?, ?)', [empRawsonId, empTrelewId, empSinCiudadId, empControlId]);
  await db.query('DELETE FROM ciudades WHERE id IN (?, ?)', [ciudadRawsonId, ciudadTrelewId]);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

// ---------------------------------------------------------------
// Motor diario
// ---------------------------------------------------------------
test('motor diario: feriado de Rawson -> WorkedHoliday para el empleado de Rawson que fichó', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO_CIUDAD}?tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeRawson));
  assert.ok(row);
  assert.equal(row.status, 'WorkedHoliday');
});

test('motor diario: feriado de Rawson NO afecta a un empleado de Trelew (dia normal, Absent si no fichó)', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO_CIUDAD}?tenantId=${TENANT_A}`, { headers });
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeTrelew));
  assert.ok(row);
  assert.equal(row.status, 'Absent', 'Trelew no tiene feriado ese dia -- es una ausencia real');
});

test('motor diario: un empleado sin ciudad asignada NO matchea el feriado de Rawson', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO_CIUDAD}?tenantId=${TENANT_A}`, { headers });
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeSinCiudad));
  assert.ok(row);
  assert.equal(row.status, 'Absent');
});

test('motor diario: el feriado nacional (sin ciudad) SI aplica a los 3, incluido el que no tiene ciudad', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO_EMPRESA}?tenantId=${TENANT_A}`, { headers });
  const body = await res.json();
  for (const badge of [badgeRawson, badgeTrelew, badgeSinCiudad]) {
    const row = body.attendance.find(a => String(a.employeeId) === String(badge));
    assert.ok(row, `deberia aparecer ${badge}`);
    assert.equal(row.status, 'HolidayAbsent', `${badge} deberia quedar HolidayAbsent en el feriado de toda la empresa`);
  }
});

// ---------------------------------------------------------------
// Motor Legacy (comparacion) -- /api/labor-engine/attendance/:date/compare
// ---------------------------------------------------------------
test('motor Legacy (compare): feriado de Rawson -> WorkedHoliday solo para Rawson, dia normal para Trelew', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO_CIUDAD}/compare?tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const rowRawson = body.legacy.attendance.find(a => String(a.badgeNumber) === String(badgeRawson));
  const rowTrelew = body.legacy.attendance.find(a => String(a.badgeNumber) === String(badgeTrelew));
  assert.ok(rowRawson && rowTrelew);
  assert.equal(rowRawson.status, 'WorkedHoliday');
  assert.equal(rowTrelew.status, 'Absent');
});

test('motor Legacy (compare): aislamiento -- TENANT_B no ve el feriado de TENANT_A', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO_CIUDAD}/compare?tenantId=${TENANT_B}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.legacy.attendance.find(a => String(a.badgeNumber) === String(badgeControl));
  assert.ok(row, 'deberia aparecer el empleado control');
  assert.equal(row.status, 'Absent', 'TENANT_B no tiene feriado ese dia -- no deberia heredar el de TENANT_A');
});

// ---------------------------------------------------------------
// Legacy de un solo dia -- GET /attendance/:date
// ---------------------------------------------------------------
test('Legacy de un dia: feriado de Rawson -> WorkedHoliday solo para Rawson', async () => {
  const res = await fetch(`${BASE_URL}/attendance/${FERIADO_CIUDAD}?tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const rowRawson = body.attendance.find(a => String(a.badgeNumber) === String(badgeRawson));
  const rowTrelew = body.attendance.find(a => String(a.badgeNumber) === String(badgeTrelew));
  assert.ok(rowRawson && rowTrelew);
  assert.equal(rowRawson.status, 'WorkedHoliday');
  assert.equal(rowTrelew.status, 'Absent');
});

test('Legacy de un dia: aislamiento -- TENANT_B no ve el feriado de TENANT_A', async () => {
  const res = await fetch(`${BASE_URL}/attendance/${FERIADO_CIUDAD}?tenantId=${TENANT_B}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.attendance.find(a => String(a.badgeNumber) === String(badgeControl));
  assert.ok(row);
  assert.equal(row.status, 'Absent');
});

// ---------------------------------------------------------------
// /attendance-range (calendario mensual/anual de Presentismo)
// ---------------------------------------------------------------
test('/attendance-range (detalle): feriado de Rawson -> WorkedHoliday ese dia para Rawson', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=${FERIADO_CIUDAD}&to=${FERIADO_CIUDAD}&tenantId=${TENANT_A}&employeeId=${badgeRawson}`,
    { headers }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.data.find(r => String(r.employeeId) === String(badgeRawson));
  assert.ok(row && row.days, 'deberia venir el detalle por dia');
  const day = row.days.find(d => d.date === FERIADO_CIUDAD);
  assert.ok(day, 'deberia haber una fila para ese dia');
  assert.equal(day.status, 'WorkedHoliday');
});

test('/attendance-range (detalle): feriado de Rawson -> HolidayAbsent (no NonWorkDay) para Trelew que no fichó', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=${FERIADO_CIUDAD}&to=${FERIADO_CIUDAD}&tenantId=${TENANT_A}&employeeId=${badgeTrelew}`,
    { headers }
  );
  const body = await res.json();
  const row = body.data.find(r => String(r.employeeId) === String(badgeTrelew));
  assert.ok(row && row.days);
  const day = row.days.find(d => d.date === FERIADO_CIUDAD);
  assert.ok(day);
  // Trelew no tiene el feriado de Rawson -- es un dia laborable normal donde
  // no fichó: HolidayAbsent NO corresponde (eso seria para Rawson).
  assert.equal(day.status, 'Absent');
});

test('/attendance-range (detalle): un empleado sin ciudad NO matchea el feriado de Rawson', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=${FERIADO_CIUDAD}&to=${FERIADO_CIUDAD}&tenantId=${TENANT_A}&employeeId=${badgeSinCiudad}`,
    { headers }
  );
  const body = await res.json();
  const row = body.data.find(r => String(r.employeeId) === String(badgeSinCiudad));
  const day = row.days.find(d => d.date === FERIADO_CIUDAD);
  assert.equal(day.status, 'Absent');
});

test('/attendance-range (detalle): el feriado nacional SI da HolidayAbsent para los 3, incluido sin ciudad', async () => {
  for (const badge of [badgeRawson, badgeTrelew, badgeSinCiudad]) {
    const res = await fetch(
      `${BASE_URL}/attendance-range?from=${FERIADO_EMPRESA}&to=${FERIADO_EMPRESA}&tenantId=${TENANT_A}&employeeId=${badge}`,
      { headers }
    );
    const body = await res.json();
    const row = body.data.find(r => String(r.employeeId) === String(badge));
    const day = row.days.find(d => d.date === FERIADO_EMPRESA);
    assert.ok(day, `deberia haber fila para ${badge} el ${FERIADO_EMPRESA}`);
    assert.equal(day.status, 'HolidayAbsent', `${badge} deberia dar HolidayAbsent en el feriado nacional`);
  }
});

test('/attendance-range (resumen, sin detalle): el feriado de ciudad no cuenta como Absent para Rawson que trabajó', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=${FERIADO_CIUDAD}&to=${FERIADO_CIUDAD}&tenantId=${TENANT_A}`,
    { headers }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.data.find(r => String(r.employeeId) === String(badgeRawson));
  assert.ok(row);
  assert.equal(row.absent, 0);
});

test('/attendance-range: aislamiento -- TENANT_B no ve el feriado de TENANT_A', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=${FERIADO_CIUDAD}&to=${FERIADO_CIUDAD}&tenantId=${TENANT_B}&employeeId=${badgeControl}`,
    { headers }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.data.find(r => String(r.employeeId) === String(badgeControl));
  assert.ok(row && row.days);
  const day = row.days.find(d => d.date === FERIADO_CIUDAD);
  assert.equal(day.status, 'Absent', 'TENANT_B no deberia heredar el feriado de TENANT_A');
});

// ---------------------------------------------------------------
// routes/holidays.js -- validacion de duplicados por (tenant, fecha, ciudad)
// ---------------------------------------------------------------
test('POST /api/holidays: mismo tenant+fecha+ciudad -> 409', async () => {
  const res = await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: FERIADO_CIUDAD,
      name: 'Duplicado de prueba',
      type: 'LOCAL',
      isWorkDay: false,
      recurring: false,
      ciudad_id: ciudadRawsonId,
      tenantId: TENANT_A
    })
  });
  assert.equal(res.status, 409);
});

test('POST /api/holidays: misma fecha pero OTRA ciudad -> 200 (no es duplicado)', async () => {
  const res = await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: FERIADO_CIUDAD,
      name: 'Feriado Trelew el mismo dia (test)',
      description: 'Feriado de prueba',
      type: 'LOCAL',
      isWorkDay: false,
      recurring: false,
      ciudad_id: ciudadTrelewId,
      tenantId: TENANT_A
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  await db.query('DELETE FROM holidays WHERE id = ?', [body.id]);
});

test('POST /api/holidays: sin description (campo opcional en el dialogo) -> 200, no 500', async () => {
  // Bug real: holidays.description era VARCHAR(200) NOT NULL, unica
  // columna "description" de todo el esquema con esa restriccion -- el
  // dialogo de Angular la trata como opcional (sin required), routes/
  // holidays.js convierte '' a null antes de insertar, y esa insercion
  // rompia con ER_BAD_NULL_ERROR. Migracion 20260919 la vuelve nullable.
  const res = await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-02',
      name: 'Feriado sin descripcion (test)',
      type: 'LOCAL',
      isWorkDay: false,
      recurring: false,
      tenantId: TENANT_A
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  await db.query('DELETE FROM holidays WHERE id = ?', [body.id]);
});

test('POST /api/holidays: ciudad_id inexistente -> 404', async () => {
  const res = await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-01',
      name: 'Feriado ciudad inexistente (test)',
      type: 'LOCAL',
      isWorkDay: false,
      recurring: false,
      ciudad_id: 999999999,
      tenantId: TENANT_A
    })
  });
  assert.equal(res.status, 404);
});

test('GET /api/holidays: devuelve ciudad_nombre para el feriado de Rawson', async () => {
  const res = await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}&year=2026`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.holidays.find(h => h.id === holidayCiudadId);
  assert.ok(row, 'deberia venir el feriado de Rawson en el listado');
  assert.equal(row.ciudad_nombre, 'Rawson (test)');
});
