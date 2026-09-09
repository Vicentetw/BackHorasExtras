// Turno partido / visitas multiples en un mismo dia (profesor que da clase a
// la mañana y a la tarde, medico que atiende en dos horarios -- "va 4 veces
// a la escuela"). Antes, buildScheduleFromBlocks() (scheduleRepository.js)
// aplastaba TODOS los bloques WORK de un dia en un unico par entrada/salida
// (primer inicio, ultimo fin), y el motor solo evaluaba el primer fichaje
// del dia contra esa unica referencia -- una plantilla con dos bloques WORK
// (08-12 y 16-21) se comportaba como si fuera un solo turno 08-21 con un
// "hueco" invisible en el medio. Ver evaluateMultiVisitDay en
// attendanceCalculations.js.
//
// Este test arma una plantilla con turno partido real (bloques WORK 08-12 y
// 16-21 un mismo dia de semana) y fichajes de prueba para 4 lunes distintos,
// verificando /attendance-range (Presentismo, el camino que de verdad usa la
// UI) y el motor diario (/api/labor-engine/attendance/:date).
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-split-shift-attendance';
// tenant_id descartable y fuera de rango real, igual que ya hace
// calendar-tenant-guard.test.js -- no infla el conteo de empleados de otros
// archivos de test que corren en paralelo (node --test).
const TENANT_ID = 999998;

// Los 4 lunes tienen que ser fechas YA CERRADAS (pasado real, no futuro) --
// /attendance-range recorta el rango consultado a "hasta hoy" en silencio,
// asi que una fecha futura simplemente desaparece de row.days sin avisar.
// 2026-08-17 se descarta a proposito: es un feriado real (San Martin).
const DATE_COMPLETE = '2026-07-27'; // las dos visitas, a tiempo
const DATE_LATE = '2026-08-03'; // llega tarde a la 1ra visita, completa las dos
const DATE_MISSING_SALIDA = '2026-08-10'; // le falta marcar la salida de la 2da visita
const DATE_MISSING_VISIT = '2026-08-24'; // no fue en absoluto a la 2da visita

let headers;
let db;
let employeeId; // employees.id (PK)
let badge; // employees.employee_id (legajo) -- string para comparar contra la API
let userId; // users.USERID
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
  badge = 900000 + (seed % 90000);
  userId = 900000 + ((seed + 1) % 90000);

  // users/user_employee_map ya exigen tenant_id NOT NULL con FK real hacia
  // tenants (migracion 20260909) -- antes alcanzaba con el tenant_id
  // descartable en employees (sin FK); ahora hace falta la fila real.
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Split Shift (test)', 'tenant-split-shift-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, ?, ?, 0)`,
    [badge, 'Empleado De Prueba Turno Partido', TENANT_ID]
  );
  employeeId = empResult.insertId;

  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, TENANT_ID, String(badge), 'Empleado De Prueba Turno Partido']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT_ID, employeeId]);

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)`,
    [TENANT_ID, 'Turno partido (test)']
  );
  templateId = tplResult.insertId;

  // day_of_week = 1 (lunes) -- las 4 fechas de prueba son todas lunes.
  await db.query(
    `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active)
     VALUES (?, 1, 'Mañana', '08:00:00', '12:00:00', 'WORK', 1),
            (?, 1, 'Tarde', '16:00:00', '21:00:00', 'WORK', 1)`,
    [templateId, templateId]
  );

  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to)
     VALUES (?, ?, ?, ?, NULL)`,
    [employeeId, TENANT_ID, templateId, DATE_COMPLETE]
  );

  const checkins = [
    [DATE_COMPLETE, '08:02:00'], [DATE_COMPLETE, '12:00:00'], [DATE_COMPLETE, '16:00:00'], [DATE_COMPLETE, '21:05:00'],
    [DATE_LATE, '08:30:00'], [DATE_LATE, '12:00:00'], [DATE_LATE, '16:00:00'], [DATE_LATE, '21:00:00'],
    [DATE_MISSING_SALIDA, '08:00:00'], [DATE_MISSING_SALIDA, '12:00:00'], [DATE_MISSING_SALIDA, '16:00:00'],
    [DATE_MISSING_VISIT, '08:00:00'], [DATE_MISSING_VISIT, '12:00:00']
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

test('/attendance-range: turno partido completo y a tiempo -> OnTime, sin parcialidad', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-07-20&to=2026-08-31&employeeId=${badge}`,
    { headers }
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  assert.ok(row, 'la fila del empleado de prueba debe existir en el reporte');
  assert.equal(row.partialAbsence, 2, 'las otras 2 fechas de prueba son Ausente Parcial');

  const dayComplete = row.days.find((d) => d.date === DATE_COMPLETE);
  assert.equal(dayComplete.status, 'OnTime');
  assert.equal(dayComplete.visits.length, 2);
  assert.equal(dayComplete.visits[0].missing, 'none');
  assert.equal(dayComplete.visits[1].missing, 'none');
});

test('/attendance-range: llega tarde a la 1ra visita pero completa las dos -> Late, sin parcialidad', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-07-20&to=2026-08-31&employeeId=${badge}`,
    { headers }
  );
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const dayLate = row.days.find((d) => d.date === DATE_LATE);
  assert.equal(dayLate.status, 'Late');
  assert.equal(dayLate.lateMinutes, 30);
});

test('/attendance-range: falta la salida de la 2da visita -> Ausente parcial, detalle marca cual visita', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-07-20&to=2026-08-31&employeeId=${badge}`,
    { headers }
  );
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_MISSING_SALIDA);
  assert.equal(day.status, 'PartialAbsence');
  assert.equal(day.visits[0].missing, 'none');
  assert.equal(day.visits[1].missing, 'salida');
});

test('/attendance-range: no fue en absoluto a la 2da visita -> Ausente parcial', async () => {
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-07-20&to=2026-08-31&employeeId=${badge}`,
    { headers }
  );
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_MISSING_VISIT);
  assert.equal(day.status, 'PartialAbsence');
  assert.equal(day.visits[0].missing, 'none');
  assert.equal(day.visits[1].missing, 'both');
});

test('motor diario /api/labor-engine/attendance/:date: mismo resultado que /attendance-range para el dia completo', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${DATE_COMPLETE}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const entry = json.attendance.find((a) => String(a.employeeId) === String(badge));
  assert.ok(entry, 'el empleado de prueba debe aparecer en el motor diario');
  assert.equal(entry.status, 'OnTime');
  assert.equal(entry.visits.length, 2);
});

test('motor diario /api/labor-engine/attendance/:date: dia con visita incompleta -> PartialAbsence, y suma en el resumen', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${DATE_MISSING_SALIDA}`, { headers });
  const json = await res.json();
  const entry = json.attendance.find((a) => String(a.employeeId) === String(badge));
  assert.equal(entry.status, 'PartialAbsence');
  assert.equal(entry.visits[1].missing, 'salida');
  assert.ok(json.summary.partialAbsence >= 1);
});
