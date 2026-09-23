// Dos marcadores seguidos: gana el ULTIMO.
//
// EL CASO, TAL COMO LO DESCRIBIO QUIEN OPERA EL SISTEMA
// ------------------------------------------------------
// "primero pone entrada particular o un 5 y resulta que era el 9 de hora
// extra, o sea si hay dos marcadores, toma el ultimo: ejemplo 5, pasan 3
// segundos y marca el 9, tomaria el 9 porque son dos marcadores".
//
// Alguien se equivoca de tecla, se da cuenta, y aprieta la correcta. Lo
// natural es que valga la segunda.
//
// POR QUE NO ALCANZABA CON QUE EL MAPA SE PISARA SOLO
// ----------------------------------------------------
// Dentro de una misma categoria ya funcionaba (un .set() pisa al anterior).
// El problema estaba ENTRE categorias, y no era nada obvio: los llamadores
// filtran los marcadores por categoria y corren la deteccion una vez por
// cada una. En la pasada de PARTICULAR, el marcador 9 (que es HE) no estaba
// en el mapa, caia como "ruido del reloj" y NO tocaba el marcador pendiente.
// O sea que el 5 seguia vivo, el 9 pasaba invisible, y el fichaje de la
// persona se llevaba el 5 -- exactamente lo que habia querido corregir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectMovements } = require('../motor-laboral/services/movementsCalculations');

const RELOJ_A = '172.155.0.30';
const RELOJ_B = '172.155.0.33';

// Igual que en produccion: 5 y 6 son PARTICULAR, 9 y 10 son HE.
const TODOS = {
  5: { category: 'PARTICULAR', direction: 'REGRESO' },
  6: { category: 'PARTICULAR', direction: 'SALIDA' },
  9: { category: 'HE', direction: 'SALIDA' },
  10: { category: 'HE', direction: 'REGRESO' },
};
const SOLO_PARTICULAR = { 5: TODOS[5], 6: TODOS[6] };
const SOLO_HE = { 9: TODOS[9], 10: TODOS[10] };

const t = (hhmmss) => new Date(`2026-06-04T${hhmmss}`);
const fichaje = (hora, userId, employeeId, machineIp = RELOJ_A) =>
  ({ checktime: t(hora), userId, employeeId, machineIp });
const marcador = (hora, userId, machineIp = RELOJ_A) => fichaje(hora, userId, null, machineIp);

const op = (markerMap) => ({ maxMarkerGapMs: 6000, todosLosMarcadores: TODOS });

// ---------------------------------------------------------------------------

test('EL CASO: aprieta el 5, se da cuenta, aprieta el 9 -> vale el 9', () => {
  const secuencia = [
    marcador('18:00:00', 5),   // se equivoco: regreso de salida particular
    marcador('18:00:03', 9),   // la correcta: inicio de hora extra
    fichaje('18:00:04', 2107, '2107'),
  ];

  // En la pasada de PARTICULAR no tiene que pasar NADA: el ultimo marcador
  // fue de otra categoria.
  const part = detectMovements(secuencia, SOLO_PARTICULAR, op());
  assert.equal(part.openEvents.size, 0, 'el 5 ya no vale: lo piso el 9');
  assert.equal(part.orphanReturns.length, 0, 'y tampoco vale como regreso huerfano');

  // En la pasada de HE si: la hora extra se abre.
  const he = detectMovements(secuencia, SOLO_HE, op());
  assert.equal(he.openEvents.size, 1);
  assert.equal(he.openEvents.get('2107').category, 'HE');
});

test('al reves: aprieta el 9 y despues el 5 -> vale el 5', () => {
  const secuencia = [
    marcador('18:00:00', 9),
    marcador('18:00:03', 5),
    fichaje('18:00:04', 2107, '2107'),
  ];

  const he = detectMovements(secuencia, SOLO_HE, op());
  assert.equal(he.openEvents.size, 0, 'el 9 ya no vale');

  const part = detectMovements(secuencia, SOLO_PARTICULAR, op());
  assert.equal(part.orphanReturns.length, 1, 'el 5 es un REGRESO: sale como regreso huerfano');
  assert.equal(part.orphanReturns[0].category, 'PARTICULAR');
});

test('dos de la MISMA categoria: tambien gana el ultimo', () => {
  // Esto ya funcionaba, pero conviene dejarlo congelado.
  const { openEvents, orphanReturns } = detectMovements([
    marcador('18:00:00', 5),   // REGRESO
    marcador('18:00:02', 6),   // SALIDA -- este vale
    fichaje('18:00:03', 2107, '2107'),
  ], SOLO_PARTICULAR, op());

  assert.equal(orphanReturns.length, 0, 'el 5 quedo pisado');
  assert.equal(openEvents.size, 1, 'vale el 6: abre una salida');
});

test('tres marcadores seguidos: vale el ultimo', () => {
  const secuencia = [
    marcador('18:00:00', 5),
    marcador('18:00:01', 6),
    marcador('18:00:02', 9),
    fichaje('18:00:03', 2107, '2107'),
  ];
  assert.equal(detectMovements(secuencia, SOLO_PARTICULAR, op()).openEvents.size, 0);
  assert.equal(detectMovements(secuencia, SOLO_HE, op()).openEvents.size, 1);
});

test('el de otra categoria solo pisa al de SU MISMO reloj', () => {
  // Dos personas, cada una en su aparato: la del reloj B aprieta el 9, y eso
  // no tiene por que anular el 6 que apreto la del reloj A.
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    marcador('18:00:01', 9, RELOJ_B),   // otra persona, otro aparato
    fichaje('18:00:02', 2107, '2107', RELOJ_A),
  ], SOLO_PARTICULAR, op());

  assert.equal(openEvents.size, 1, 'el 6 del reloj A sigue valiendo');
  assert.equal(openEvents.get('2107').category, 'PARTICULAR');
});

test('sin todosLosMarcadores, el comportamiento es el de antes', () => {
  // Compatibilidad: si un llamador no pasa el mapa completo, nada cambia.
  const { orphanReturns } = detectMovements([
    marcador('18:00:00', 5),
    marcador('18:00:03', 9),   // invisible para esta pasada, como antes
    fichaje('18:00:04', 2107, '2107'),
  ], SOLO_PARTICULAR, { maxMarkerGapMs: 6000 });

  assert.equal(orphanReturns.length, 1, 'sin el mapa completo, el 5 sigue valiendo');
});

test('un marcador que nadie consume no le queda a nadie', () => {
  // La otra mitad del problema, que NO se puede resolver: si alguien aprieta
  // un marcador y despues no ficha, no hay forma de saberlo. Lo unico que lo
  // acota es la ventana de tiempo, que es configurable por empresa
  // (/config/marker-max-gap-seconds).
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6),
    fichaje('18:00:30', 2107, '2107'),   // 30s > 6s de ventana
  ], SOLO_PARTICULAR, op());

  assert.equal(openEvents.size, 0, 'el marcador vencio y no se le atribuyo a nadie');
});
