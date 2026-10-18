// Cifrado de la conexión con la base (dbTls.js, 2026-10-18). Requiere el MySQL
// local (Docker), que como Clever Cloud presenta un certificado firmado por su
// PROPIA autoridad: 'require' solo no conecta; 'require' + la autoridad fijada
// sí; y con otra autoridad (un impostor) se rechaza.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const tls = require('tls');
const { opcionesSsl, normalizarPem, cadenaDe } = require('../dbTls');

const datos = {
  host: process.env.MYSQL_ADDON_HOST, user: process.env.MYSQL_ADDON_USER, password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB, port: process.env.MYSQL_ADDON_PORT || 3306, connectTimeout: 10000,
};
async function probar(ssl) {
  let c;
  try { c = await mysql.createConnection({ ...datos, ssl }); return { ok: true, cadena: cadenaDe(c.connection.stream) }; }
  catch (err) { return { ok: false, motivo: err.code || err.message }; }
  finally { if (c) await c.end().catch(() => {}); }
}

test('reglas puras: modos y autoridad', () => {
  assert.equal(opcionesSsl({}), undefined, 'sin definir: sin TLS (como siempre)');
  assert.equal(opcionesSsl({ MYSQL_SSL: 'no-verify' }).rejectUnauthorized, false);
  assert.equal(opcionesSsl({ MYSQL_SSL: 'require' }).rejectUnauthorized, true);
  assert.equal(opcionesSsl({ MYSQL_SSL: 'require' }).ca, undefined);
  assert.equal(normalizarPem('no es un certificado'), null);
  assert.match(normalizarPem('-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'), /\nAAA\n/, 'acepta "\n" literales');
});

test('base con autoridad propia: require solo no conecta; con la autoridad fijada sí; con otra se rechaza', async () => {
  const leida = await probar(opcionesSsl({ MYSQL_SSL: 'no-verify' }));
  assert.ok(leida.ok && leida.cadena.raizPem, 'se puede leer la autoridad de la base');
  assert.equal((await probar(opcionesSsl({ MYSQL_SSL: 'require' }))).ok, false);
  assert.equal((await probar(opcionesSsl({ MYSQL_SSL: 'require', MYSQL_SSL_CA: leida.cadena.raizPem }))).ok, true);
  assert.equal((await probar(opcionesSsl({ MYSQL_SSL: 'require', MYSQL_SSL_CA: tls.rootCertificates[0] }))).ok, false, 'impostor');
});
