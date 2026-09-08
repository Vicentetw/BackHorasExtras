// Bug real de seguridad encontrado en una auditoria general (no un reporte
// de un usuario): a diferencia de calendar-tenant-guard.test.js (que cubre
// "la plantilla es de otro tenant que el EMPLEADO"), estas 4 rutas no
// chequeaban NADA de "el empleado es de otro tenant que QUIEN LLAMA" -- un
// usuario normal (no superadmin) con permiso de schedules podia leer, crear,
// borrar o incluir en un lote la asignacion de horario de un empleado de
// OTRA empresa con solo conocer/adivinar su employeeId (secuencial, facil
// de barrer). Ver motor-laboral/routes/admin.js.
//
// Tenants descartables propios (999980/999981), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_CALLER = 999980;
const TENANT_TARGET = 999981;
const UID_CALLER = 'test-calendar-caller-guard';

let headersCaller;
let targetEmployeeId;
let callerTemplateId;
let existingCalendarId;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Caller Guard (test)', 'tenant-caller-guard-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_CALLER]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Target Guard (test)', 'tenant-target-guard-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_TARGET]
  );

  headersCaller = await getTestAuthHeaders(UID_CALLER, {
    isSuperadmin: false,
    tenantId: TENANT_CALLER,
    permissions: ['schedules:read', 'schedules:update', 'schedules:delete'],
  });

  const [empResult] = await db.query(`INSERT INTO employees (nombre, tenant_id) VALUES (?, ?)`, ['Empleado Target Guard (test)', TENANT_TARGET]);
  targetEmployeeId = empResult.insertId;

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, ?, ?, ?)`,
    [TENANT_CALLER, 'plantilla del caller (test)', 'FIXED', 1, 0]
  );
  callerTemplateId = tplResult.insertId;

  // Una asignación YA existente en el empleado ajeno -- para probar que el
  // DELETE no puede tocarla desde el otro tenant.
  const [calResult] = await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, ?)`,
    [targetEmployeeId, TENANT_TARGET, callerTemplateId, '2026-01-01']
  );
  existingCalendarId = calResult.insertId;
});

after(async () => {
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [targetEmployeeId]);
  await db.query('DELETE FROM employees WHERE id = ?', [targetEmployeeId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [callerTemplateId]);
  await deleteTestUser(UID_CALLER);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_CALLER, TENANT_TARGET]);
  await closeDb();
});

test('GET /employees/:id/calendar de un empleado de OTRA empresa -> 404, no expone datos', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/employees/${targetEmployeeId}/calendar`, { headers: headersCaller });
  assert.equal(res.status, 404);
});

test('POST /employees/:id/calendar sobre un empleado de OTRA empresa -> 404, no crea nada', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/employees/${targetEmployeeId}/calendar`, {
    method: 'POST',
    headers: { ...headersCaller, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_id: callerTemplateId, valid_from: '2026-08-01' }),
  });
  assert.equal(res.status, 404);

  const [rows] = await db.query('SELECT COUNT(*) AS c FROM employee_work_calendars WHERE employee_id = ?', [targetEmployeeId]);
  assert.equal(rows[0].c, 1, 'no debe haberse agregado ninguna asignación nueva -- solo debe seguir la que ya existía');
});

test('POST /employees/bulk-assign-calendar salta (no asigna) un empleado de OTRA empresa colado en el lote', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/employees/bulk-assign-calendar`, {
    method: 'POST',
    headers: { ...headersCaller, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeIds: [targetEmployeeId], template_id: callerTemplateId, valid_from: '2026-08-01' }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.assigned.length, 0);
  assert.equal(json.skipped.length, 1);
  assert.equal(Number(json.skipped[0].employeeId), targetEmployeeId);
});

test('DELETE /employees/:id/calendar/:calendarId sobre un empleado de OTRA empresa -> 404, no borra nada', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/employees/${targetEmployeeId}/calendar/${existingCalendarId}`, {
    method: 'DELETE',
    headers: headersCaller,
  });
  assert.equal(res.status, 404);

  const [rows] = await db.query('SELECT id FROM employee_work_calendars WHERE id = ?', [existingCalendarId]);
  assert.equal(rows.length, 1, 'la asignación de la otra empresa debe seguir existiendo, sin tocar');
});
