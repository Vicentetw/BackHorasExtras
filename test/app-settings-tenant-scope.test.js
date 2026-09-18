// Fase 8 (seguridad/multi-tenant): app_settings paso de ser una unica fila
// GLOBAL (corte de HE, tope de campana, limite de salida particular, modo
// de autorizacion de HE, tema) compartida por TODAS las empresas del mismo
// backend, a soportar un override por tenant. Antes, el admin de una
// empresa que cambiaba el corte de HE se lo cambiaba de yapa a TODAS las
// demas empresas del mismo backend -- real solo con multi-tenant
// compartido (la decision tomada para este sistema). Este archivo prueba
// el aislamiento de punta a punta (no solo la funcion pura) y los guards
// nuevos en las rutas que antes no tenian ninguno.
//
// OJO: nunca toca el default GLOBAL (tenant_id NULL) -- solo crea/borra
// overrides de dos tenants descartables, para no interferir con otros
// archivos de test que corren en paralelo y dependen del corte de HE
// global (attendance-range.test.js, overtime-authorization-mode.test.js).
// Tampoco usa una empresa real (ni AVP) como TENANT_A -- un archivo
// hermano (billing-routes.test.js) si lo hacia y su cleanup termino
// borrando una suscripcion 'free' real configurada a mano. Los dos
// tenants de este archivo son descartables.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999997; // descartable, fuera de rango real
const TENANT_B = 999996; // descartable, fuera de rango real

const UID_A = 'test-app-settings-tenant-a';
const UID_B = 'test-app-settings-tenant-b';
const UID_NO_PERM = 'test-app-settings-no-perm';
const UID_SUPERADMIN = 'test-app-settings-superadmin';

let headersA;
let headersB;
let headersNoPerm;
let headersSuperadmin;

before(async () => {
  // app_users.tenant_id tiene FK contra tenants(id) -- a diferencia de
  // employees/work_schedule_templates (que no la tienen, ver
  // calendar-tenant-guard.test.js), aca hace falta una fila real en
  // `tenants` para poder loguear un usuario de prueba con ese tenant_id.
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant A (test)', 'tenant-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant B (test)', 'tenant-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );

  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B });
  headersNoPerm = await getTestAuthHeaders(UID_NO_PERM, { isSuperadmin: false, tenantId: TENANT_A, permissions: ['schedules:read'] });
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
});

after(async () => {
  // Limpia SOLO los overrides de los tenants descartables -- nunca el
  // default global (tenant_id IS NULL).
  await db.query(`DELETE FROM app_settings WHERE tenant_id IN (?, ?)`, [TENANT_A, TENANT_B]);
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await deleteTestUser(UID_NO_PERM);
  await deleteTestUser(UID_SUPERADMIN);
  await db.query(`DELETE FROM tenants WHERE id IN (?, ?)`, [TENANT_A, TENANT_B]);
  await closeDb();
});

test('POST /config/overtime-settings de un tenant no afecta a otro tenant', async () => {
  const postRes = await fetch(`${BASE_URL}/config/overtime-settings`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtimeCutoffTime: '11:11' })
  });
  assert.equal(postRes.status, 200);

  const getA = await fetch(`${BASE_URL}/config/overtime-settings`, { headers: headersA });
  const jsonA = await getA.json();
  assert.equal(jsonA.overtimeCutoffTime, '11:11', 'el tenant que lo configuro debe ver su propio valor');

  const getB = await fetch(`${BASE_URL}/config/overtime-settings`, { headers: headersB });
  const jsonB = await getB.json();
  assert.notEqual(jsonB.overtimeCutoffTime, '11:11', 'otro tenant NO debe heredar el override ajeno');
});

test('POST /config/campana-cutoff y /config/marker-max-gap-seconds tambien quedan aislados por tenant', async () => {
  await fetch(`${BASE_URL}/config/campana-cutoff`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campanaArrivalCutoffTime: '05:55' })
  });
  await fetch(`${BASE_URL}/config/marker-max-gap-seconds`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ markerMaxGapSeconds: 999 })
  });

  const campanaB = await (await fetch(`${BASE_URL}/config/campana-cutoff`, { headers: headersB })).json();
  assert.notEqual(campanaB.campanaArrivalCutoffTime, '05:55');

  const gapB = await (await fetch(`${BASE_URL}/config/marker-max-gap-seconds`, { headers: headersB })).json();
  assert.notEqual(gapB.markerMaxGapSeconds, 999);
});

test('sin permiso schedules:update, POST /config/overtime-settings responde 403', async () => {
  const res = await fetch(`${BASE_URL}/config/overtime-settings`, {
    method: 'POST',
    headers: { ...headersNoPerm, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtimeCutoffTime: '10:00' })
  });
  assert.equal(res.status, 403);
});

test('sin permiso schedules:read, GET /config/campana-cutoff responde 403', async () => {
  const headersNoRead = await getTestAuthHeaders('test-app-settings-no-read', { isSuperadmin: false, tenantId: TENANT_A, permissions: [] });
  const res = await fetch(`${BASE_URL}/config/campana-cutoff`, { headers: headersNoRead });
  assert.equal(res.status, 403);
  await deleteTestUser('test-app-settings-no-read');
});

test('/debug/status: 403 para no-superadmin, 200 para superadmin', async () => {
  const denied = await fetch(`${BASE_URL}/debug/status`, { headers: headersA });
  assert.equal(denied.status, 403);

  const allowed = await fetch(`${BASE_URL}/debug/status`, { headers: headersSuperadmin });
  assert.equal(allowed.status, 200);
});

test('/diagnostic/:badge/:month: 403 para no-superadmin', async () => {
  const res = await fetch(`${BASE_URL}/diagnostic/2525/2026-06`, { headers: headersA });
  assert.equal(res.status, 403);
});

test('/api/users/cleanup-duplicates: la ruta viva sin guard (borrado global sin filtro de tenant) se retiro', async () => {
  // Vivia sin NINGUN guard (cualquier app_user logueado podia dispararla,
  // de cualquier empresa) y borraba usuarios/asistencia de TODAS las
  // empresas sin distinguir tenant. Se paso a scripts/cleanup-duplicate-users.js
  // (uso manual, node scripts/cleanup-duplicate-users.js) -- ya no es un
  // endpoint HTTP.
  const cleanup = await fetch(`${BASE_URL}/api/users/cleanup-duplicates`, { headers: headersSuperadmin });
  assert.equal(cleanup.status, 404);
});
