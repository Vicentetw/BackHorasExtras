// Regresion para el bug real detectado con el legajo 2525 (Perrotta): un
// empleado quedaba leyendo en silencio la plantilla de horario de OTRA
// empresa porque POST /employees/:employeeId/calendar y
// /employees/bulk-assign-calendar no validaban que el template_id perteneciera
// al mismo tenant_id que el empleado. Ver motor-laboral/routes/admin.js.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-calendar-tenant-guard';

let headers;
let db;
let employeeId;
let templateId;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306
  });

  // tenant_id 999999 (inexistente a proposito): employees.tenant_id no tiene
  // FK contra tenants, y usar un tenant real (6) inflaria en paralelo el
  // conteo total de empleados que chequean otros archivos de test que
  // corren al mismo tiempo (node --test corre archivos en paralelo).
  const [empResult] = await db.query(
    `INSERT INTO employees (nombre, tenant_id) VALUES (?, ?)`,
    ['Empleado De Prueba Guard', 999999]
  );
  employeeId = empResult.insertId;

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, ?, ?, ?)`,
    [4, 'plantilla de otro tenant (test)', 'FIXED', 1, 0]
  );
  templateId = tplResult.insertId;
});

after(async () => {
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [employeeId]);
  await db.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('POST /employees/:id/calendar rechaza una plantilla de otro tenant', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/employees/${employeeId}/calendar`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_id: templateId, valid_from: '2026-08-01' })
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /otra empresa/);
});

test('POST /employees/bulk-assign-calendar salta (no asigna) empleados con plantilla de otro tenant', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/employees/bulk-assign-calendar`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeIds: [employeeId], template_id: templateId, valid_from: '2026-08-01' })
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.assigned.length, 0);
  assert.equal(json.skipped.length, 1);
  assert.match(json.skipped[0].reason, /otra empresa/);
});
