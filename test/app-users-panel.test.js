// Congela el comportamiento del panel de usuarios/permisos: sin el
// permiso "users:read" no se puede ni listar, con el permiso si.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const AVP2_TENANT_ID = 4;
const NO_PERM_UID = 'test-panel-noperm-ci';
const WITH_PERM_UID = 'test-panel-withperm-ci';

after(async () => {
  await deleteTestUser(NO_PERM_UID);
  await deleteTestUser(WITH_PERM_UID);
  await closeDb();
});

test('/api/app-users sin el permiso users:read responde 403', async () => {
  // permissions: [] explicito -- sin esto, getTestAuthHeaders otorga todos
  // los permisos por default (para no afectar los tests de aislamiento).
  const headers = await getTestAuthHeaders(NO_PERM_UID, { isSuperadmin: false, tenantId: AVP2_TENANT_ID, permissions: [] });
  const res = await fetch(`${BASE_URL}/api/app-users`, { headers });
  assert.equal(res.status, 403);
});

test('/api/app-users con el permiso users:read responde 200 y solo trae mi tenant', async () => {
  const headers = await getTestAuthHeaders(WITH_PERM_UID, { isSuperadmin: false, tenantId: AVP2_TENANT_ID, permissions: ['users:read'] });

  const res = await fetch(`${BASE_URL}/api/app-users`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.users.every((row) => row.tenant_id === AVP2_TENANT_ID));
});
