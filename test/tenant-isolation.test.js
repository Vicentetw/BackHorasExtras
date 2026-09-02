// El test mas importante del paso 2: un usuario de una empresa NO debe ver
// empleados de otra. Usa el tenant de prueba "AVP2" (id 4, 2 empleados)
// contra el tenant real "Empresa Principal" (id 6, 478 empleados) para
// probar el aislamiento de punta a punta a traves de /api/employees.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-tenant-isolation';
const AVP2_TENANT_ID = 4;

let headers;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: false, tenantId: AVP2_TENANT_ID });
});

after(async () => {
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/api/employees: un usuario de AVP2 solo ve los 2 empleados de AVP2, no los 478 de la otra empresa', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.data.length, 2, 'debe ver solo los empleados de su propio tenant');
  const badges = json.data.map((e) => e.employee_id).sort();
  assert.deepEqual(badges, [2329, 3056]);
});

test('/api/employees: no puede ver otra empresa aunque mande tenantId por query (no es superadmin)', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0&tenantId=6`, { headers });
  const json = await res.json();
  assert.equal(json.data.length, 2, 'el tenantId de la query se ignora para un usuario no-superadmin');
});

test('/attendance-range: un usuario de AVP2 solo ve filas de sus 2 empleados', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.length, 2, 'el reporte de asistencia tambien queda acotado al tenant');
});
