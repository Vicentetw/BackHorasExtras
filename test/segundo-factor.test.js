// Segundo factor (motor-laboral/services/segundoFactor.js, 2026-10-18).
// Lo que importa: si la empresa lo exige, el SERVIDOR no deja hacer nada sin
// él (no alcanza con esconderlo en la pantalla); el perfil y el propio estado
// se pueden ver igual (para poder activarlo); otra empresa no cambia; y el
// portal del empleado nunca lo pide.
// Requiere el backend local corriendo. Tenants descartables 999981 / 999980.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const sf = require('../motor-laboral/services/segundoFactor');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999981;
const OTRA = 999980;
let h, hOtra, hSuper;

before(async () => {
  for (const t of [T, OTRA]) await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [t, `Segundo factor ${t} (test)`, `segundo-factor-${t}-test`]);
  await db.query("DELETE FROM app_settings WHERE name = 'segundo_factor' AND tenant_id IN (?, ?)", [T, OTRA]);
  h = await getTestAuthHeaders('test-sf', { isSuperadmin: false, tenantId: T, permissions: ['attendance:read'] });
  hOtra = await getTestAuthHeaders('test-sf-otra', { isSuperadmin: false, tenantId: OTRA, permissions: ['attendance:read'] });
  hSuper = await getTestAuthHeaders('test-sf-super');
});

after(async () => {
  await db.query("DELETE FROM app_settings WHERE name = 'segundo_factor' AND tenant_id IN (?, ?)", [T, OTRA]);
  for (const uid of ['test-sf', 'test-sf-otra', 'test-sf-super']) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

const pedir = (ruta, headers, metodo = 'GET', body) => fetch(URL + ruta, {
  method: metodo, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

test('reglas puras: a quién se le exige y qué rutas quedan libres', () => {
  const niveles = { nivelEmpresa: 'obligatorio', nivelPlataforma: 'apagado' };
  assert.equal(sf.exigidoPara({ isSuperadmin: false, employeeId: null }, niveles), true, 'administrador de la empresa');
  assert.equal(sf.exigidoPara({ isSuperadmin: false, employeeId: 123 }, niveles), false, 'portal del empleado: nunca');
  assert.equal(sf.exigidoPara({ isSuperadmin: true, employeeId: null }, niveles), false, 'superadmin: decide la plataforma');
  assert.equal(sf.exigidoPara({ isSuperadmin: true }, { nivelEmpresa: 'apagado', nivelPlataforma: 'obligatorio' }), true);
  assert.equal(sf.exigidoPara({ isSuperadmin: false }, { nivelEmpresa: 'opcional' }), false, 'opcional no obliga');
  assert.equal(sf.sesionConSegundoFactor({ firebase: { sign_in_second_factor: 'totp' } }), true);
  assert.equal(sf.sesionConSegundoFactor({ firebase: { sign_in_provider: 'password' } }), false);
  assert.ok(sf.rutaLibre('/api/app-users/me') && sf.rutaLibre('/api/segundo-factor/estado'));
  assert.ok(!sf.rutaLibre('/attendance-range') && !sf.rutaLibre('/api/segundo-factorx'));
  assert.equal(sf.totpHabilitadoEn({ multiFactorConfig: { providerConfigs: [{ state: 'ENABLED', totpProviderConfig: {} }] } }), true);
  assert.equal(sf.totpHabilitadoEn({ multiFactorConfig: { state: 'DISABLED', providerConfigs: [] } }), false);
});

// (Con la OTRA empresa: la de este test se pone en "obligatorio" directo en la
// base en el test siguiente, y el servidor guarda el nivel 60 s en memoria;
// guardando desde la pantalla, en cambio, se aplica al instante: ver más abajo.)
test('apagado (por defecto): todo como siempre', async () => {
  assert.equal((await pedir('/attendance-range?from=2026-09-01&to=2026-09-01', hOtra)).status, 200);
  const e = await (await pedir('/api/segundo-factor/estado', hOtra)).json();
  assert.deepEqual([e.nivel, e.exigido, e.disponible], ['apagado', false, false]);
});

test('obligatorio: el servidor no deja hacer nada sin el segundo factor; el perfil y el estado sí', async () => {
  // Directo en la base: el PUT pide que Firebase tenga TOTP habilitado.
  await db.query("INSERT INTO app_settings (name, tenant_id, value) VALUES ('segundo_factor', ?, 'obligatorio') ON DUPLICATE KEY UPDATE value = 'obligatorio'", [T]);
  const r = await pedir('/attendance-range?from=2026-09-01&to=2026-09-01', h);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).codigo, 'SEGUNDO_FACTOR_REQUERIDO');
  assert.equal((await pedir('/api/app-users/me', h)).status, 200, 'el perfil se carga igual');
  const e = await (await pedir('/api/segundo-factor/estado', h)).json();
  assert.deepEqual([e.nivel, e.exigido, e.sesionConSegundoFactor], ['obligatorio', true, false]);
  assert.equal((await pedir('/attendance-range?from=2026-09-01&to=2026-09-01', hOtra)).status, 200, 'otra empresa no cambia');
});

test('el superadmin lo vuelve a apagar y se aplica en el momento (sin esperar el cache)', async () => {
  const r = await pedir(`/api/labor-engine/admin/tenants/${T}/segundo-factor`, hSuper, 'PUT', { nivel: 'apagado' });
  assert.equal(r.status, 200);
  assert.equal((await pedir('/attendance-range?from=2026-09-01&to=2026-09-01', h)).status, 200);
});

test('solo el superadmin decide; y no se puede prender si Firebase no tiene el método habilitado', async () => {
  assert.equal((await pedir(`/api/labor-engine/admin/tenants/${T}/segundo-factor`, h, 'PUT', { nivel: 'obligatorio' })).status, 403);
  assert.equal((await pedir(`/api/labor-engine/admin/tenants/${T}/segundo-factor`, hSuper, 'PUT', { nivel: 'cualquiera' })).status, 400);
  const fb = await (await pedir('/api/labor-engine/admin/segundo-factor/firebase', hSuper)).json();
  if (fb.totpHabilitado === false) {
    const r = await pedir(`/api/labor-engine/admin/tenants/${T}/segundo-factor`, hSuper, 'PUT', { nivel: 'obligatorio' });
    assert.equal(r.status, 400, 'sin TOTP en Firebase, un obligatorio dejaría a todos afuera');
    assert.match((await r.json()).error, /Firebase/);
  }
});

test('el superadmin ve quién tiene el segundo factor activado', async () => {
  const j = await (await pedir(`/api/labor-engine/admin/tenants/${T}/usuarios`, hSuper)).json();
  const u = j.usuarios.find((x) => /test-sf/.test(x.email) || x.email);
  assert.ok(u && 'segundoFactor' in u);
});
