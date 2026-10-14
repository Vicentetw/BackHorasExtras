// La limpieza de cuentas de login de prueba corre contra el Firebase que
// también usa producción. Este test fija el criterio: solo se borra una
// cuenta SIN email, SIN teléfono y SIN método de ingreso, y que tenga más de
// 15 minutos. Una cuenta de una persona real nunca cumple lo primero.
const test = require('node:test');
const assert = require('node:assert/strict');
const { esCuentaDePrueba } = require('../scripts/limpiar-datos-de-prueba');
const db = require('../db');

const AHORA = Date.parse('2026-10-14T12:00:00Z');
const hace = (min) => new Date(AHORA - min * 60 * 1000).toUTCString();
const cuenta = (extra) => ({ uid: 'x', providerData: [], metadata: { creationTime: hace(60) }, ...extra });

test('una cuenta de test (sin email ni método de ingreso, vieja) se borra', () => {
  assert.equal(esCuentaDePrueba(cuenta(), AHORA), true);
});

test('una cuenta con email NUNCA se borra, aunque no tenga método de ingreso', () => {
  assert.equal(esCuentaDePrueba(cuenta({ email: 'persona@empresa.com' }), AHORA), false);
});

test('una cuenta con contraseña o Google NUNCA se borra', () => {
  assert.equal(esCuentaDePrueba(cuenta({ providerData: [{ providerId: 'password' }] }), AHORA), false);
  assert.equal(esCuentaDePrueba(cuenta({ providerData: [{ providerId: 'google.com' }] }), AHORA), false);
});

test('una cuenta con teléfono NUNCA se borra', () => {
  assert.equal(esCuentaDePrueba(cuenta({ phoneNumber: '+5492804000000' }), AHORA), false);
});

test('una cuenta de test recién creada (otro test corriendo) se respeta', () => {
  assert.equal(esCuentaDePrueba(cuenta({ metadata: { creationTime: hace(5) } }), AHORA), false);
});

test('sin fecha de creación no se arriesga', () => {
  assert.equal(esCuentaDePrueba(cuenta({ metadata: {} }), AHORA), false);
});

test.after(() => db.end().catch(() => {}));
