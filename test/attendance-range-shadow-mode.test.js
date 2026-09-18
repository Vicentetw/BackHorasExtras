// Etapa 12 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt): modo de comparacion/sombra. Para
// los MISMOS datos se corre Legacy (el resultado OFICIAL de siempre) y el
// motor nuevo, SIN cambiar el resultado oficial -- solo se anota la
// diferencia (day.shadowResult, tabla rule_engine_shadow_diffs).
//
// 4 escenarios, 3 plantillas distintas (mismo tenant):
// - LEGACY_TEMPLATE (rules_engine_mode default, sin tocar): shadowResult
//   debe ser null y no debe insertarse NINGUNA fila en
//   rule_engine_shadow_diffs -- el modo sombra ni siquiera corre.
// - SHADOW_TEMPLATE_NO_DIFF (modo 'shadow', SIN tolerancia configurada,
//   fichaje exacto): Legacy y motor nuevo deben coincidir -- shadowResult
//   presente pero con diffs = [].
// - SHADOW_TEMPLATE_NEW_FEATURE (modo 'shadow', CON tolerancia de entrada
//   de 20 min configurada, fichaje 15 min tarde): Legacy (tolerancia fija
//   de 10 min) marca Late; el motor nuevo, con tolerancia de 20,
//   considera a tiempo -- diferencia REAL y esperada, clasificada
//   NEW_FEATURE (no POSSIBLE_REGRESSION, porque hay configuracion nueva
//   de por medio). El resultado OFICIAL (status/late/overtimeHours) no
//   debe cambiar en NADA para ninguno de los 3 casos.
// - SHADOW_TEMPLATE_EXCUSED (modo 'shadow', dia con licencia/vacaciones
//   -- userexclusions, SIN fichajes): Etapa 13 ("Vacaciones"/"Permiso").
//   El motor nuevo NUNCA corre en un dia Excused (la rama checks.length>0
//   de /attendance-range, la unica que invoca el motor, ni siquiera se
//   alcanza) -- shadowResult debe seguir siendo null, igual que en modo
//   legacy. Salida particular/oficial no se testean aca: son un dato
//   adicional (hasParticularExit) que no altera fichajes/tolerancias, no
//   hay nada propio del motor que pueda romperse con eso.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-shadow-mode';
const TENANT_ID = 999997;

const DATE_LEGACY = '2026-01-05'; // lunes
const DATE_SHADOW_NO_DIFF = '2026-01-12'; // lunes
const DATE_SHADOW_NEW_FEATURE = '2026-01-19'; // lunes
const DATE_SHADOW_EXCUSED = '2026-01-26'; // lunes

let headers;
let db;
let templateLegacyId;
let templateShadowNoDiffId;
let templateShadowNewFeatureId;
const employees = {}; // date -> { employeeId, badge, userId }

before(async () => {
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306
  });

  // El tenant tiene que existir ANTES de pedir headers con tenantId (
  // getTestAuthHeaders inserta en app_users con FK hacia tenants).
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Shadow Mode (test)', 'tenant-shadow-mode-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true, tenantId: TENANT_ID });

  const [tplLegacy] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Legacy (test)', 'FIXED', 1, 0)`,
    [TENANT_ID]
  );
  templateLegacyId = tplLegacy.insertId;

  const [tplShadowNoDiff] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Shadow sin diff (test)', 'FIXED', 1, 0, 'shadow')`,
    [TENANT_ID]
  );
  templateShadowNoDiffId = tplShadowNoDiff.insertId;

  const [tplShadowNewFeature] = await db.query(
    `INSERT INTO work_schedule_templates
       (tenant_id, name, type, active, is_default, rules_engine_mode, tolerancia_entrada_minutos)
     VALUES (?, 'Shadow con tolerancia (test)', 'FIXED', 1, 0, 'shadow', 20)`,
    [TENANT_ID]
  );
  templateShadowNewFeatureId = tplShadowNewFeature.insertId;

  for (const tplId of [templateLegacyId, templateShadowNoDiffId, templateShadowNewFeatureId]) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '09:00:00', '18:00:00', 'WORK', 1)`,
      [tplId]
    );
  }

  const scenarios = [
    { date: DATE_LEGACY, templateId: templateLegacyId, checkinTime: '09:00:00' },
    { date: DATE_SHADOW_NO_DIFF, templateId: templateShadowNoDiffId, checkinTime: '09:00:00' },
    { date: DATE_SHADOW_NEW_FEATURE, templateId: templateShadowNewFeatureId, checkinTime: '09:15:00' },
    { date: DATE_SHADOW_EXCUSED, templateId: templateShadowNoDiffId, checkinTime: null }
  ];

  const seed = Date.now() % 1000000;
  let offset = 0;
  for (const scenario of scenarios) {
    const badge = 800000 + ((seed + offset) % 90000);
    const userId = 800000 + ((seed + offset + 1) % 90000);
    offset += 2;

    const [empResult] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, ?, ?, 0)`,
      [badge, `Empleado Shadow Mode ${scenario.date} (test)`, TENANT_ID]
    );
    const employeeId = empResult.insertId;

    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
      [userId, TENANT_ID, String(badge), `Empleado Shadow Mode ${scenario.date} (test)`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
      [userId, TENANT_ID, employeeId]);
    await db.query(
      `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, NULL)`,
      [employeeId, TENANT_ID, scenario.templateId, scenario.date]
    );

    if (scenario.checkinTime) {
      await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`, [
        userId, TENANT_ID, `${scenario.date} ${scenario.checkinTime}`,
        userId, TENANT_ID, `${scenario.date} 18:00:00`
      ]);
    } else {
      // Etapa 13 ("Vacaciones"/"Permiso"): sin fichajes, dia excusado por
      // licencia -- el empleado ni siquiera entra a la rama checks.length>0
      // de /attendance-range (la unica que invoca el motor nuevo).
      await db.query(`INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, 'FULL_DAY')`,
        [userId, TENANT_ID, scenario.date, 'Vacaciones (test)']);
    }

    employees[scenario.date] = { employeeId, badge, userId };
  }
});

after(async () => {
  for (const { userId, employeeId } of Object.values(employees)) {
    await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM userexclusions WHERE userId = ?', [userId]);
    await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
    await db.query('DELETE FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
    await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  }
  for (const tplId of [templateLegacyId, templateShadowNoDiffId, templateShadowNewFeatureId]) {
    await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [tplId]);
    await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [tplId]);
  }
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('modo legacy (default): sin shadowResult, sin filas en rule_engine_shadow_diffs, resultado oficial sin cambios', async () => {
  const { badge, employeeId } = employees[DATE_LEGACY];
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`,
    { headers }
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_LEGACY);
  assert.equal(day.status, 'OnTime');
  assert.equal(day.shadowResult, null);

  const [rows] = await db.query('SELECT * FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
  assert.equal(rows.length, 0);
});

test('modo shadow sin configuracion nueva, fichaje exacto: Legacy y motor nuevo coinciden -> shadowResult presente, diffs vacio', async () => {
  const { badge, employeeId } = employees[DATE_SHADOW_NO_DIFF];
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`,
    { headers }
  );
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SHADOW_NO_DIFF);
  assert.equal(day.status, 'OnTime');
  assert.ok(day.shadowResult, 'shadowResult debe estar presente en modo shadow');
  assert.deepEqual(day.shadowResult.diffs, []);
  assert.equal(day.shadowResult.engine.normalMinutes, 540);

  const [rows] = await db.query('SELECT * FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
  assert.equal(rows.length, 0, 'sin diferencias, no debe insertarse ninguna fila');
});

test('modo shadow CON tolerancia de entrada configurada, fichaje 15min tarde: Legacy marca Late, motor nuevo no -> diff NEW_FEATURE, resultado oficial (Late) sin cambios', async () => {
  const { badge, employeeId } = employees[DATE_SHADOW_NEW_FEATURE];
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`,
    { headers }
  );
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SHADOW_NEW_FEATURE);

  // Resultado OFICIAL: debe seguir siendo exactamente el de siempre
  // (tolerancia legacy fija de 10 min -- 15 min tarde SI es tardanza).
  assert.equal(day.status, 'Late');
  assert.equal(day.lateMinutes, 15);

  // Informacion adicional del modo sombra: el motor nuevo, con la
  // tolerancia de 20 min configurada en esta plantilla, NO lo marca tarde.
  assert.ok(day.shadowResult);
  const classificationDiff = day.shadowResult.diffs.find((d) => d.field === 'classifications');
  assert.ok(classificationDiff, 'debe haber una diferencia de clasificacion');
  assert.equal(classificationDiff.legacyValue, 'Late');
  assert.equal(classificationDiff.newValue, 'OnTime');
  assert.equal(classificationDiff.diffType, 'NEW_FEATURE');

  const [rows] = await db.query('SELECT * FROM rule_engine_shadow_diffs WHERE employee_id = ? ORDER BY field', [employeeId]);
  assert.ok(rows.length >= 1, 'la diferencia debe quedar persistida para revision');
  rows.forEach((r) => assert.equal(r.diff_type, 'NEW_FEATURE'));
});

test('Etapa 13 (Vacaciones/Permiso): dia excusado (licencia) bajo plantilla en modo shadow -> el motor nuevo NUNCA corre, shadowResult null', async () => {
  const { badge, employeeId } = employees[DATE_SHADOW_EXCUSED];
  const res = await fetch(
    `${BASE_URL}/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${badge}`,
    { headers }
  );
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === String(badge));
  const day = row.days.find((d) => d.date === DATE_SHADOW_EXCUSED);

  assert.equal(day.status, 'Excused');
  assert.equal(day.shadowResult, undefined, 'un dia Excused ni siquiera tiene el campo shadowResult -- esa rama no lo agrega');

  const [rows] = await db.query('SELECT * FROM rule_engine_shadow_diffs WHERE employee_id = ?', [employeeId]);
  assert.equal(rows.length, 0, 'sin fichajes, el motor nuevo no corrio -- no hay nada que comparar ni persistir');
});
