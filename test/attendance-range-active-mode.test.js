// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #5 de la auditoria: hasta ahora, 'active' definia
// un ENUM sin ningun efecto de codigo (ponerlo se comportaba igual que
// 'legacy'). Esta es la parte de mayor riesgo de toda la iniciativa: en
// modo 'active', el resultado del motor nuevo pasa a ser el OFICIAL
// (status/lateMinutes/overtimeMinutes/etc, los mismos campos de
// siempre, ver Etapa 4 del plan) -- afecta calculo real de horas
// extra/sueldos, por eso se prueba de punta a punta, incluyendo el
// AGREGADO por fila (no solo el detalle de un dia), no solo el modulo
// puro.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-active-mode';
const TENANT_ID = 999960;

const DATE_TOLERANCE = '2026-01-12'; // lunes
const DATE_SATURDAY = '2026-01-17'; // sabado
const DATE_PLAIN = '2026-01-19'; // lunes, sin ninguna configuracion especial

let headers;
let db;
let templateToleranceId;
let templateSaturdayId;
let templatePlainId;
const employees = {}; // key -> { employeeId, badge, userId }

before(async () => {
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    dateStrings: true
  });

  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Active Mode (test)', 'tenant-active-mode-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_ID]);
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true, tenantId: TENANT_ID });

  const [tplTolerance] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode, tolerancia_entrada_minutos)
     VALUES (?, 'Active con tolerancia (test)', 'FIXED', 1, 0, 'active', 20)`,
    [TENANT_ID]
  );
  templateToleranceId = tplTolerance.insertId;
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '09:00:00', '18:00:00', 'WORK', 1)`, [templateToleranceId]);

  const [tplSaturday] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Active sabado HE (test)', 'FIXED', 1, 0, 'active')`,
    [TENANT_ID]
  );
  templateSaturdayId = tplSaturday.insertId;
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 6, 'Sabado', '09:00:00', '13:00:00', 'WORK', 1)`, [templateSaturdayId]);
  await db.query(
    `INSERT INTO day_type_overtime_rules (tenant_id, day_type, trigger_type, rate, requires_authorization, active) VALUES (?, 'SATURDAY', 'ALL_DAY', 75, 0, 1)`,
    [TENANT_ID]
  );

  const [tplPlain] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Active sin config especial (test)', 'FIXED', 1, 0, 'active')`,
    [TENANT_ID]
  );
  templatePlainId = tplPlain.insertId;
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '09:00:00', '18:00:00', 'WORK', 1)`, [templatePlainId]);

  const scenarios = [
    { key: 'tolerancia', date: DATE_TOLERANCE, templateId: templateToleranceId, checkinTime: '09:15:00', checkoutTime: '18:00:00' },
    { key: 'sabado', date: DATE_SATURDAY, templateId: templateSaturdayId, checkinTime: '09:00:00', checkoutTime: '13:00:00' },
    { key: 'plain', date: DATE_PLAIN, templateId: templatePlainId, checkinTime: '09:00:00', checkoutTime: '18:00:00' }
  ];

  const seed = Date.now() % 1000000;
  let offset = 0;
  for (const scenario of scenarios) {
    const badge = 500000 + ((seed + offset) % 90000);
    const userId = 500000 + ((seed + offset + 1) % 90000);
    offset += 2;

    const [empResult] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, ?, ?, 0)`,
      [badge, `Empleado Active Mode ${scenario.key} (test)`, TENANT_ID]
    );
    const employeeId = empResult.insertId;
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
      [userId, TENANT_ID, String(badge), `Empleado Active Mode ${scenario.key} (test)`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
      [userId, TENANT_ID, employeeId]);
    await db.query(
      `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`,
      [employeeId, TENANT_ID, scenario.templateId]
    );
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`, [
      userId, TENANT_ID, `${scenario.date} ${scenario.checkinTime}`,
      userId, TENANT_ID, `${scenario.date} ${scenario.checkoutTime}`
    ]);

    employees[scenario.key] = { employeeId, badge, userId };
  }
});

after(async () => {
  for (const { userId, employeeId } of Object.values(employees)) {
    await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  }
  await db.query('DELETE FROM day_type_overtime_rules WHERE tenant_id = ?', [TENANT_ID]);
  for (const tplId of [templateToleranceId, templateSaturdayId, templatePlainId]) {
    await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [tplId]);
    await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [tplId]);
  }
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('HALLAZGO #5 corregido: modo active CON tolerancia configurada -> el resultado OFICIAL (no solo informativo) refleja al motor nuevo', async () => {
  const { badge } = employees.tolerancia;
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&tenantId=${TENANT_ID}&employeeId=${badge}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_TOLERANCE);

  // Con Legacy (tolerancia fija de 10 min) esto seria 'Late'. En modo
  // 'active', con tolerancia de 20 min configurada, el resultado
  // OFICIAL debe ser 'OnTime' -- no un dato aparte, el campo `status` de
  // siempre.
  assert.equal(day.status, 'OnTime', 'el status OFICIAL debe reflejar la tolerancia de 20 min del motor nuevo');
  assert.equal(day.lateMinutes, 0);
  assert.equal(row.late, 0, 'el contador agregado de tardanzas de la fila tambien debe reflejarlo, no solo el detalle del dia');

  // shadowResult NO aplica a este modo (no hay "Legacy oficial" contra
  // que comparar); engineExplanation SI debe estar presente.
  assert.equal(day.shadowResult, null);
  assert.ok(day.engineExplanation, 'debe poder explicarse por que se clasifico asi');
});

test('HALLAZGO #5 corregido: modo active CON regla de dia (sabado 75%) -> overtimeMinutes OFICIAL y overtimeHours agregado reflejan al motor nuevo', async () => {
  const { badge } = employees.sabado;
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&tenantId=${TENANT_ID}&employeeId=${badge}`, { headers });
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SATURDAY);

  assert.equal(day.overtimeMinutes, 240, 'las 4 horas del sabado pasan a HE por la regla del tipo de dia -- resultado OFICIAL');
  assert.equal(day.overtimeSource, 'engine');
  assert.equal(row.overtimeHours, '4.00', 'el agregado de horas extra de la fila (usado en reportes) tambien lo refleja');
  const overtimeSeg = day.engineExplanation.classifiedSegments.find((s) => s.type === 'OVERTIME');
  assert.equal(overtimeSeg.rate, 75);
});

test('modo active SIN ninguna configuracion especial: el resultado coincide con lo que Legacy hubiera dado (mismo horario, mismo fichaje exacto)', async () => {
  const { badge } = employees.plain;
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&tenantId=${TENANT_ID}&employeeId=${badge}`, { headers });
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_PLAIN);

  assert.equal(day.status, 'OnTime');
  assert.equal(day.overtimeMinutes, 0);
  assert.equal(day.lateMinutes, 0);
});
