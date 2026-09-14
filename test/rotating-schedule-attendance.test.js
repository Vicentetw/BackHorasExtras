// Horarios rotativos: un empleado que alterna de plantilla segun la fecha
// (ej. semana de mañana / semana de tarde), vía employee_work_calendars con
// varias filas de vigencia (valid_from/valid_to) para el MISMO empleado. No
// es un bug encontrado -- es la verificacion (parte de la prueba de estres
// pre-venta, sept 2026) de que scheduleRepository.findAssignedCalendarRowsForRange
// resuelve la plantilla correcta segun la fecha, no solo la primera o la
// mas reciente.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-rotating-schedule-attendance';
const TENANT_ID = 999996;

// Dos semanas completas, YA CERRADAS (pasado real).
const SEMANA_1_DESDE = '2026-08-03'; // lunes -- plantilla A (mañana, 08-16)
const SEMANA_1_HASTA = '2026-08-09'; // domingo
const SEMANA_2_DESDE = '2026-08-10'; // lunes -- plantilla B (tarde, 14-22)
const SEMANA_2_HASTA = '2026-08-16'; // domingo

let headers;
let db;
let employeeId;
let badge;
let userId;
let templateA;
let templateB;

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
  badge = 920000 + (seed % 30000);
  userId = 920000 + ((seed + 1) % 30000);

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Rotativo (test)', 'tenant-rotativo-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, '2020-01-01', 0)`,
    [badge, 'Empleado De Prueba Rotativo', TENANT_ID]
  );
  employeeId = empResult.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, TENANT_ID, String(badge), 'Empleado De Prueba Rotativo']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT_ID, employeeId]);

  const [tplA] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'ROTATIVE', 1, 0)`,
    [TENANT_ID, 'Turno Mañana (test)']
  );
  templateA = tplA.insertId;
  const [tplB] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'ROTATIVE', 1, 0)`,
    [TENANT_ID, 'Turno Tarde (test)']
  );
  templateB = tplB.insertId;

  for (let dow = 1; dow <= 5; dow++) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Mañana', '08:00:00', '16:00:00', 'WORK', 1)`, [templateA, dow]);
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Tarde', '14:00:00', '22:00:00', 'WORK', 1)`, [templateB, dow]);
  }

  await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`,
    [employeeId, TENANT_ID, templateA, SEMANA_1_DESDE, SEMANA_1_HASTA]);
  await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`,
    [employeeId, TENANT_ID, templateB, SEMANA_2_DESDE, SEMANA_2_HASTA]);

  // Semana 1: fichaje 08:05 (a horario para la plantilla A).
  for (const d of ['03', '04', '05', '06', '07']) {
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [userId, TENANT_ID, `2026-08-${d} 08:05:00`]);
  }
  // Semana 2: fichaje 14:05 (a horario para la plantilla B). Si el motor
  // siguiera usando la plantilla A, esto daria "Late" (llegaria 6hs tarde
  // respecto de un 08:00 esperado).
  for (const d of ['10', '11', '12', '13', '14']) {
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [userId, TENANT_ID, `2026-08-${d} 14:05:00`]);
  }
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id IN (?, ?)', [templateA, templateB]);
  await db.query('DELETE FROM work_schedule_templates WHERE id IN (?, ?)', [templateA, templateB]);
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/attendance-range: semana 1 usa la plantilla de mañana (08:00) -> OnTime', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${SEMANA_1_DESDE}&to=${SEMANA_1_HASTA}&employeeId=${badge}&tenantId=${TENANT_ID}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const days = body.data[0].days.filter(d => d.status !== 'NonWorkDay');
  assert.ok(days.length > 0);
  for (const d of days) assert.equal(d.status, 'OnTime', `${d.date} deberia ser OnTime con la plantilla de mañana`);
});

test('/attendance-range: semana 2 rota a la plantilla de tarde (14:00) -> OnTime, NO Late', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${SEMANA_2_DESDE}&to=${SEMANA_2_HASTA}&employeeId=${badge}&tenantId=${TENANT_ID}`, { headers });
  const body = await res.json();
  const days = body.data[0].days.filter(d => d.status !== 'NonWorkDay');
  assert.ok(days.length > 0);
  for (const d of days) assert.equal(d.status, 'OnTime', `${d.date} deberia ser OnTime con la plantilla de tarde (si diera Late, el motor seguiria usando la plantilla vieja)`);
});
