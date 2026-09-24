// Bug real encontrado armando el agente de sincronizacion (Fase 18): un
// `startsWith` ingenuo en isPublicPath hacia que '/api/agent-keys' (que
// SI necesita Firebase + superadmin) matcheara el prefijo publico
// '/api/agent' (los endpoints del agente, sin Firebase a proposito) --
// '/api/agent-keys'.startsWith('/api/agent') es true. Eso hubiera dejado
// esa ruta de administracion totalmente sin autenticacion en produccion.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPublicPath, claveDeReporte } = require('../security');

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

// ---------------------------------------------------------------------------
// Hallazgo F-06: limite propio para los endpoints caros (/attendance-range y
// compania), contado POR USUARIO y no por IP.
// ---------------------------------------------------------------------------

test('claveDeReporte: dos usuarios de la MISMA empresa no comparten cupo', () => {
  // Esta es la razon de ser del keyGenerator. Varias personas de una empresa
  // salen a internet por la misma IP publica: con un limite por IP compiten
  // entre ellas, y el castigo cae justo sobre el cliente que mas gente tiene
  // trabajando a la vez.
  const ip = '200.1.2.3';
  const a = claveDeReporte({ appUser: { id: 10 }, ip });
  const b = claveDeReporte({ appUser: { id: 11 }, ip });

  assert.notEqual(a, b, 'misma IP, usuarios distintos -> cupos distintos');
  assert.equal(a, 'u10');
});

test('claveDeReporte: el mismo usuario desde dos IPs comparte cupo', () => {
  // La contracara: cambiar de red (oficina a datos del telefono) no puede ser
  // una forma de duplicarse el limite.
  assert.equal(
    claveDeReporte({ appUser: { id: 10 }, ip: '200.1.2.3' }),
    claveDeReporte({ appUser: { id: 10 }, ip: '181.9.9.9' })
  );
});

test('claveDeReporte: sin usuario resuelto cae a la IP, y normaliza IPv6', () => {
  assert.equal(claveDeReporte({ ip: '200.1.2.3' }), '200.1.2.3');

  // Dos direcciones del MISMO /64 tienen que dar la misma clave: un rango
  // IPv6 entero suele pertenecer a un solo cliente, y sin normalizar alcanza
  // con cambiar de direccion en cada pedido para saltarse el limite.
  const a = claveDeReporte({ ip: '2001:db8:abcd:1234::1' });
  const b = claveDeReporte({ ip: '2001:db8:abcd:1234::99ff' });
  assert.equal(a, b, 'el mismo /64 cuenta como un solo cliente');
});
