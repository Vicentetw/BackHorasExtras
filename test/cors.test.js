// CORS: que sitios de internet pueden llamar a la API desde un navegador.
//
// Hallazgo real de la revision de seguridad (2026-10-03): el filtro estaba
// mal conectado a la libreria `cors` y dejaba pasar CUALQUIER origen. Se
// comprobo contra produccion mandando "Origin: https://sitio-malicioso.example"
// y el servidor respondia "Access-Control-Allow-Origin: https://sitio-malicioso.example".
// Estos tests fijan el comportamiento correcto para que no vuelva.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { origenPermitido } = require('../origenesPermitidos');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const AJENO = 'https://sitio-malicioso.example';

// Pide y lee el cuerpo entero, para no dejar conexiones a medio usar.
async function pedir(url, opciones) {
  const res = await fetch(url, opciones);
  await res.arrayBuffer();
  return res;
}

// Este archivo solo usa fetch (no abre la base, como casi todos los demas).
// Con --test-force-exit, Node 24 en Windows se cae al salir con un assert
// interno ("UV_HANDLE_CLOSING", libuv) si el proceso se corta mientras fetch
// todavia esta soltando sus recursos. Comprobado con un test de una sola
// linea: pasa siempre con esta pausa, falla siempre sin ella. Los demas tests
// no lo sufren porque cerrar la base al final ya les da ese tiempo.
after(() => new Promise((listo) => setTimeout(listo, 200)));

const PROPIO = 'https://horasdedicacionavp.web.app';

test('los sitios propios estan permitidos aunque no figuren en CORS_ORIGINS', () => {
  assert.equal(origenPermitido('https://horasdedicacionavp.web.app'), true);
  assert.equal(origenPermitido('https://horasdedicacionavp.firebaseapp.com'), true);
  // canal de vista previa de Firebase
  assert.equal(origenPermitido('https://horasdedicacionavp--prueba-csp-a1b2c3.web.app'), true);
});

test('un sitio ajeno no esta permitido, ni disfrazado de propio', () => {
  assert.equal(origenPermitido(AJENO), false);
  assert.equal(origenPermitido('http://horasdedicacionavp.web.app'), false, 'sin https');
  assert.equal(origenPermitido('https://horasdedicacionavp.web.app.sitio-malicioso.example'), false);
  assert.equal(origenPermitido('https://otrohorasdedicacionavp.web.app'), false);
  assert.equal(origenPermitido('https://horasdedicacionavp.web.app:8443'), false);
  assert.equal(origenPermitido('null'), false, 'iframes sandbox y archivos locales');
});

test('servidor: un navegador en un sitio ajeno recibe 403 y sin permiso de CORS', async () => {
  const res = await pedir(`${BASE_URL}/api/public/chat/estado`, {
    method: 'POST',
    headers: { Origin: AJENO, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('servidor: la consulta previa (preflight) de un sitio ajeno tampoco pasa', async () => {
  const res = await pedir(`${BASE_URL}/api/employees`, {
    method: 'OPTIONS',
    headers: { Origin: AJENO, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('servidor: el sitio propio recibe permiso, tambien en la consulta previa', async () => {
  const pre = await pedir(`${BASE_URL}/api/employees`, {
    method: 'OPTIONS',
    headers: { Origin: PROPIO, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }
  });
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get('access-control-allow-origin'), PROPIO);

  const res = await pedir(`${BASE_URL}/health`, { headers: { Origin: PROPIO } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), PROPIO);
});

test('servidor: sin Origin (agente de relojes, curl) funciona igual que siempre', async () => {
  const res = await pedir(`${BASE_URL}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});
