// Dos relojes, un solo listado de usuarios.
//
// EL CASO REAL (2026-09-23)
// --------------------------
// AVP tiene dos relojes. La misma persona esta en los dos con el mismo
// numero, pero no con el mismo nombre: el usuario 105 figura como
// "AGUILAR GABRIEL" en 172.155.0.30 (donde ficha, 217 fichajes) y como
// "NN-105" en 172.155.0.33 (donde no ficho nunca).
//
// `users` es UNA lista por empresa, con clave (tenant_id, USERID): no tiene
// columna de reloj. Antes de este arreglo, el UPDATE pisaba el nombre
// siempre, asi que ganaba el ULTIMO reloj sincronizado. Gano "NN-105", y en
// la pantalla de Matching la persona aparecia sin nombre aunque uno de los
// dos relojes lo tuviera bien.
//
// La regla mira el CONTENIDO del nombre, no de que reloj vino: los dos son
// fuentes validas y cual tiene el dato bueno cambia usuario por usuario.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const {
  esNombreVacio, resolverNombre, upsertUsersBatch,
} = require('../motor-laboral/services/checkinsIngestService');
const { closeDb } = require('../test-helpers/firebaseTestAuth');

const TENANT_ID = 999935;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Multi Reloj (test)', 'tenant-multi-reloj-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_ID]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
});

after(async () => {
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]);
  await db.end().catch(() => {});
  await closeDb();
});

// ---------------------------------------------------------------------------
// La regla, sin base de datos
// ---------------------------------------------------------------------------

test('reconoce los nombres que no identifican a nadie', () => {
  for (const n of ['', '   ', 'NN-105', 'nn-3042', 'NN 7', 'NN', '105', '9370']) {
    assert.equal(esNombreVacio(n, 105, '105'), true, `"${n}" no deberia contar como nombre`);
  }
  assert.equal(esNombreVacio(null, 105, '105'), true);
});

test('reconoce los nombres de verdad, incluso raros', () => {
  for (const n of ['AGUILAR GABRIEL', 'NN', 'de HERNANDEZ, Carlos', 'IBAÑEZ', 'X Y']) {
    if (n === 'NN') continue; // "NN" solo es relleno, ya cubierto arriba
    assert.equal(esNombreVacio(n, 105, '105'), false, `"${n}" SI es un nombre`);
  }
  // Un apellido que empieza con NN pero sigue: no es relleno.
  assert.equal(esNombreVacio('NNAMDI, Chuk', 105, '105'), false);
});

test('el numero propio como nombre no cuenta, aunque sea otro numero', () => {
  assert.equal(esNombreVacio('105', 105, '105'), true);
  assert.equal(esNombreVacio('9370', 205, '9370'), true, 'coincide con el badge');
});

test('EL CASO 105: el relleno no pisa al nombre bueno', () => {
  assert.equal(resolverNombre('NN-105', 'AGUILAR GABRIEL', 105, '105'), null,
    'null = no tocar lo que ya esta');
});

test('pero un nombre de verdad SI reemplaza al relleno', () => {
  assert.equal(resolverNombre('AGUILAR GABRIEL', 'NN-105', 105, '105'), 'AGUILAR GABRIEL');
});

test('entre dos nombres de verdad gana el que llega (el reloj manda)', () => {
  // No se intenta adivinar cual es "mejor": si los dos son nombres de
  // persona, el mas reciente es el que el operador acaba de corregir.
  assert.equal(resolverNombre('IBAÑEZ, Héctor', 'IBAEZ', 2475, '2475'), 'IBAÑEZ, Héctor');
});

test('si los dos son relleno, se guarda el que llega (no hay nada que perder)', () => {
  assert.equal(resolverNombre('NN-105', '105', 105, '105'), 'NN-105');
});

// ---------------------------------------------------------------------------
// El recorrido completo, contra la base
// ---------------------------------------------------------------------------

test('sincronizar los dos relojes en cualquier orden deja el nombre bueno', async () => {
  const relojBueno = [{ USERID: 105, Badgenumber: '105', Name: 'AGUILAR GABRIEL' }];
  const relojSinNombre = [{ USERID: 105, Badgenumber: '105', Name: 'NN-105' }];

  // Orden que rompia antes: primero el bueno, despues el que no sabe.
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await upsertUsersBatch(relojBueno, db, TENANT_ID);
  await upsertUsersBatch(relojSinNombre, db, TENANT_ID);
  let [[fila]] = await db.query(
    'SELECT Name FROM users WHERE USERID = 105 AND tenant_id = ?', [TENANT_ID]);
  assert.equal(fila.Name, 'AGUILAR GABRIEL', 'el segundo reloj no tiene que borrar el nombre');

  // Y al reves: primero el que no sabe, despues el bueno.
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await upsertUsersBatch(relojSinNombre, db, TENANT_ID);
  await upsertUsersBatch(relojBueno, db, TENANT_ID);
  [[fila]] = await db.query(
    'SELECT Name FROM users WHERE USERID = 105 AND tenant_id = ?', [TENANT_ID]);
  assert.equal(fila.Name, 'AGUILAR GABRIEL', 'el nombre bueno tiene que entrar igual');
});

test('una correccion de nombre en el reloj sigue llegando', async () => {
  // Que no se pase de conservador: si alguien corrige el nombre en el reloj,
  // ese cambio TIENE que entrar. Es el caso de los nombres con enie que se
  // arreglaron en el agente.
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await upsertUsersBatch([{ USERID: 2475, Badgenumber: '2475', Name: 'IBAEZ' }], db, TENANT_ID);
  await upsertUsersBatch([{ USERID: 2475, Badgenumber: '2475', Name: 'IBAÑEZ, Héctor' }], db, TENANT_ID);
  const [[fila]] = await db.query(
    'SELECT Name FROM users WHERE USERID = 2475 AND tenant_id = ?', [TENANT_ID]);
  assert.equal(fila.Name, 'IBAÑEZ, Héctor');
});

test('el badge se actualiza aunque el nombre que llega sea peor', async () => {
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await upsertUsersBatch([{ USERID: 300, Badgenumber: '300', Name: 'PEREZ, Juan' }], db, TENANT_ID);
  await upsertUsersBatch([{ USERID: 300, Badgenumber: '3000', Name: 'NN-300' }], db, TENANT_ID);
  const [[fila]] = await db.query(
    'SELECT Badgenumber, Name FROM users WHERE USERID = 300 AND tenant_id = ?', [TENANT_ID]);
  assert.equal(fila.Badgenumber, '3000', 'el badge nuevo si entra');
  assert.equal(fila.Name, 'PEREZ, Juan', 'el nombre bueno se conserva');
});
