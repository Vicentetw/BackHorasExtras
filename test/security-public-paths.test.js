// Bug real encontrado armando el agente de sincronizacion (Fase 18): un
// `startsWith` ingenuo en isPublicPath hacia que '/api/agent-keys' (que
// SI necesita Firebase + superadmin) matcheara el prefijo publico
// '/api/agent' (los endpoints del agente, sin Firebase a proposito) --
// '/api/agent-keys'.startsWith('/api/agent') es true. Eso hubiera dejado
// esa ruta de administracion totalmente sin autenticacion en produccion.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPublicPath } = require('../security');

const PUBLIC_PATHS = ['/api/public', '/api/agent'];

test('isPublicPath: la ruta exacta y sus subrutas SI matchean', () => {
  assert.equal(isPublicPath({ path: '/api/agent' }, PUBLIC_PATHS), true);
  assert.equal(isPublicPath({ path: '/api/agent/checkins' }, PUBLIC_PATHS), true);
  assert.equal(isPublicPath({ path: '/api/public/signup' }, PUBLIC_PATHS), true);
});

test('isPublicPath: una ruta HERMANA con el mismo prefijo de texto NO matchea (bug real)', () => {
  assert.equal(isPublicPath({ path: '/api/agent-keys' }, PUBLIC_PATHS), false);
  assert.equal(isPublicPath({ path: '/api/agent-keys/1/status' }, PUBLIC_PATHS), false);
});

test('isPublicPath: rutas sin relacion no matchean', () => {
  assert.equal(isPublicPath({ path: '/api/billing/plans' }, PUBLIC_PATHS), false);
  assert.equal(isPublicPath({ path: '/api/employees' }, PUBLIC_PATHS), false);
});
