// El servidor NO acepta cuerpos comprimidos (2026-10-24). Ninguna parte del
// sistema los manda, y descomprimir lo que manda un desconocido es la puerta
// de la falla de Node de octubre 2026 (CVE-2026-111497, Brotli). Requiere el
// backend local corriendo.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const cuerpo = JSON.stringify({ hola: 'mundo' });
// Ese mismo cuerpo ya comprimido (generado una vez con node:zlib).
const COMPRIMIDO = {
  br: Buffer.from('iweAeyJob2xhIjoibXVuZG8ifQM=', 'base64'),
  gzip: Buffer.from('H4sIAAAAAAAACqtWysjPSVSyUsotzUvJV6oFAOKJ4cEQAAAA', 'base64'),
  deflate: Buffer.from('eJyrVsrIz0lUslLKLc1LyVeqBQAuNwWC', 'base64'),
};

for (const nombre of ['br', 'gzip', 'deflate']) {
  test(`un cuerpo con Content-Encoding: ${nombre} se rechaza sin descomprimir (415)`, async () => {
    const r = await fetch(`${URL}/api/no-existe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': nombre },
      body: COMPRIMIDO[nombre],
    });
    assert.equal(r.status, 415);
  });
}

test('un cuerpo normal (sin comprimir) se sigue aceptando', async () => {
  const r = await fetch(`${URL}/api/no-existe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo });
  assert.notEqual(r.status, 415);
});

test('el reporte de CSP y el webhook de MercadoPago tampoco descomprimen', async () => {
  // Cada uno tiene su propio lector del cuerpo (no el global).
  for (const [ruta, tipo] of [['/api/public/csp-report', 'application/csp-report'], ['/webhooks/mercadopago', 'application/json']]) {
    const r = await fetch(`${URL}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': tipo, 'Content-Encoding': 'br' },
      body: COMPRIMIDO.br,
    });
    assert.equal(r.status, 415, ruta);
  }
});

// En Windows, Node 24 se cae al cerrar el proceso de test si todavía hay
// conexiones de fetch cerrándose ("UV_HANDLE_CLOSING"): se les da un instante.
after(() => new Promise((r) => setTimeout(r, 300)));
