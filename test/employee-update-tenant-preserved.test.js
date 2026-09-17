// Bug real GRAVE encontrado en produccion: PUT /api/employees/:id, para un
// superadmin, usaba directamente `tenant_id || null` del body -- el
// dialogo de editar empleado (frontend) NUNCA manda ese campo, asi que
// CUALQUIER guardado de un superadmin (ej. asignarle una ciudad a mano)
// pisaba en silencio el tenant_id real del empleado con NULL. Encontrado
// porque 2 empleados reales (Perrotta legajo 2525, Pritchard legajo 2448)
// quedaron con tenant_id=NULL despues de asignarles ciudad -- sus reportes
// de asistencia se rompieron (el empleado deja de resolver bien su
// empresa/feriados/horario). Ahora: si el body no manda tenant_id
// explicito, se conserva el que ya tenia.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-employee-update-tenant-ci';
const TENANT_ID = 999955;

let headers;
let employeeDbId;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Employee Update (test)', 'tenant-employee-update-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });

  const [result] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES ('997001', 'Test Tenant Preservado', ?, 1)`,
    [TENANT_ID]
  );
  employeeDbId = result.insertId;
});

after(async () => {
  if (employeeDbId) await db.query('DELETE FROM employees WHERE id = ?', [employeeDbId]).catch(() => {});
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('PUT /api/employees/:id como superadmin SIN mandar tenant_id: conserva el tenant_id que ya tenia (no lo pisa con NULL)', async () => {
  // Payload real que manda employee-dialog.ts -- nunca incluye tenant_id.
  const res = await fetch(`${BASE_URL}/api/employees/${employeeDbId}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employee_id: '997001',
      nombre: 'Test Tenant Preservado (editado)',
      activo: true
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const [[row]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeDbId]);
  assert.equal(row.tenant_id, TENANT_ID, 'el tenant_id NO debe quedar en NULL solo porque el body no lo mando');
});

test('PUT /api/employees/:id como superadmin SI manda tenant_id explicito: lo respeta (reasignar sigue siendo posible)', async () => {
  const [otherTenant] = await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (999956, 'Tenant Employee Update B (test)', 'tenant-employee-update-test-b')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`
  );
  const res = await fetch(`${BASE_URL}/api/employees/${employeeDbId}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employee_id: '997001',
      nombre: 'Test Tenant Preservado (reasignado)',
      activo: true,
      tenant_id: 999956
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const [[row]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeDbId]);
  assert.equal(row.tenant_id, 999956);

  // Restaurar y limpiar el segundo tenant de prueba.
  await db.query('UPDATE employees SET tenant_id = ? WHERE id = ?', [TENANT_ID, employeeDbId]);
  await db.query('DELETE FROM tenants WHERE id = 999956').catch(() => {});
});
