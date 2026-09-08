// Bug real de produccion: upsertUsersBatch hacia hasta 2 consultas
// SECUENCIALES por usuario -- con un lote real de 500 usuarios (primera
// sincronizacion del agente en un sitio con historial) eso eran hasta 1000
// idas y vueltas UNA POR UNA a la base, suficiente para pasarse el timeout
// del request y devolver un 500. Reescrito con consultas bulk -- este test
// cubre que el comportamiento (insertar nuevos, actualizar solo si cambio
// el USERID de un badge existente, no tocar nada si ya esta igual, no
// romper con badges duplicados en el mismo lote) siga siendo el mismo.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { upsertUsersBatch } = require('../motor-laboral/services/checkinsIngestService');

// Badges descartables propios, con un prefijo bien identificable.
const PREFIX = 'bulk-test-';

after(async () => {
  await db.query(`DELETE FROM users WHERE Badgenumber LIKE ?`, [`${PREFIX}%`]);
  await db.query(`DELETE FROM users WHERE USERID BETWEEN 990000 AND 990600`);
  // Bug propio (no del fix real): sin esto, el pool de mysql2 mantiene
  // vivo el proceso -- todos los tests pasan pero `node --test` se
  // queda "colgado" esperando a que el proceso termine solo, hasta que
  // algo externo lo mata (y reporta el ARCHIVO como fallado, aunque cada
  // test individual haya pasado).
  await db.end().catch(() => {});
});

test('inserta usuarios nuevos en un solo lote grande (simula un sitio con mucho historial)', async () => {
  const records = Array.from({ length: 500 }, (_, i) => ({
    USERID: 990000 + i,
    Badgenumber: `${PREFIX}${i}`,
    Name: `Empleado Bulk ${i}`,
  }));

  const result = await upsertUsersBatch(records, db);
  assert.equal(result.upserted, 500);
  assert.equal(result.skipped, 0);

  const [[{ c }]] = await db.query(`SELECT COUNT(*) AS c FROM users WHERE Badgenumber LIKE ?`, [`${PREFIX}%`]);
  assert.equal(c, 500);
});

test('un badge que ya existe con el MISMO USERID no se toca', async () => {
  const [[before]] = await db.query(`SELECT Name FROM users WHERE Badgenumber = ?`, [`${PREFIX}0`]);
  assert.equal(before.Name, 'Empleado Bulk 0');

  await upsertUsersBatch([{ USERID: 990000, Badgenumber: `${PREFIX}0`, Name: 'Nombre que NO debería guardarse' }], db);

  const [[after_]] = await db.query(`SELECT Name FROM users WHERE Badgenumber = ?`, [`${PREFIX}0`]);
  assert.equal(after_.Name, 'Empleado Bulk 0', 'mismo USERID -- no deberia actualizar el nombre');
});

test('un badge que ya existe con OTRO USERID actualiza el nombre (sin tocar el USERID)', async () => {
  await upsertUsersBatch([{ USERID: 999999, Badgenumber: `${PREFIX}0`, Name: 'Nombre Corregido' }], db);

  const [[row]] = await db.query(`SELECT USERID, Name FROM users WHERE Badgenumber = ?`, [`${PREFIX}0`]);
  assert.equal(row.USERID, 990000, 'el USERID original no debe cambiar');
  assert.equal(row.Name, 'Nombre Corregido');
});

test('un badge duplicado DENTRO del mismo lote no rompe -- se queda con la ultima aparicion', async () => {
  // 990500+ -- fuera del rango 990000-990499 que ya uso el test de arriba
  // (bug propio encontrado escribiendo este mismo test: reusar un USERID
  // ya tomado rompe por la primary key, sin relacion con el fix real).
  const result = await upsertUsersBatch(
    [
      { USERID: 990500, Badgenumber: `${PREFIX}dup`, Name: 'Primera vez' },
      { USERID: 990500, Badgenumber: `${PREFIX}dup`, Name: 'Segunda vez (esta debe quedar)' },
    ],
    db
  );
  assert.equal(result.upserted, 1);

  const [[row]] = await db.query(`SELECT Name FROM users WHERE Badgenumber = ?`, [`${PREFIX}dup`]);
  assert.equal(row.Name, 'Segunda vez (esta debe quedar)');
});

test('filas invalidas (falta USERID/Badgenumber/Name) se cuentan como skipped, no rompen el lote', async () => {
  const result = await upsertUsersBatch(
    [
      { USERID: 990501, Badgenumber: `${PREFIX}valido`, Name: 'Válido' },
      { USERID: null, Badgenumber: `${PREFIX}invalido1`, Name: 'Sin USERID' },
      { USERID: 990502, Badgenumber: '', Name: 'Sin badge' },
    ],
    db
  );
  assert.equal(result.upserted, 1);
  assert.equal(result.skipped, 2);
});
