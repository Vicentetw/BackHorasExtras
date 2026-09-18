// Bug real reportado (empresa AVP, superadmin): empleados administrativos
// de lunes a viernes aparecian como "Ausente" en el Presentismo DIARIO
// incluso el dia de un feriado recien cargado.
//
// Causa raiz: motor-laboral/services/attendanceService.js -> buildAttendance()
// solo consultaba `isHoliday` DENTRO del bloque "hubo fichajes" (para poner
// 'WorkedHoliday'). En el bloque "NO hubo fichajes" no existia ninguna rama
// para feriado -- el status se quedaba en el 'Absent' inicial sin importar
// que fuera un feriado. /attendance-range (Presentismo mensual/anual) y el
// motor legacy de un solo dia SI resolvian esto bien -- la asimetria era
// solo en este motor diario (el que usa Presentismo por defecto).
//
// Segundo bug encontrado de paso: motor-laboral/repositories/holidayRepository.js
// recibia tenantId pero nunca lo usaba en el WHERE -- el feriado de
// CUALQUIER empresa contaba como feriado para todas. Se agrega un tercer
// tenant sin feriado para confirmar que ya no "hereda" el feriado ajeno.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-holiday-absent-daily-motor';
// tenant_id descartable y fuera de rango real. TENANT_A tiene el feriado,
// TENANT_B (sin feriado propio) es el control de aislamiento.
const TENANT_A = 999940;
const TENANT_B = 999941;
const FERIADO = '2026-08-20'; // jueves -- dia laborable normal para el horario de prueba

let headers;
let db;

// Tenant A: un empleado SIN fichar el feriado, otro CON fichaje ese mismo dia.
let empSinFicharId, badgeSinFichar, userSinFichar, tplA;
let empConFicharId, badgeConFichar, userConFichar;
// Tenant B: mismo horario, SIN feriado propio -- control de aislamiento.
let empControlId, badgeControl, userControl, tplB;

async function seedTenantConEmpleado(tenantId, nombreTpl, badge, userId, nombreEmpleado) {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [tenantId, `Tenant Feriado (test) ${tenantId}`, `tenant-feriado-test-${tenantId}`]
  );
  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, '2020-01-01', 0)`,
    [badge, nombreEmpleado, tenantId]
  );
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, tenantId, String(badge), nombreEmpleado]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, tenantId, empResult.insertId]);

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)`,
    [tenantId, nombreTpl]
  );
  for (let dow = 0; dow <= 6; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Administrativo', '08:00:00', '16:00:00', 'WORK', 0, 1)`,
      [tplResult.insertId, dow]
    );
  }
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`,
    [empResult.insertId, tenantId, tplResult.insertId]
  );
  return { employeeId: empResult.insertId, templateId: tplResult.insertId };
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

  const seed = Date.now() % 1000000;
  badgeSinFichar = 920000 + (seed % 30000);
  userSinFichar = 920000 + ((seed + 1) % 30000);
  badgeConFichar = 923000 + (seed % 30000);
  userConFichar = 923000 + ((seed + 1) % 30000);
  badgeControl = 926000 + (seed % 30000);
  userControl = 926000 + ((seed + 1) % 30000);

  const sinFichar = await seedTenantConEmpleado(TENANT_A, 'Administrativo A (test)', badgeSinFichar, userSinFichar, 'Administrativo Sin Fichar');
  empSinFicharId = sinFichar.employeeId;
  tplA = sinFichar.templateId;

  const conFichar = await seedTenantConEmpleado(TENANT_A, 'Administrativo A (test) 2', badgeConFichar, userConFichar, 'Administrativo Con Fichaje');
  empConFicharId = conFichar.employeeId;
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`,
    [userConFichar, TENANT_A, `${FERIADO} 08:02:00`]);

  const control = await seedTenantConEmpleado(TENANT_B, 'Administrativo B (test)', badgeControl, userControl, 'Administrativo Tenant Sin Feriado');
  empControlId = control.employeeId;
  tplB = control.templateId;

  // Feriado SOLO para TENANT_A -- isWorkDay=0 (dia no laborable real), no recurrente.
  await db.query(
    `INSERT INTO holidays (tenant_id, date, year, name, description, type, isWorkDay, recurring)
     VALUES (?, ?, 2026, 'Feriado de prueba', 'Feriado de prueba', 'LOCAL', 0, 0)`,
    [TENANT_A, FERIADO]
  );
});

after(async () => {
  await db.query('DELETE FROM holidays WHERE tenant_id = ? AND date = ?', [TENANT_A, FERIADO]);
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?, ?)', [userSinFichar, userConFichar, userControl]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id IN (?, ?, ?)', [empSinFicharId, empConFicharId, empControlId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id IN (?, ?)', [tplA, tplB]);
  await db.query('DELETE FROM work_schedule_templates WHERE id IN (?, ?)', [tplA, tplB]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?, ?)', [userSinFichar, userConFichar, userControl]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?, ?)', [userSinFichar, userConFichar, userControl]);
  await db.query('DELETE FROM employees WHERE id IN (?, ?, ?)', [empSinFicharId, empConFicharId, empControlId]);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('motor diario: empleado administrativo SIN fichar en un feriado -> HolidayAbsent, no Absent', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO}?tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeSinFichar));

  assert.ok(row, 'deberia aparecer el empleado administrativo en el motor diario');
  assert.equal(row.status, 'HolidayAbsent', 'un feriado sin fichajes no deberia contar como Ausente');
});

test('motor diario: empleado que SI trabajo el feriado sigue marcado WorkedHoliday (no se rompio por el fix)', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO}?tenantId=${TENANT_A}`, { headers });
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeConFichar));

  assert.ok(row);
  assert.equal(row.status, 'WorkedHoliday');
});

test('el resumen del dia no cuenta el feriado como Absent', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO}?tenantId=${TENANT_A}`, { headers });
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeSinFichar));
  assert.notEqual(row.status, 'Absent');
  assert.equal(body.summary.absent, 0, 'ningun empleado de este tenant deberia contar como Absent ese dia');
});

test('aislamiento por tenant: una empresa SIN feriado propio no hereda el feriado de otra empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${FERIADO}?tenantId=${TENANT_B}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.attendance.find(a => String(a.employeeId) === String(badgeControl));

  assert.ok(row, 'deberia aparecer el empleado control en el motor diario');
  // Sin fichajes y SIN feriado propio para este tenant -- esto SI es una
  // ausencia real (no debe salir HolidayAbsent tomando prestado el feriado
  // de TENANT_A).
  assert.equal(row.status, 'Absent');
});
