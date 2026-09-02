// Fase 4.1: roles = presets con nombre por encima de user_permissions.
// Permisos efectivos = permisos del rol UNION overrides individuales.
// Un usuario con role_id = NULL (el default) debe seguir funcionando
// exactamente como antes de esta migracion -- ese es el caso que ya cubre
// permissions-enforcement.test.js, acá se agrega la regresion explicita
// para role_id ademas de permisos individuales.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const AVP2_TENANT_ID = 4;
const ROLE_UID = 'test-roles-assigned-ci';
const NO_ROLE_UID = 'test-roles-none-ci';

after(async () => {
  await deleteTestUser(ROLE_UID);
  await deleteTestUser(NO_ROLE_UID);
  await closeDb();
});

test('un usuario con un rol asignado tiene exactamente los permisos del rol, y sumar un permiso individual se une (no reemplaza)', async () => {
  const headers = await getTestAuthHeaders(ROLE_UID, { isSuperadmin: false, tenantId: AVP2_TENANT_ID, permissions: [] });

  const [[role]] = await db.query("SELECT id FROM roles WHERE name = 'Solo Lectura / Reportes'");
  assert.ok(role, 'el rol de sistema "Solo Lectura / Reportes" deberia existir (migracion 20260902_add_roles.sql)');

  const [[appUser]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [ROLE_UID]);
  await db.query('UPDATE app_users SET role_id = ? WHERE id = ?', [role.id, appUser.id]);

  const r1 = await fetch(`${BASE_URL}/api/app-users/me`, { headers });
  const j1 = await r1.json();
  assert.equal(r1.status, 200);
  const expectedRolePerms = ['employees:read', 'attendance:read', 'matching:read', 'holidays:read', 'leaves:read', 'exclusions:read'];
  assert.deepEqual([...j1.permissions].sort(), expectedRolePerms.sort());
  assert.equal(j1.roleId, role.id);

  // Sumar un permiso individual además del rol -- union, no reemplazo.
  await db.query('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)', [appUser.id, 'employees:create']);

  const r2 = await fetch(`${BASE_URL}/api/app-users/me`, { headers });
  const j2 = await r2.json();
  assert.ok(j2.permissions.includes('employees:create'), 'el permiso individual deberia sumarse');
  assert.ok(j2.permissions.includes('employees:read'), 'los permisos del rol deberian seguir presentes');
  assert.equal(j2.permissions.length, expectedRolePerms.length + 1);
});

test('un usuario sin rol asignado (role_id NULL) sigue funcionando solo con sus permisos individuales -- regresion', async () => {
  const headers = await getTestAuthHeaders(NO_ROLE_UID, {
    isSuperadmin: false,
    tenantId: AVP2_TENANT_ID,
    permissions: ['employees:read'],
  });

  const [[appUser]] = await db.query('SELECT id, role_id FROM app_users WHERE firebase_uid = ?', [NO_ROLE_UID]);
  assert.equal(appUser.role_id, null, 'getTestAuthHeaders no debería haber asignado ningún rol');

  const res = await fetch(`${BASE_URL}/api/app-users/me`, { headers });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(json.permissions, ['employees:read']);
  assert.equal(json.roleId, null);
});
