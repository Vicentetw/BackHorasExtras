// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #1 de la auditoria: un convenio asignado a un
// empleado no tenia NINGUN efecto en el calculo (day_type_overtime_rules.convention_id
// existia desde la Etapa 8 pero ningun llamador lo usaba para filtrar).
// De paso corrige un bug real encontrado al conectar esto: el filtro de
// reglas por empleado nunca chequeaba tenant_id, asi que una regla
// TENANT-scoped de una empresa podia colarse en el calculo de otra en un
// pedido cross-empresa (superadmin sin ?tenantId=).
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-convention-rules';
const TENANT_A = 999963;
const TENANT_B = 999962;
const DATE_SATURDAY = '2026-01-10'; // sabado

let headers;
let db;
let templateAId;
let templateBId;
let conventionXId;
const employees = {}; // key -> { employeeId, badge, userId, tenantId }

before(async () => {
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    dateStrings: true
  });

  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Convenio A (test)', 'tenant-convenio-a-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_A]);
  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Convenio B (test)', 'tenant-convenio-b-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_B]);
  // Superadmin SIN tenantId fijo en el token -- el propio test decide,
  // pedido a pedido, si manda ?tenantId= o no (para simular el caso
  // cross-empresa que expone el bug de fuga).
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });

  const [convX] = await db.query(`INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio X (test)', 1)`, [TENANT_A]);
  conventionXId = convX.insertId;

  const [tplA] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Plantilla Convenio A (test)', 'FIXED', 1, 0, 'shadow')`,
    [TENANT_A]
  );
  templateAId = tplA.insertId;
  const [tplB] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Plantilla Convenio B (test)', 'FIXED', 1, 0, 'shadow')`,
    [TENANT_B]
  );
  templateBId = tplB.insertId;

  for (const tplId of [templateAId, templateBId]) {
    // day_of_week = 6 (sabado)
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 6, 'Sabado', '09:00:00', '13:00:00', 'WORK', 1)`,
      [tplId]
    );
  }

  // Regla de dia scoped al CONVENIO X: sabado = HE al 75%, todo el dia,
  // sin requerir autorizacion.
  await db.query(
    `INSERT INTO day_type_overtime_rules (convention_id, day_type, trigger_type, rate, requires_authorization, active) VALUES (?, 'SATURDAY', 'ALL_DAY', 75, 0, 1)`,
    [conventionXId]
  );
  // Regla TENANT-scoped a proposito con una tasa absurda (999) para
  // TENANT_A -- si el bug de fuga de tenant_id no estuviera corregido,
  // esta regla se colaria en el calculo de un empleado de TENANT_B.
  await db.query(
    `INSERT INTO day_type_overtime_rules (tenant_id, day_type, trigger_type, rate, requires_authorization, active) VALUES (?, 'SATURDAY', 'ALL_DAY', 999, 0, 1)`,
    [TENANT_A]
  );

  const scenarios = [
    { key: 'conConvenio', tenantId: TENANT_A, templateId: templateAId, conventionId: conventionXId },
    { key: 'sinConvenio', tenantId: TENANT_A, templateId: templateAId, conventionId: null },
    { key: 'otroTenant', tenantId: TENANT_B, templateId: templateBId, conventionId: null }
  ];

  const seed = Date.now() % 1000000;
  let offset = 0;
  for (const scenario of scenarios) {
    const badge = 600000 + ((seed + offset) % 90000);
    const userId = 600000 + ((seed + offset + 1) % 90000);
    offset += 2;

    const [empResult] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, ?, ?, 0)`,
      [badge, `Empleado Convenio ${scenario.key} (test)`, scenario.tenantId]
    );
    const employeeId = empResult.insertId;
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
      [userId, scenario.tenantId, String(badge), `Empleado Convenio ${scenario.key} (test)`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
      [userId, scenario.tenantId, employeeId]);
    await db.query(
      `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`,
      [employeeId, scenario.tenantId, scenario.templateId]
    );
    if (scenario.conventionId) {
      await db.query(
        `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`,
        [employeeId, scenario.tenantId, scenario.conventionId]
      );
    }
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`, [
      userId, scenario.tenantId, `${DATE_SATURDAY} 09:00:00`,
      userId, scenario.tenantId, `${DATE_SATURDAY} 13:00:00`
    ]);

    employees[scenario.key] = { employeeId, badge, userId, tenantId: scenario.tenantId };
  }
});

after(async () => {
  for (const { userId, employeeId } of Object.values(employees)) {
    await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM employee_convention_assignments WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  }
  await db.query('DELETE FROM day_type_overtime_rules WHERE convention_id = ? OR tenant_id IN (?, ?)', [conventionXId, TENANT_A, TENANT_B]);
  for (const tplId of [templateAId, templateBId]) {
    await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [tplId]);
    await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [tplId]);
  }
  await db.query('DELETE FROM labor_conventions WHERE id = ?', [conventionXId]);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('HALLAZGO #1 corregido: empleado CON convenio asignado -> la regla de HE del convenio SI se aplica en el motor nuevo', async () => {
  const { badge } = employees.conConvenio;
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&tenantId=${TENANT_A}&employeeId=${badge}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SATURDAY);
  assert.ok(day.shadowResult, 'debe haber shadowResult (plantilla en modo shadow)');
  assert.equal(day.shadowResult.engine.overtimeMinutes, 240, 'las 4 horas del sabado pasan a HE por la regla del convenio');
  const overtimeSeg = day.shadowResult.engine.classifiedSegments.find((s) => s.type === 'OVERTIME');
  assert.equal(overtimeSeg.rate, 75, 'la tasa es la del CONVENIO (75), no la generica de tenant (999)');
});

test('HALLAZGO #1 corregido: empleado SIN convenio, mismo tenant -> usa la regla generica del TENANT (999), no la del convenio (que no le corresponde)', async () => {
  // Confirma el desempate por especificidad END TO END (no solo a nivel
  // resolver puro, ya probado en day-type-rule-resolver.test.js): con
  // AMBAS reglas candidatas (convenio Y tenant) presentes en la base,
  // este empleado -- sin convenio asignado -- debe caer en la generica
  // del tenant, nunca en la del convenio ajeno.
  const { badge } = employees.sinConvenio;
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&tenantId=${TENANT_A}&employeeId=${badge}`, { headers });
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SATURDAY);
  assert.ok(day.shadowResult);
  assert.equal(day.shadowResult.engine.overtimeMinutes, 240, 'la regla generica del tenant SI le aplica (no tiene una mas especifica)');
  const overtimeSeg = day.shadowResult.engine.classifiedSegments.find((s) => s.type === 'OVERTIME');
  assert.equal(overtimeSeg.rate, 999, 'la tasa generica del tenant, no la del convenio X (no le corresponde)');
});

test('Bug real corregido al conectar convenios: una regla TENANT-scoped de OTRA empresa no debe colarse en un pedido cross-empresa (superadmin sin ?tenantId=)', async () => {
  const { badge } = employees.otroTenant;
  // A PROPOSITO sin ?tenantId= -- superadmin viendo TODAS las empresas a
  // la vez, el escenario real donde la fuga podia pasar.
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SATURDAY);
  assert.ok(day.shadowResult, 'esta plantilla tambien esta en modo shadow');
  assert.equal(day.shadowResult.engine.overtimeMinutes, 0, 'la regla de TENANT_A (rate=999) NO debe aplicarle a un empleado de TENANT_B');
});
