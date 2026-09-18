// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #3 de la auditoria de punta a punta: cambiar la
// tolerancia de una plantilla HOY no debe alterar el recalculo (modo
// sombra) de una fecha YA PASADA -- debe seguir usando la configuracion
// que regia en su momento.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-template-config-history';
const TENANT_ID = 999964;
const DATE_PAST = '2026-01-12'; // lunes, muy anterior a "hoy" -- ya cerrado

let headers;
let db;
let templateId;
let employeeId;
let badge;
let userId;

before(async () => {
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    dateStrings: true
  });

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Historial Template (test)', 'tenant-historial-template-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true, tenantId: TENANT_ID });

  // created_at viejo A PROPOSITO -- representa una plantilla que existe
  // desde antes de DATE_PAST, sin tolerancia configurada todavia (NULL =
  // cae al fallback legacy de 10 min).
  const [tpl] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode, created_at)
     VALUES (?, 'Plantilla Historial E2E (test)', 'FIXED', 1, 0, 'shadow', '2026-01-01 00:00:00')`,
    [TENANT_ID]
  );
  templateId = tpl.insertId;
  await db.query(
    `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '09:00:00', '18:00:00', 'WORK', 1)`,
    [templateId]
  );

  const seed = Date.now() % 1000000;
  badge = 700000 + (seed % 90000);
  userId = 700000 + ((seed + 1) % 90000);

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, 'Empleado Historial E2E (test)', ?, 0)`,
    [badge, TENANT_ID]
  );
  employeeId = empResult.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Empleado Historial E2E (test)')`,
    [userId, TENANT_ID, String(badge)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT_ID, employeeId]);
  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`,
    [employeeId, TENANT_ID, templateId]
  );
  // 15 minutos tarde respecto del horario de entrada (09:00) -- tarde
  // segun la tolerancia legacy de 10 min, A TIEMPO segun una tolerancia
  // de 20 min (la que se va a cargar DESPUES, ver el test).
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`, [
    userId, TENANT_ID, `${DATE_PAST} 09:15:00`,
    userId, TENANT_ID, `${DATE_PAST} 18:00:00`
  ]);
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
  await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  await db.query('DELETE FROM work_schedule_template_config_history WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('antes de cualquier cambio: modo sombra usa el fallback legacy (10 min) -> 15 min tarde SI es tardanza para el motor nuevo tambien', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`, { headers });
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_PAST);
  assert.ok(day.shadowResult);
  const classificationDiff = day.shadowResult.diffs.find((d) => d.field === 'classifications');
  assert.equal(classificationDiff, undefined, 'sin tolerancia configurada, Legacy y el motor nuevo coinciden -- ambos dicen Late');
});

test('HALLAZGO #3 corregido: cambiar la tolerancia HOY a 20 min NO debe alterar el recalculo de la fecha pasada (sigue usando el fallback legacy vigente en su momento)', async () => {
  const putRes = await fetch(`${BASE_URL}/api/labor-engine/admin/templates/${templateId}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      name: 'Plantilla Historial E2E (test)',
      type: 'FIXED',
      active: true,
      is_default: false,
      tolerancia_entrada_minutos: 20
    })
  });
  assert.equal(putRes.status, 200, JSON.stringify(await putRes.json()));

  // Confirmar que SI quedo un snapshot archivado del estado anterior
  // (tolerancia NULL) cubriendo la fecha de creacion hasta ayer.
  const [historyRows] = await db.query('SELECT * FROM work_schedule_template_config_history WHERE template_id = ?', [templateId]);
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows[0].tolerancia_entrada_minutos, null);
  assert.equal(historyRows[0].valid_from, '2026-01-01');

  // Recalcular la MISMA fecha pasada -- si el hallazgo #3 no estuviera
  // corregido, el motor nuevo pasaria a usar la tolerancia NUEVA (20 min)
  // y dejaria de marcar tardanza (15 < 20). Con la correccion, sigue
  // usando la tolerancia que regia en su momento (fallback legacy, 10
  // min) -- 15 min sigue siendo tardanza para AMBOS motores, sin
  // diferencia.
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`, { headers });
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_PAST);
  assert.equal(day.status, 'Late', 'el resultado OFICIAL (Legacy) nunca cambia');
  assert.ok(day.shadowResult);
  const classificationDiff = day.shadowResult.diffs.find((d) => d.field === 'classifications');
  assert.equal(classificationDiff, undefined, 'el motor nuevo debe seguir usando la tolerancia VIEJA para esta fecha pasada -- sigue coincidiendo con Legacy (Late)');
});
