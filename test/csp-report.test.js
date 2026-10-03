// Receptor de reportes de la CSP del frontend (routes/cspReport.js).
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { extraer, anotar } = require('../routes/cspReport');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// Solo fetch: misma pausa que en cors.test.js (assert de libuv en Windows al
// forzar la salida).
after(() => new Promise((listo) => setTimeout(listo, 200)));

test('entiende el formato viejo (report-uri) y el nuevo (Reporting API)', () => {
  const viejo = extraer({ 'csp-report': {
    'document-uri': 'https://horasdedicacionavp.web.app/presentismo?x=1',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://malo.example/x.js',
    disposition: 'report'
  } });
  assert.deepEqual(viejo, [{ directiva: 'script-src-elem', bloqueado: 'https://malo.example/x.js', pagina: 'https://horasdedicacionavp.web.app/presentismo', modo: 'report' }]);

  const nuevo = extraer([{ type: 'csp-violation', body: { documentURL: 'https://horasdedicacionavp.web.app/', effectiveDirective: 'connect-src', blockedURL: 'https://otro.example', disposition: 'enforce' } }]);
  assert.equal(nuevo[0].directiva, 'connect-src');
  assert.equal(nuevo[0].modo, 'enforce');

  assert.deepEqual(extraer({}), [], 'cualquier otra cosa se ignora');
  assert.deepEqual(extraer(null), []);
});

test('la misma violacion se anota una sola vez por hora', () => {
  const v = { directiva: 'img-src', bloqueado: 'https://prueba-unica.example/a.png', pagina: 'https://x/', modo: 'report' };
  const t = 1_000_000_000_000;
  assert.equal(anotar(v, t), true);
  assert.equal(anotar(v, t + 1000), false);
  assert.equal(anotar(v, t + 2000), false);
  assert.equal(anotar(v, t + 61 * 60 * 1000), true, 'pasada la hora se vuelve a anotar');
});

test('servidor: acepta el reporte sin login y responde 204', async () => {
  const res = await fetch(`${BASE_URL}/api/public/csp-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': { 'document-uri': 'https://horasdedicacionavp.web.app/', 'effective-directive': 'img-src', 'blocked-uri': 'https://test-suite.example/' } })
  });
  await res.arrayBuffer();
  assert.equal(res.status, 204);
});

test('servidor: un cuerpo gigante se rechaza', async () => {
  const res = await fetch(`${BASE_URL}/api/public/csp-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(50_000) } })
  });
  await res.arrayBuffer();
  assert.equal(res.status, 413);
});
