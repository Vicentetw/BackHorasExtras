// Congela que los permisos granulares (modulo:accion) realmente bloqueen
// acceso -- no solo el aislamiento por tenant. Un usuario del tenant de
// prueba (AVP2) sin "employees:read" no debe poder listar empleados, y
// con el permiso si; lo mismo para "attendance:read".
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const AVP2_TENANT_ID = 4;
const NO_PERMS_UID = 'test-permissions-none-ci';
const READ_ONLY_UID = 'test-permissions-readonly-ci';

after(async () => {
  await deleteTestUser(NO_PERMS_UID);
  await deleteTestUser(READ_ONLY_UID);
  await closeDb();
});

test('sin ningun permiso: /api/employees y /attendance-range responden 403', async () => {
  const headers = await getTestAuthHeaders(NO_PERMS_UID, { isSuperadmin: false, tenantId: AVP2_TENANT_ID, permissions: [] });

  const r1 = await fetch(`${BASE_URL}/api/employees?limit=0`, { headers });
  assert.equal(r1.status, 403);

  const r2 = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, { headers });
  assert.equal(r2.status, 403);
});

test('con employees:read pero sin employees:create: puede listar pero no crear', async () => {
  const headers = await getTestAuthHeaders(READ_ONLY_UID, {
    isSuperadmin: false,
    tenantId: AVP2_TENANT_ID,
    permissions: ['employees:read']
  });

  const r1 = await fetch(`${BASE_URL}/api/employees?limit=0`, { headers });
  assert.equal(r1.status, 200, 'con employees:read deberia poder listar');

  const r2 = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: '999999', nombre: 'No deberia crearse' })
  });
  assert.equal(r2.status, 403, 'sin employees:create no deberia poder crear');
});
