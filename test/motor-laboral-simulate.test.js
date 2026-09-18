// Etapa 11 del plan "Motor de reglas de asistencia configurable" --
// POST /api/labor-engine/admin/simulate: solo lectura, nunca escribe
// nada. Requiere backend local levantado (node horasdedica.js, puerto 3000).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const BASE = `${BASE_URL}/api/labor-engine/admin`;
const TEST_UID = 'test-motor-laboral-simulate';
const TENANT_ID = 999968;

let headers;
let templateId;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Simulador (test)', 'tenant-simulador-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true, tenantId: TENANT_ID });

  const [tpl] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Plantilla Simulador (test)', 'FIXED', 1, 0)`,
    [TENANT_ID]
  );
  templateId = tpl.insertId;
  // Lunes (day_of_week=1) -- 2026-01-05 es lunes, usado como default en el endpoint.
  await db.query(
    `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '09:00:00', '18:00:00', 'WORK', 1)`,
    [templateId]
  );
});

after(async () => {
  await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('simulate: ejemplo del documento con bloques hipoteticos (sin templateId) -> NORMAL 540 + OVERTIME 120', async () => {
  const res = await fetch(`${BASE}/simulate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [{ block_type: 'WORK', start_time: '09:00:00', end_time: '18:00:00', crosses_midnight: 0, active: 1 }],
      toleranceOverrides: { politica_salida_posterior: 'EXTRA_SI_AUTORIZADO' },
      checkins: ['09:00', '20:00'],
      dayType: 'WORKDAY',
      isOvertimeAuthorized: true
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.normalMinutes, 540);
  assert.equal(body.overtimeMinutes, 120);
  assert.ok(body.segments[0].startTimeLabel === '09:00', 'debe incluir horarios legibles para armar la linea de tiempo');
  assert.ok(body.classifiedSegments.some((s) => s.type === 'OVERTIME' && s.endTimeLabel === '20:00'));
});

test('simulate: con templateId real, carga los bloques de esa plantilla (solo lectura, no modifica nada)', async () => {
  const res = await fetch(`${BASE}/simulate?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId, checkins: ['09:00', '18:00'], dayType: 'WORKDAY', isOvertimeAuthorized: true })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.scheduledMinutes, 540);
  assert.equal(body.normalMinutes, 540);

  // Confirmar que la plantilla real sigue exactamente igual -- el
  // simulador nunca debe escribir nada.
  const [[tpl]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [templateId]);
  assert.equal(tpl.name, 'Plantilla Simulador (test)');
});

test('simulate: feriado con regla ALL_DAY inline (sin guardar nada en day_type_overtime_rules) -> todo el dia HE', async () => {
  const res = await fetch(`${BASE}/simulate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [{ block_type: 'WORK', start_time: '09:00:00', end_time: '18:00:00', crosses_midnight: 0, active: 1 }],
      checkins: ['09:00', '18:00'],
      dayType: 'HOLIDAY',
      isOvertimeAuthorized: false,
      dayTypeRules: [{ day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 100, requires_authorization: 0 }]
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.overtimeMinutes, 540);
  const [countRows] = await db.query(`SELECT COUNT(*) AS n FROM day_type_overtime_rules WHERE day_type = 'HOLIDAY'`);
  assert.equal(countRows[0].n, 0, 'la regla hipotetica nunca debe persistirse');
});

test('simulate: sin checkins -> 400', async () => {
  const res = await fetch(`${BASE}/simulate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: [{ block_type: 'WORK', start_time: '09:00:00', end_time: '18:00:00' }], checkins: [] })
  });
  assert.equal(res.status, 400);
});

test('simulate: dayType invalido -> 400', async () => {
  const res = await fetch(`${BASE}/simulate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: [{ block_type: 'WORK', start_time: '09:00:00', end_time: '18:00:00' }], checkins: ['09:00'], dayType: 'ALGO_RARO' })
  });
  assert.equal(res.status, 400);
});

test('simulate: sin blocks ni templateId -> 400', async () => {
  const res = await fetch(`${BASE}/simulate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkins: ['09:00'] })
  });
  assert.equal(res.status, 400);
});
