// "Una empresa siempre tiene que tener al menos un administrador" (2026-10-09).
//  A) Tu propia cuenta: no te podés desactivar, eliminar ni cambiar rol/permisos.
//  B) El último administrador no se puede desactivar, eliminar ni bajar de rol
//     (caso real: alguien con permiso de ELIMINAR usuarios pero que no es
//     administrador).
//  C) El superadmin queda afuera de B (soporte).
// Requiere el backend local corriendo (puerto 3000). Tenant descartable propio (999906), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999906;
const ADMIN_PERMS = ['users:read', 'users:create', 'users:update', 'users:delete'];
let hAdmin; let hSoloBorra; let hSuper; let idAdmin; let idOtra;

const put = (h, id, body) => fetch(`${BASE_URL}/api/app-users/${id}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del = (h, id, permanente = false) => fetch(`${BASE_URL}/api/app-users/${id}${permanente ? '?permanente=1' : ''}`, { method: 'DELETE', headers: h });
const idDe = async (uid) => (await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [uid]))[0][0].id;

before(async () => {
  await db.query("INSERT INTO tenants (id, name, code) VALUES (?, 'Administradores (test)', 'administradores-test') ON DUPLICATE KEY UPDATE name = VALUES(name)", [T]);
  hAdmin = await getTestAuthHeaders('test-adm-unico', { isSuperadmin: false, tenantId: T, permissions: ADMIN_PERMS });
  hSoloBorra = await getTestAuthHeaders('test-adm-solo-borra', { isSuperadmin: false, tenantId: T, permissions: ['users:read', 'users:delete'] });
  hSuper = await getTestAuthHeaders('test-adm-super', { isSuperadmin: true });
  idAdmin = await idDe('test-adm-unico');
  const [r] = await db.query("INSERT INTO app_users (firebase_uid, email, tenant_id, is_superadmin, is_active) VALUES ('test-adm-otra', 'otra-adm@test.local', ?, 0, 1)", [T]);
  idOtra = r.insertId;
});

after(async () => {
  await db.query("DELETE FROM user_permissions WHERE user_id = ?", [idOtra]);
  await db.query("DELETE FROM app_users WHERE firebase_uid = 'test-adm-otra'");
  for (const u of ['test-adm-unico', 'test-adm-solo-borra', 'test-adm-super']) await deleteTestUser(u);
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

test('A: no podés desactivarte, eliminarte ni cambiarte rol o permisos; guardar sin cambios sí', async () => {
  for (const [desc, r] of [
    ['desactivarse (PUT)', await put(hAdmin, idAdmin, { isActive: false })],
    ['desactivarse (DELETE)', await del(hAdmin, idAdmin)],
    ['eliminarse', await del(hAdmin, idAdmin, true)],
    ['quitarse permisos', await put(hAdmin, idAdmin, { permissions: ['users:read'] })],
    ['ponerse un rol', await put(hAdmin, idAdmin, { roleId: 2 })],
  ]) assert.equal(r.status, 400, desc);
  const igual = await put(hAdmin, idAdmin, { permissions: ADMIN_PERMS, roleId: null, isActive: true });
  assert.equal(igual.status, 200, 'el diálogo manda todo igual: tiene que andar');
  const [[u]] = await db.query('SELECT is_active FROM app_users WHERE id = ?', [idAdmin]);
  assert.equal(u.is_active, 1);
});

test('una cuenta que NO es administradora se desactiva y se le cambian permisos sin problema', async () => {
  assert.equal((await put(hAdmin, idOtra, { isActive: false })).status, 200);
  assert.equal((await put(hAdmin, idOtra, { isActive: true, permissions: ['holidays:read'] })).status, 200);
});

test('B: quien solo puede eliminar usuarios no puede desactivar ni eliminar al único administrador', async () => {
  const r1 = await del(hSoloBorra, idAdmin);
  assert.equal(r1.status, 409);
  assert.match((await r1.json()).error, /último administrador/);
  assert.equal((await del(hSoloBorra, idAdmin, true)).status, 409);
  const [[u]] = await db.query('SELECT is_active FROM app_users WHERE id = ?', [idAdmin]);
  assert.equal(u.is_active, 1, 'sigue activo');
});

test('B: con un segundo administrador, el primero ya se puede desactivar (por otro)', async () => {
  // La otra cuenta pasa a ser administradora.
  assert.equal((await put(hAdmin, idOtra, { permissions: ['users:read', 'users:update'] })).status, 200);
  assert.equal((await del(hSoloBorra, idAdmin)).status, 200);
  await db.query('UPDATE app_users SET is_active = 1 WHERE id = ?', [idAdmin]);
  await db.query('DELETE FROM user_permissions WHERE user_id = ?', [idOtra]);
});

test('C: el superadmin sí puede (soporte), y él tampoco se puede desactivar a sí mismo', async () => {
  assert.equal((await put(hSuper, idAdmin, { isActive: false })).status, 200);
  await db.query('UPDATE app_users SET is_active = 1 WHERE id = ?', [idAdmin]);
  const idSuper = await idDe('test-adm-super');
  assert.equal((await put(hSuper, idSuper, { isActive: false })).status, 400);
});
