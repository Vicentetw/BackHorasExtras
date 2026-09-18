// Etapa 2 del plan "Motor de reglas de asistencia configurable" (ver
// C:\angular\horasdedicacion-back-deploy\BackHorasExtras\fases para
// impletentar avance.txt) -- caracteriza el comportamiento ACTUAL de
// /attendance-range para los casos que la nueva capa de configuracion va a
// tocar de lleno (tolerancia, llegada/salida fuera de horario). El objetivo
// NO es corregir nada aca: es congelar lo que el sistema hace HOY para
// poder demostrar despues, con estos mismos tests, que el motor nuevo (en
// modo Legacy) sigue dando exactamente esto.
//
// Los demas casos minimos que pide la Etapa 2 (feriado, franco parcial via
// vacaciones, turno partido, nocturno/medianoche, autorizacion de HE,
// salida particular/oficial, fichaje incompleto/multiple) YA tienen su
// propio test de caracterizacion existente, no se duplican aca:
//   - feriado: holiday-absent-daily-motor.test.js, holiday-overnight-shift.test.js, holidays-by-ciudad.test.js
//   - turno partido (multiples tramos): split-shift-attendance.test.js
//   - nocturno / cruce de medianoche: overnight-shift-attendance.test.js, holiday-overnight-shift.test.js
//   - autorizacion de horas extra: overtime-authorization-mode.test.js, overtime-cap-alert.test.js
//   - salida particular / oficial: movements-calculations.test.js, attendance-range-particular-exit.test.js
//   - vacaciones / permiso (Excused): user-exclusions-range.test.js, user-exclusions-tenant-guard.test.js
//   - fichaje incompleto / rotacion de plantilla: rotating-schedule-attendance.test.js, attendance-inactive-employee.test.js
//
// Lo que SI falta y se cubre aca por primera vez (confirmado por auditoria,
// Etapa 1): el limite EXACTO de la tolerancia de entrada (hoy hardcodeada,
// resolveToleranceMinutes en attendanceCalculations.js), y el hecho de que
// HOY no existe ningun concepto de llegada anticipada ni salida anticipada
// -- ninguna de las dos genera incidencia ni cambia el status.
//
// Requiere que el backend local este corriendo (node horasdedica.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-characterization-2';
const TENANT_ID = 999966;

// Lunes reales ya cerrados (agosto 2026), ninguno feriado (San Martin cae
// el 17/08, se evita a proposito -- ver split-shift-attendance.test.js).
const DATE_BOUNDARY_OK = '2026-08-03'; // 09:07 -- dentro de tolerancia
const DATE_BOUNDARY_EDGE = '2026-08-10'; // 09:10 -- justo en el limite
const DATE_BOUNDARY_LATE = '2026-08-24'; // 09:11 -- fuera de tolerancia
const DATE_EARLY_ARRIVAL = '2026-08-31'; // ficha 08:30, horario 09:00
// Martes de esa misma semana (sin bloque WORK en la plantilla -- franco
// implicito, la plantilla solo define lunes).
const DATE_FRANCO = '2026-08-04';
// Salida anticipada: entra a horario, sale antes de las 13:00.
const DATE_EARLY_DEPARTURE = '2026-09-07'; // lunes

let headers;
let db;
let employeeId;
let badge;
let userId;
let templateId;

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
  badge = 990000 + (seed % 9000);
  userId = 990000 + ((seed + 1) % 9000);

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Caracterizacion Motor (test)', 'tenant-caracterizacion-motor-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, ?, ?, 0)`,
    [badge, 'Empleado De Prueba Caracterizacion', TENANT_ID]
  );
  employeeId = empResult.insertId;

  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, TENANT_ID, String(badge), 'Empleado De Prueba Caracterizacion']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT_ID, employeeId]);

  // FIXED (no FLEXIBLE) a proposito -- resolveToleranceMinutes da 10 min
  // fijo para FIXED, 60 para FLEXIBLE (attendanceCalculations.js). Un solo
  // bloque WORK 09:00-13:00, SOLO los lunes (day_of_week=1) -- el martes
  // queda sin bloques a proposito, para el caso de franco implicito.
  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)`,
    [TENANT_ID, 'Caracterizacion (test)']
  );
  templateId = tplResult.insertId;

  await db.query(
    `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active)
     VALUES (?, 1, 'Jornada', '09:00:00', '13:00:00', 'WORK', 1)`,
    [templateId]
  );

  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to)
     VALUES (?, ?, ?, '2026-01-01', NULL)`,
    [employeeId, TENANT_ID, templateId]
  );

  const checkins = [
    [DATE_BOUNDARY_OK, '09:07:00'], [DATE_BOUNDARY_OK, '13:00:00'],
    [DATE_BOUNDARY_EDGE, '09:10:00'], [DATE_BOUNDARY_EDGE, '13:00:00'],
    [DATE_BOUNDARY_LATE, '09:11:00'], [DATE_BOUNDARY_LATE, '13:00:00'],
    [DATE_EARLY_ARRIVAL, '08:30:00'], [DATE_EARLY_ARRIVAL, '13:00:00'],
    [DATE_EARLY_DEPARTURE, '09:00:00'], [DATE_EARLY_DEPARTURE, '12:55:00'],
  ];
  for (const [date, time] of checkins) {
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [userId, TENANT_ID, `${date} ${time}`]);
  }
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

async function fetchDay(date) {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=${date}&to=${date}&employeeId=${badge}`,
    { headers }
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((e) => String(e.employeeId) === String(badge));
  assert.ok(row, `legajo ${badge} debe aparecer en el reporte de ${date}`);
  const day = row.days.find((d) => d.date === date);
  assert.ok(day, `el dia ${date} debe aparecer en el detalle`);
  return day;
}

test('tolerancia (limite exacto, FIXED = 10 min): 09:07 con horario 09:00 -> dentro de tolerancia, NO tardanza', async () => {
  const day = await fetchDay(DATE_BOUNDARY_OK);
  assert.equal(day.status, 'OnTime');
  assert.equal(day.firstCheckin, '09:07');
});

test('tolerancia (limite exacto): 09:10 con horario 09:00 y tolerancia 10 -> justo en el limite, NO tardanza (comparacion es estrictamente mayor)', async () => {
  const day = await fetchDay(DATE_BOUNDARY_EDGE);
  assert.equal(day.status, 'OnTime');
  assert.equal(day.firstCheckin, '09:10');
});

test('tolerancia (limite exacto): 09:11 con horario 09:00 y tolerancia 10 -> supera el limite, SI tardanza', async () => {
  const day = await fetchDay(DATE_BOUNDARY_LATE);
  assert.equal(day.status, 'Late');
  // lateMinutes se mide contra el HORARIO (09:00), no contra el limite de
  // tolerancia (09:10) -- comportamiento real observado, no lo que se
  // hubiera esperado a priori. Documentado tal cual esta hoy.
  assert.equal(day.lateMinutes, 11);
});

test('llegada anticipada (08:30 con horario 09:00): HOY no existe ningun concepto de llegada anticipada -- status normal, sin incidencia ni HE reconocida', async () => {
  const day = await fetchDay(DATE_EARLY_ARRIVAL);
  assert.equal(day.status, 'OnTime');
  assert.equal(day.firstCheckin, '08:30');
  assert.equal(day.overtimeMinutes, 0, 'HOY el tiempo antes del horario no se reconoce como HE automaticamente');
});

test('salida anticipada (sale 12:55, horario hasta las 13:00): HOY no existe ningun concepto de salida anticipada -- status normal, sin incidencia', async () => {
  const day = await fetchDay(DATE_EARLY_DEPARTURE);
  assert.equal(day.status, 'OnTime');
  assert.equal(day.lastCheckin, '12:55');
});

test('franco implicito (dia de la semana sin bloques WORK en la plantilla) -> NonWorkDay', async () => {
  const day = await fetchDay(DATE_FRANCO);
  assert.equal(day.status, 'NonWorkDay');
});
