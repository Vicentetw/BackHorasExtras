// firebaseEmail.js: que Firebase mande el email de contraseña (hallazgo F-04).
// Sin red: fetch simulado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enviarEmailDeContrasena, esDominioDePrueba } = require('../motor-laboral/services/firebaseEmail');

test('pide a Firebase un email de PASSWORD_RESET para esa direccion', async () => {
  let pedido = null;
  const fetchImpl = async (url, opts) => { pedido = { url, body: JSON.parse(opts.body) }; return { ok: true }; };
  const r = await enviarEmailDeContrasena('ana@empresa.com.ar', { fetchImpl });
  assert.deepEqual(r, { enviado: true });
  assert.match(pedido.url, /accounts:sendOobCode\?key=/);
  assert.deepEqual(pedido.body, { requestType: 'PASSWORD_RESET', email: 'ana@empresa.com.ar' });
});

test('si Firebase falla, no tira: devuelve el motivo', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'EMAIL_NOT_FOUND' });
  const r = await enviarEmailDeContrasena('ana@empresa.com.ar', { fetchImpl });
  assert.equal(r.enviado, false);
  assert.match(r.motivo, /400/);
  const r2 = await enviarEmailDeContrasena('ana@empresa.com.ar', { fetchImpl: async () => { throw new Error('sin red'); } });
  assert.deepEqual(r2, { enviado: false, motivo: 'sin red' });
});

test('no manda a dominios reservados para pruebas (los usan los tests)', async () => {
  let llamado = false;
  const r = await enviarEmailDeContrasena('x@example.com', { fetchImpl: async () => { llamado = true; return { ok: true }; } });
  assert.equal(llamado, false);
  assert.equal(r.motivo, 'dominio de prueba');
  assert.ok(esDominioDePrueba('a@sub.example.org'));
  assert.ok(esDominioDePrueba('a@algo.test'));
  assert.ok(!esDominioDePrueba('a@example.com.ar'), 'un dominio real que empieza parecido no es de prueba');
});
