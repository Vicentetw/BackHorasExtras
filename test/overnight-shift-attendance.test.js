// Turnos que cruzan medianoche ("sereno", guardias 22:00-06:00, etc.).
//
// Bug real encontrado en una prueba de estres pre-venta (sept 2026): los
// fichajes se agrupaban por DIA CALENDARIO de CHECKTIME. La salida de una
// noche (ej. 06:05) cae en el MISMO dia calendario que la entrada de la
// noche siguiente (ej. 22:35) -- ese dia quedaba con dos marcas, y el motor
// tomaba la primera CRONOLOGICA (06:05, la salida de anoche) como si fuera
// la entrada de hoy. Una "entrada" de madrugada nunca puede llegar tarde
// respecto de un turno que arranca de noche -- una llegada tarde real a un
// turno de sereno quedaba invisible SIEMPRE, no como caso de borde. La
// columna shift_blocks.crosses_midnight ya existia en la base y en el admin
// de plantillas, pero ningun calculo la usaba. Ver el comentario de
// cabecera de reassignOvernightCheckins/stripOvernightCarryover en
// attendanceCalculations.js para la solucion completa.
//
// Este test arma un turno 22:00-06:00 real (crosses_midnight=1) con 3
// noches de fichajes, la 3ra con una llegada tarde real (22:35 en vez de
// 22:00), y verifica /attendance-range (Presentismo mensual/anual, el
// camino que de verdad usa la UI) y el motor diario
// (/api/labor-engine/attendance/:date).
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-overnight-shift-attendance';
// tenant_id descartable y fuera de rango real, igual que split-shift-attendance.test.js.
const TENANT_ID = 999997;

// Fechas YA CERRADAS (pasado real) -- /attendance-range recorta a "hasta
// hoy" en silencio. Tres noches consecutivas de un mismo sereno.
const NOCHE_1 = '2026-08-24'; // -> sale 25/08, a horario
const NOCHE_2 = '2026-08-25'; // -> sale 26/08, a horario
const NOCHE_3 = '2026-08-26'; // -> sale 27/08 -- ESTA es la que llega tarde (22:35)

let headers;
let db;
let employeeId;
let badge;
let userId;
let templateId;
// Segundo empleado, con horario NORMAL (no cruza medianoche) -- para
// confirmar que el fix no le cambia nada a quien no tiene turnos de sereno.
let normalEmployeeId;
let normalBadge;
let normalUserId;
let normalTemplateId;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306
  });

  const seed = Date.now() % 1000000;
  badge = 910000 + (seed % 40000);
  userId = 910000 + ((seed + 1) % 40000);
  normalBadge = 950000 + (seed % 40000);
  normalUserId = 950000 + ((seed + 1) % 40000);

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Sereno (test)', 'tenant-sereno-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  // ---- Empleado sereno ----
  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, '2020-01-01', 0)`,
    [badge, 'Empleado De Prueba Sereno', TENANT_ID]
  );
  employeeId = empResult.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, TENANT_ID, String(badge), 'Empleado De Prueba Sereno']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT_ID, employeeId]);

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)`,
    [TENANT_ID, 'Sereno (test)']
  );
  templateId = tplResult.insertId;
  for (let dow = 0; dow <= 6; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Guardia', '22:00:00', '06:00:00', 'WORK', 1, 1)`,
      [templateId, dow]
    );
  }
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, NULL)`,
    [employeeId, TENANT_ID, templateId, NOCHE_1]
  );

  const checkins = [
    [`${NOCHE_1} 22:05:00`],
    ['2026-08-25 06:05:00'],
    [`${NOCHE_2} 22:10:00`],
    ['2026-08-26 06:10:00'],
    [`${NOCHE_3} 22:35:00`], // LLEGA TARDE
    ['2026-08-27 06:05:00']
  ];
  for (const [checktime] of checkins) {
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [userId, TENANT_ID, checktime]);
  }

  // ---- Empleado con horario normal (control, no deberia verse afectado) ----
  const [normalEmpResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, '2020-01-01', 0)`,
    [normalBadge, 'Empleado De Prueba Horario Normal', TENANT_ID]
  );
  normalEmployeeId = normalEmpResult.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [normalUserId, TENANT_ID, String(normalBadge), 'Empleado De Prueba Horario Normal']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [normalUserId, TENANT_ID, normalEmployeeId]);

  const [normalTplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)`,
    [TENANT_ID, 'Horario normal (test)']
  );
  normalTemplateId = normalTplResult.insertId;
  for (let dow = 0; dow <= 6; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Trabajo', '08:00:00', '16:00:00', 'WORK', 0, 1)`,
      [normalTemplateId, dow]
    );
  }
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, NULL)`,
    [normalEmployeeId, TENANT_ID, normalTemplateId, NOCHE_1]
  );
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [normalUserId, TENANT_ID, `${NOCHE_3} 08:05:00`]);
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?)', [userId, normalUserId]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id IN (?, ?)', [employeeId, normalEmployeeId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id IN (?, ?)', [templateId, normalTemplateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id IN (?, ?)', [templateId, normalTemplateId]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [userId, normalUserId]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [userId, normalUserId]);
  await db.query('DELETE FROM employees WHERE id IN (?, ?)', [employeeId, normalEmployeeId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/attendance-range: turno de sereno a horario las primeras dos noches -> OnTime, con la salida real del dia siguiente', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${NOCHE_1}&to=2026-08-27&employeeId=${badge}&tenantId=${TENANT_ID}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const days = body.data[0].days;
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));

  assert.equal(byDate[NOCHE_1].status, 'OnTime');
  assert.equal(byDate[NOCHE_1].firstCheckin, '22:05');
  assert.equal(byDate[NOCHE_1].lastCheckin, '06:05'); // la salida real de la mañana siguiente, no un duplicado de la entrada

  assert.equal(byDate[NOCHE_2].status, 'OnTime');
  assert.equal(byDate[NOCHE_2].firstCheckin, '22:10');
  assert.equal(byDate[NOCHE_2].lastCheckin, '06:10');
});

test('/attendance-range: llegada tarde real (22:35) a un turno de sereno SE DETECTA -- antes quedaba invisible', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${NOCHE_1}&to=2026-08-27&employeeId=${badge}&tenantId=${TENANT_ID}`, { headers });
  const body = await res.json();
  const days = body.data[0].days;
  const dia = days.find(d => d.date === NOCHE_3);

  assert.ok(dia, 'deberia existir el dia de la 3ra noche en el rango');
  assert.equal(dia.firstCheckin, '22:35', 'la entrada detectada tiene que ser la marca de las 22:35, no la salida de la noche anterior (06:10)');
  assert.equal(dia.status, 'Late');
  assert.equal(dia.lateMinutes, 35);
});

test('/attendance-range: un empleado con horario NORMAL (no cruza medianoche) no se ve afectado por el fix', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${NOCHE_1}&to=2026-08-27&employeeId=${normalBadge}&tenantId=${TENANT_ID}`, { headers });
  const body = await res.json();
  const days = body.data[0].days;
  const dia = days.find(d => d.date === NOCHE_3);
  assert.equal(dia.status, 'OnTime');
  assert.equal(dia.firstCheckin, '08:05');
});

test('motor diario /api/labor-engine/attendance/:date: tambien detecta la llegada tarde del sereno', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${NOCHE_3}?tenantId=${TENANT_ID}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badge));

  assert.ok(row, 'deberia aparecer el empleado sereno en el motor diario');
  assert.equal(row.firstCheckin, `${NOCHE_3} 22:35:00`, 'el motor diario tambien tiene que tomar la marca de las 22:35 como entrada, no la salida de la noche anterior');
  assert.equal(row.status, 'Late');
});

test('motor diario /api/labor-engine/attendance/:date: el empleado con horario normal sigue OnTime', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${NOCHE_3}?tenantId=${TENANT_ID}`, { headers });
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(normalBadge));
  assert.ok(row);
  assert.equal(row.status, 'OnTime');
});
