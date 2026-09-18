// Pregunta real: el fix de "feriado sin fichajes = Absent" (ver
// holiday-absent-daily-motor.test.js) y el fix de turnos que cruzan
// medianoche ("sereno", ver overnight-shift-attendance.test.js) se
// arreglaron en momentos distintos -- este test confirma que COMPONEN bien
// juntos: un sereno que trabaja la noche de un feriado, y otro que esa
// noche no fue.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-holiday-overnight-shift';
const TENANT_ID = 999942;
const FERIADO = '2026-08-18'; // martes -- el sereno deberia trabajar esa noche igual

let headers, db, templateId;
let empTrabajoId, badgeTrabajo, userTrabajo; // sereno que SI hizo la guardia del feriado
let empFaltoId, badgeFalto, userFalto; // sereno que esa noche NO fue

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
  badgeTrabajo = 930000 + (seed % 20000);
  userTrabajo = 930000 + ((seed + 1) % 20000);
  badgeFalto = 933000 + (seed % 20000);
  userFalto = 933000 + ((seed + 1) % 20000);

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Sereno Feriado (test)', 'tenant-sereno-feriado-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Sereno (test)', 'FIXED', 1, 0)`,
    [TENANT_ID]
  );
  templateId = tplResult.insertId;
  for (let dow = 0; dow <= 6; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Guardia', '22:00:00', '06:00:00', 'WORK', 1, 1)`,
      [templateId, dow]
    );
  }

  const [empTrabajo] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Sereno Que Trabajo El Feriado', ?, '2020-01-01', 0)`,
    [badgeTrabajo, TENANT_ID]
  );
  empTrabajoId = empTrabajo.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Sereno Que Trabajo El Feriado')`,
    [userTrabajo, TENANT_ID, String(badgeTrabajo)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userTrabajo, TENANT_ID, empTrabajoId]);
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`,
    [empTrabajoId, TENANT_ID, templateId]
  );
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [userTrabajo, TENANT_ID, `${FERIADO} 22:05:00`]);
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`, [userTrabajo, TENANT_ID, '2026-08-19 06:05:00']);

  const [empFalto] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Sereno Que Falto El Feriado', ?, '2020-01-01', 0)`,
    [badgeFalto, TENANT_ID]
  );
  empFaltoId = empFalto.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Sereno Que Falto El Feriado')`,
    [userFalto, TENANT_ID, String(badgeFalto)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userFalto, TENANT_ID, empFaltoId]);
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`,
    [empFaltoId, TENANT_ID, templateId]
  );
  // Sin checkins para este empleado esa noche -- a proposito.

  await db.query(
    `INSERT INTO holidays (tenant_id, date, year, name, description, type, isWorkDay, recurring)
     VALUES (?, ?, 2026, 'Feriado de prueba (sereno)', 'Feriado de prueba', 'LOCAL', 0, 0)`,
    [TENANT_ID, FERIADO]
  );
});

after(async () => {
  await db.query('DELETE FROM holidays WHERE tenant_id = ? AND date = ?', [TENANT_ID, FERIADO]);
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?)', [userTrabajo, userFalto]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id IN (?, ?)', [empTrabajoId, empFaltoId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [userTrabajo, userFalto]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [userTrabajo, userFalto]);
  await db.query('DELETE FROM employees WHERE id IN (?, ?)', [empTrabajoId, empFaltoId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('sereno que SI hizo la guardia del feriado -> WorkedHoliday, con la entrada real de las 22:05', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO}?tenantId=${TENANT_ID}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeTrabajo));

  assert.ok(row, 'deberia aparecer el sereno que trabajo');
  assert.equal(row.status, 'WorkedHoliday');
  assert.equal(row.firstCheckin, `${FERIADO} 22:05:00`, 'la entrada de la guardia, no una salida de otra noche');
});

test('sereno que NO hizo la guardia del feriado -> HolidayAbsent, no Absent a secas', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO}?tenantId=${TENANT_ID}`, { headers });
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeFalto));

  assert.ok(row, 'deberia aparecer el sereno que falto');
  assert.equal(row.status, 'HolidayAbsent');
});
