// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #4 (nada de convenios/reglas de dia era operable
// por API, solo por SQL directo) y prueba explicitamente el HALLAZGO #7
// (aislamiento de tenant a nivel HTTP para las tablas nuevas -- este
// proyecto tuvo bugs reales de fuga de tenant_id, fases 19-21, por eso
// se escribe este test DESDE el primer commit del CRUD, no despues).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const BASE = `${BASE_URL}/api/labor-engine/admin`;
const TEST_UID_A = 'test-admin-conventions-a';
const TEST_UID_B = 'test-admin-conventions-b';
const TENANT_A = 999959;
const TENANT_B = 999958;

let headersA, headersB;
let templateAId;
let conventionAId, conventionBId;
let employeeAId, badgeA;
const createdConventionIds = [];
const createdRuleIds = [];

before(async () => {
  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Conventions A (test)', 'tenant-conventions-a-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_A]);
  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Conventions B (test)', 'tenant-conventions-b-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_B]);
  headersA = await getTestAuthHeaders(TEST_UID_A, { isSuperadmin: false, tenantId: TENANT_A, permissions: ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete'] });
  headersB = await getTestAuthHeaders(TEST_UID_B, { isSuperadmin: false, tenantId: TENANT_B, permissions: ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete'] });

  const [tplA] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Plantilla A (test)', 'FIXED', 1, 0)`, [TENANT_A]);
  templateAId = tplA.insertId;

  const [convA] = await db.query(`INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio A (test, seed)', 1)`, [TENANT_A]);
  conventionAId = convA.insertId;
  const [convB] = await db.query(`INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio B (test, seed)', 1)`, [TENANT_B]);
  conventionBId = convB.insertId;

  const [empA] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, 'Empleado A (test)', ?, 0)`, [900001, TENANT_A]);
  employeeAId = empA.insertId;
  badgeA = 900001;
});

after(async () => {
  await db.query('DELETE FROM employee_convention_assignments WHERE employee_id = ?', [employeeAId]).catch(() => {});
  await db.query('DELETE FROM employees WHERE id = ?', [employeeAId]).catch(() => {});
  for (const id of createdRuleIds) await db.query('DELETE FROM day_type_overtime_rules WHERE id = ?', [id]).catch(() => {});
  for (const id of createdConventionIds) await db.query('DELETE FROM labor_conventions WHERE id = ?', [id]).catch(() => {});
  await db.query('DELETE FROM labor_conventions WHERE id IN (?, ?)', [conventionAId, conventionBId]).catch(() => {});
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateAId]).catch(() => {});
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]).catch(() => {});
  await deleteTestUser(TEST_UID_A);
  await deleteTestUser(TEST_UID_B);
  await closeDb();
});

// --- Convenios: CRUD basico + aislamiento de tenant ---

test('POST /conventions: un usuario normal crea un convenio para SU propia empresa', async () => {
  const res = await fetch(`${BASE}/conventions`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Convenio Comercio (test)', description: 'CCT 130/75' })
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  createdConventionIds.push(body.id);
});

test('GET /conventions: un usuario normal solo ve los convenios de SU tenant', async () => {
  const res = await fetch(`${BASE}/conventions`, { headers: headersA });
  const body = await res.json();
  assert.ok(body.every((c) => c.tenant_id === TENANT_A), 'no debe aparecer ningun convenio de otro tenant');
  assert.ok(body.some((c) => c.id === conventionAId));
  assert.ok(!body.some((c) => c.id === conventionBId), 'el convenio de TENANT_B no debe verse');
});

test('PUT /conventions/:id: un usuario de TENANT_A no puede editar un convenio de TENANT_B (404, no 403 -- no revela existencia)', async () => {
  const res = await fetch(`${BASE}/conventions/${conventionBId}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hackeado' })
  });
  assert.equal(res.status, 404);
  const [[row]] = await db.query('SELECT name FROM labor_conventions WHERE id = ?', [conventionBId]);
  assert.equal(row.name, 'Convenio B (test, seed)', 'el convenio de TENANT_B no debe haber cambiado');
});

test('DELETE /conventions/:id: un usuario de TENANT_A no puede borrar un convenio de TENANT_B', async () => {
  const res = await fetch(`${BASE}/conventions/${conventionBId}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 404);
  const [[row]] = await db.query('SELECT id FROM labor_conventions WHERE id = ?', [conventionBId]);
  assert.ok(row, 'el convenio de TENANT_B debe seguir existiendo');
});

// --- Reglas de horas extra por tipo de dia: CRUD basico + aislamiento ---

test('POST /day-type-rules: un usuario normal, sin especificar scope, crea la regla a nivel de SU tenant (nunca global)', async () => {
  const res = await fetch(`${BASE}/day-type-rules`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 100, requires_authorization: false })
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  createdRuleIds.push(body.id);
  const [[row]] = await db.query('SELECT tenant_id, template_id, convention_id FROM day_type_overtime_rules WHERE id = ?', [body.id]);
  assert.equal(row.tenant_id, TENANT_A);
  assert.equal(row.template_id, null);
  assert.equal(row.convention_id, null);
});

test('POST /day-type-rules: un usuario normal NO puede crear una regla para el convenio de OTRO tenant', async () => {
  const res = await fetch(`${BASE}/day-type-rules`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_type: 'SATURDAY', trigger_type: 'ALL_DAY', rate: 50, convention_id: conventionBId })
  });
  assert.equal(res.status, 400);
});

test('POST /day-type-rules: un usuario normal NO puede crear una regla para la plantilla de OTRO tenant', async () => {
  const [tplB] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Plantilla B (test)', 'FIXED', 1, 0)`, [TENANT_B]);
  const res = await fetch(`${BASE}/day-type-rules`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_type: 'SATURDAY', trigger_type: 'ALL_DAY', rate: 50, template_id: tplB.insertId })
  });
  assert.equal(res.status, 400);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [tplB.insertId]);
});

test('GET /day-type-rules: un usuario normal solo ve reglas de SU tenant/plantillas/convenios', async () => {
  const otherRes = await fetch(`${BASE}/day-type-rules`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_type: 'SUNDAY', trigger_type: 'ALL_DAY', rate: 100 })
  });
  const otherBody = await otherRes.json();
  createdRuleIds.push(otherBody.id);

  const res = await fetch(`${BASE}/day-type-rules`, { headers: headersA });
  const body = await res.json();
  assert.ok(!body.some((r) => r.id === otherBody.id), 'la regla de TENANT_B no debe verse desde TENANT_A');
});

test('PUT y DELETE /day-type-rules/:id: un usuario de TENANT_A no puede tocar una regla de TENANT_B (404)', async () => {
  const [ruleB] = await db.query(
    `INSERT INTO day_type_overtime_rules (tenant_id, day_type, trigger_type, rate) VALUES (?, 'WORKDAY', 'AFTER_SCHEDULE', 50)`,
    [TENANT_B]
  );
  const putRes = await fetch(`${BASE}/day-type-rules/${ruleB.insertId}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_type: 'WORKDAY', trigger_type: 'AFTER_SCHEDULE', rate: 999 })
  });
  assert.equal(putRes.status, 404);
  const delRes = await fetch(`${BASE}/day-type-rules/${ruleB.insertId}`, { method: 'DELETE', headers: headersA });
  assert.equal(delRes.status, 404);
  const [[row]] = await db.query('SELECT rate FROM day_type_overtime_rules WHERE id = ?', [ruleB.insertId]);
  assert.equal(Number(row.rate), 50, 'la regla de TENANT_B no debe haber cambiado ni borrarse');
  await db.query('DELETE FROM day_type_overtime_rules WHERE id = ?', [ruleB.insertId]);
});

// --- Encuadramiento de empleado a convenio: CRUD + aislamiento ---

test('POST /employees/:id/convention-assignments: asigna un convenio de la MISMA empresa al empleado', async () => {
  const res = await fetch(`${BASE}/employees/${employeeAId}/convention-assignments`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ convention_id: conventionAId, valid_from: '2026-01-01' })
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));

  const getRes = await fetch(`${BASE}/employees/${employeeAId}/convention-assignments`, { headers: headersA });
  const rows = await getRes.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].convention_id, conventionAId);
});

test('POST /employees/:id/convention-assignments: NO se puede asignar un convenio de OTRA empresa', async () => {
  const res = await fetch(`${BASE}/employees/${employeeAId}/convention-assignments`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ convention_id: conventionBId, valid_from: '2026-02-01' })
  });
  assert.equal(res.status, 400);
});

test('GET /employees/:id/convention-assignments: un usuario de OTRA empresa no puede leer el encuadramiento (404)', async () => {
  const res = await fetch(`${BASE}/employees/${employeeAId}/convention-assignments`, { headers: headersB });
  assert.equal(res.status, 404);
});
