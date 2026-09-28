// Correcciones manuales de marcadores: "este marcador era de otra persona".
//
// EL PROBLEMA
// -----------
// El sistema adivina de quien es cada marcador: se lo da al proximo fichaje
// real del mismo reloj. Si entre el marcador y el dedo de la persona se mete
// otra, la salida se la lleva la otra. Pedido del 2026-09-28: que alguien que
// estuvo ahi pueda decir de quien era, y que eso gane sobre la adivinanza.
//
// Ver "Correcciones manuales" en movementsCalculations.js. Estos tests son
// del motor puro (sin base); los del endpoint estan en
// marker-corrections.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectMovements, claveMarcador, filterEventsOpenedByFirstCheckinOfDay,
} = require('../motor-laboral/services/movementsCalculations');

const RELOJ_A = '172.155.0.30';
const RELOJ_B = '172.155.0.33';

const MARCADORES = {
  6: { category: 'PARTICULAR', direction: 'SALIDA' },
  5: { category: 'PARTICULAR', direction: 'REGRESO' },
};

const t = (hhmmss) => new Date(`2026-06-04T${hhmmss}`);
const fichaje = (hora, userId, employeeId, machineIp = RELOJ_A) =>
  ({ checktime: t(hora), userId, employeeId, machineIp });
const marcador = (hora, userId, machineIp = RELOJ_A) => fichaje(hora, userId, null, machineIp);

// W = quien se lo lleva por error; X = de quien era de verdad.
const W = '100';
const X = '200';

const opciones = { maxMarkerGapMs: 6000 };
const corregido = (hora, userId, employeeId) =>
  new Map([[claveMarcador(userId, t(hora)), { employeeId }]]);

const EL_CASO = [
  marcador('10:00:00', 6),
  fichaje('10:00:02', 100, W), // se metio W en el medio
  fichaje('10:00:08', 200, X), // X puso el dedo despues
];

test('sin correccion, el marcador se lo lleva quien ficho primero (el error que se quiere corregir)', () => {
  const { openEvents } = detectMovements(EL_CASO, MARCADORES, opciones);
  assert.ok(openEvents.has(W));
  assert.ok(!openEvents.has(X));
});

test('"era de X": la salida es de X, no de W', () => {
  const { openEvents } = detectMovements(EL_CASO, MARCADORES, {
    ...opciones, correccionesMarcadores: corregido('10:00:00', 6, X),
  });
  assert.ok(!openEvents.has(W), 'W ya no se lleva el marcador');
  const ev = openEvents.get(X);
  assert.ok(ev, 'X tiene la salida');
  assert.equal(ev.timeOut.getTime(), t('10:00:08').getTime(), 'la salida es la hora del fichaje de X');
  assert.equal(ev.salidaCorregida, true);
  assert.equal(ev.salidaMarkerAt.getTime(), t('10:00:00').getTime());
});

test('X lo recibe aunque su fichaje llegue minutos despues (fuera de la ventana de 6 s)', () => {
  const { openEvents } = detectMovements([
    marcador('10:00:00', 6),
    fichaje('10:04:00', 200, X),
  ], MARCADORES, { ...opciones, correccionesMarcadores: corregido('10:00:00', 6, X) });
  assert.ok(openEvents.has(X));
});

test('pero no si X recien ficha pasados los 10 minutos: la correccion no inventa nada', () => {
  const { openEvents } = detectMovements([
    marcador('10:00:00', 6),
    fichaje('10:10:01', 200, X),
  ], MARCADORES, { ...opciones, correccionesMarcadores: corregido('10:00:00', 6, X) });
  assert.equal(openEvents.size, 0);
});

test('X lo recibe aunque haya fichado en el otro reloj: lo dijo una persona', () => {
  const { openEvents } = detectMovements([
    marcador('10:00:00', 6, RELOJ_A),
    fichaje('10:00:05', 200, X, RELOJ_B),
  ], MARCADORES, { ...opciones, correccionesMarcadores: corregido('10:00:00', 6, X) });
  assert.ok(openEvents.has(X));
});

test('la regla de rebote no le quita a X un marcador que alguien confirmo', () => {
  // X ficha, aprieta el marcador y vuelve a fichar a los 10 s. Para el motor
  // la segunda lectura es rebote de la primera; con la correccion, no.
  const casos = [
    fichaje('10:00:00', 200, X),
    marcador('10:00:05', 6),
    fichaje('10:00:10', 200, X),
  ];
  assert.equal(detectMovements(casos, MARCADORES, opciones).openEvents.size, 0,
    'sin correccion se toma como rebote (comportamiento de siempre)');
  const { openEvents } = detectMovements(casos, MARCADORES, {
    ...opciones, correccionesMarcadores: corregido('10:00:05', 6, X),
  });
  assert.equal(openEvents.get(X).timeOut.getTime(), t('10:00:10').getTime());
});

test('"no era de nadie": el marcador se ignora', () => {
  const { openEvents } = detectMovements(EL_CASO, MARCADORES, {
    ...opciones, correccionesMarcadores: corregido('10:00:00', 6, null),
  });
  assert.equal(openEvents.size, 0);
});

test('"no era de nadie" no pisa el marcador que estaba esperando en ese reloj', () => {
  // Alguien aprieta el 6 y enseguida, sin querer, el 5. Sin correccion "gana
  // el ultimo" (el 5). Si se corrige el 5 como apretado por error, vale el 6.
  const { openEvents } = detectMovements([
    marcador('10:00:00', 6),
    marcador('10:00:02', 5),
    fichaje('10:00:04', 100, W),
  ], MARCADORES, { ...opciones, correccionesMarcadores: corregido('10:00:02', 5, null) });
  assert.ok(openEvents.has(W));
});

test('un marcador corregido no toca la cola del reloj: el de otra persona le sigue llegando', () => {
  // Dos personas apretaron el 6 casi juntas. El segundo se corrige como de X;
  // el primero sigue siendo de quien fiche despues en ese reloj (W).
  const { openEvents } = detectMovements([
    marcador('10:00:00', 6),
    marcador('10:00:01', 6),
    fichaje('10:00:02', 100, W),
    fichaje('10:00:30', 200, X),
  ], MARCADORES, { ...opciones, correccionesMarcadores: corregido('10:00:01', 6, X) });
  assert.ok(openEvents.has(W), 'W conserva el marcador de las 10:00:00');
  assert.ok(openEvents.has(X), 'X recibe el corregido');
});

test('la correccion tambien vale para el regreso', () => {
  const { closedEvents } = detectMovements([
    marcador('10:00:00', 6),
    fichaje('10:00:02', 200, X),
    marcador('12:00:00', 5),
    fichaje('12:00:03', 200, X),
  ], MARCADORES, { ...opciones, correccionesMarcadores: corregido('12:00:00', 5, X) });
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].regresoCorregido, true);
  assert.equal(closedEvents[0].salidaCorregida, false);
});

test('una salida corregida no se descarta por coincidir con el primer fichaje del dia', () => {
  // La regla AVILA sospecha de una salida abierta con el primer fichaje del
  // dia. Si una persona confirmo el marcador, la sospecha no aplica.
  const dia = [marcador('07:00:00', 6), fichaje('07:00:03', 200, X), fichaje('09:00:00', 200, X)];
  const sinCorregir = detectMovements(dia, MARCADORES, opciones).closedEvents;
  assert.equal(filterEventsOpenedByFirstCheckinOfDay(sinCorregir, dia).length, 0);
  const conCorreccion = detectMovements(dia, MARCADORES, {
    ...opciones, correccionesMarcadores: corregido('07:00:00', 6, X),
  }).closedEvents;
  assert.equal(filterEventsOpenedByFirstCheckinOfDay(conCorreccion, dia).length, 1);
});

test('sin correcciones el resultado es identico al de siempre', () => {
  const a = detectMovements(EL_CASO, MARCADORES, opciones);
  const b = detectMovements(EL_CASO, MARCADORES, { ...opciones, correccionesMarcadores: new Map() });
  assert.deepEqual([...a.openEvents.entries()], [...b.openEvents.entries()]);
});
