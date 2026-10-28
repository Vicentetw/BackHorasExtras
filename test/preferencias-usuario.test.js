// Preferencias de cada usuario (2026-10-27): hoy guardan qué cajas de ayuda
// dejó plegadas. Congela que: cualquiera guarda las suyas sin permisos, nadie
// ve las de otro, se validan clave y valor, y sin la migración 20261026 nada
// falla (responde "disponible: false" / "guardado: false").
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_ID = 4;
const UID_A = 'test-preferencias-a';
const UID_B = 'test-preferencias-b';

after(async () => {
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await closeDb();
});

const url = (clave = '') => `${BASE_URL}/api/app-users/me/preferencias${clave ? '/' + clave : ''}`;
const guardar = (headers, clave, valor) => fetch(url(clave), {
  method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ valor }),
});

test('un usuario sin ningún permiso guarda y lee sus preferencias; otro usuario no las ve', async () => {
  const a = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_ID, permissions: [] });
  const b = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_ID, permissions: [] });

  const r = await guardar(a, 'ayuda.usuarios', 'plegada');
  assert.equal(r.status, 200);
  const { guardado } = await r.json();

  const leidaA = await (await fetch(url(), { headers: a })).json();
  const leidaB = await (await fetch(url(), { headers: b })).json();
  if (!guardado) {
    // Sin la migración: no falla y no inventa nada.
    assert.equal(leidaA.disponible, false);
    assert.deepEqual(leidaA.preferencias, {});
    return;
  }
  assert.equal(leidaA.preferencias['ayuda.usuarios'], 'plegada');
  assert.equal(leidaB.preferencias['ayuda.usuarios'], undefined);

  // Cambiar el valor la reemplaza; null la borra.
  await guardar(a, 'ayuda.usuarios', 'abierta');
  assert.equal((await (await fetch(url(), { headers: a })).json()).preferencias['ayuda.usuarios'], 'abierta');
  assert.equal((await guardar(a, 'ayuda.usuarios', null)).status, 200);
  assert.equal((await (await fetch(url(), { headers: a })).json()).preferencias['ayuda.usuarios'], undefined);
});

test('clave o valor inválidos responden 400', async () => {
  const a = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_ID, permissions: [] });
  assert.equal((await guardar(a, 'MAYUS', 'x')).status, 400);
  assert.equal((await guardar(a, 'a'.repeat(101), 'x')).status, 400);
  assert.equal((await guardar(a, 'ayuda.x', 42)).status, 400);
  assert.equal((await guardar(a, 'ayuda.x', 'z'.repeat(256))).status, 400);
});

test('sin sesión responde 401', async () => {
  const res = await fetch(url());
  assert.equal(res.status, 401);
});
