// Un marcador solo lo puede consumir un fichaje del MISMO reloj.
//
// EL PROBLEMA
// -----------
// El marcador no dice de quien es: nadie se identifica al apretarlo. El
// sistema se lo atribuye al proximo fichaje real. Con un solo reloj es
// razonable -- la persona aprieta el marcador y pone el dedo en el mismo
// aparato. Con dos deja de serlo: si alguien aprieta el marcador 9 (inicio
// de hora extra) en un reloj y otra persona pone el dedo en el OTRO un
// segundo despues, la hora extra se la llevaba la segunda.
//
// Medido en produccion el 2026-09-23: de 24.664 fichajes de marcador, 272
// fueron consumidos por un fichaje del otro reloj. Casi todos el marcador 9.
//
// Estos tests son, en su mayoria, los experimentos que planteo el analisis:
// marcador en A y persona en B; al reves; con dos personas distintas; y el
// orden de descarga.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectMovements } = require('../motor-laboral/services/movementsCalculations');

const RELOJ_A = '172.155.0.30';
const RELOJ_B = '172.155.0.33';

// 9 = inicio de hora extra (HE/SALIDA), 10 = fin. Mismos valores que produccion.
const MARCADORES = {
  9: { category: 'HE', direction: 'SALIDA' },
  10: { category: 'HE', direction: 'REGRESO' },
  6: { category: 'PARTICULAR', direction: 'SALIDA' },
  5: { category: 'PARTICULAR', direction: 'REGRESO' },
};

const t = (hhmmss) => new Date(`2026-06-04T${hhmmss}`);
const fichaje = (hora, userId, employeeId, machineIp) =>
  ({ checktime: t(hora), userId, employeeId, machineIp });

// El marcador es un fichaje sin empleado: no es una persona, es una orden.
const marcador = (hora, userId, machineIp) => fichaje(hora, userId, null, machineIp);

const opciones = { maxMarkerGapMs: 6000 };

// ---------------------------------------------------------------------------
// El caso que motivo todo
// ---------------------------------------------------------------------------

test('EL CASO: marcador en un reloj, otra persona ficha en el otro -> no se lo lleva', () => {
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    fichaje('18:00:01', 2107, '2107', RELOJ_B),
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 0,
    'el fichaje del otro reloj no tiene que abrir ninguna salida');
});

test('en cambio, en el MISMO reloj si se lo lleva (que es lo correcto)', () => {
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    fichaje('18:00:01', 2107, '2107', RELOJ_A),
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 1);
  assert.equal(openEvents.get('2107').category, 'PARTICULAR');
});

test('al reves: marcador en B, persona en A -> tampoco', () => {
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_B),
    fichaje('18:00:01', 2107, '2107', RELOJ_A),
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 0);
});

test('el marcador sigue esperando a quien SI es del mismo reloj', () => {
  // La primera version de este arreglo MATABA el marcador al ver un fichaje
  // de otro reloj. Estaba mal, y lo mostraron los datos: en 276 de los 277
  // casos cruzados de produccion, quien ficho nunca uso el reloj del
  // marcador. O sea que el marcador SI era de alguien -- de alguien parado
  // frente al otro aparato, cuyo fichaje llega un instante despues.
  // Matarlo le quitaba la hora extra a esa persona, que no hizo nada mal.
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    fichaje('18:00:01', 2107, '2107', RELOJ_B),   // ajeno al marcador: lo saltea
    fichaje('18:00:03', 3119, '3119', RELOJ_A),   // este SI es del reloj del marcador
  ], MARCADORES, opciones);

  assert.deepEqual([...openEvents.keys()], ['3119'],
    'la salida es de quien ficho en el mismo reloj, no del que paso por el medio');
});

test('un fichaje de otro reloj puede cerrar SU PROPIA salida abierta', () => {
  // El fichaje ajeno al marcador no puede quedar bloqueado: puede estar
  // cerrando una salida que ese mismo empleado tenia abierta, y eso no tiene
  // nada que ver con el marcador pendiente de otro aparato.
  const { closedEvents } = detectMovements([
    marcador('10:00:00', 6, RELOJ_B),
    fichaje('10:00:01', 2107, '2107', RELOJ_B),   // abre su salida
    marcador('12:00:00', 9, RELOJ_A),             // marcador de OTRO reloj, pendiente
    fichaje('12:00:01', 2107, '2107', RELOJ_B),   // vuelve: tiene que cerrar igual
  ], MARCADORES, opciones);

  assert.equal(closedEvents.length, 1, 'el regreso cierra su salida aunque haya un marcador ajeno');
  assert.equal(closedEvents[0].employeeId, '2107');
  assert.equal(closedEvents[0].regresoMarkerUserId, null,
    'y no se le atribuye el marcador del otro reloj');
});

test('dos personas distintas: la del mismo reloj se lo lleva, la otra no', () => {
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    fichaje('18:00:01', 2107, '2107', RELOJ_A),   // se lo lleva
    marcador('18:00:10', 6, RELOJ_A),
    fichaje('18:00:11', 3119, '3119', RELOJ_B),   // no
  ], MARCADORES, opciones);

  assert.deepEqual([...openEvents.keys()], ['2107']);
});

test('EL CASO REAL COMPLETO: dos personas marcando HE a la vez en dos relojes', () => {
  // Reproduce lo que pasa todos los dias a la salida del turno: dos personas
  // marcan hora extra al mismo tiempo, cada una en su aparato. Antes, el
  // primer marcador se lo llevaba quien fichara primero, viniera de donde
  // viniera -- y uno de los dos quedaba sin su hora extra.
  const { openEvents } = detectMovements([
    marcador('16:50:00', 9, RELOJ_A),
    marcador('16:50:00', 9, RELOJ_B),
    fichaje('16:50:01', 9995, '9995', RELOJ_B),   // el de B se lleva el de B
    fichaje('16:50:02', 3119, '3119', RELOJ_A),   // el de A se lleva el de A
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 2, 'cada uno tiene que quedarse con SU hora extra');
  assert.ok(openEvents.has('9995'));
  assert.ok(openEvents.has('3119'));
});

// ---------------------------------------------------------------------------
// Que no se rompa lo que ya andaba
// ---------------------------------------------------------------------------

test('sin dato de reloj (fichajes viejos) sigue funcionando igual que antes', () => {
  // 46.203 fichajes de produccion no tienen MACHINE_IP: son anteriores a que
  // el agente lo anotara. Si de un lado no se sabe, no se puede afirmar que
  // sean relojes distintos -- se deja pasar. Agregar informacion no puede
  // cambiar lo que ya estaba calculado.
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, null),
    fichaje('18:00:01', 2107, '2107', null),
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 1, 'sin reloj conocido, el comportamiento no cambia');
});

test('si solo uno de los dos tiene reloj conocido, tampoco se rechaza', () => {
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    fichaje('18:00:01', 2107, '2107', null),
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 1);
});

test('la ventana de tiempo sigue valiendo dentro del mismo reloj', () => {
  const { openEvents } = detectMovements([
    marcador('18:00:00', 6, RELOJ_A),
    fichaje('18:00:30', 2107, '2107', RELOJ_A),   // 30s > 6s: vencido
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 0, 'el marcador vencido sigue venciendo');
});

test('salida y regreso completos en el mismo reloj cierran el evento', () => {
  const { closedEvents } = detectMovements([
    marcador('10:00:00', 6, RELOJ_A),
    fichaje('10:00:01', 2107, '2107', RELOJ_A),
    marcador('12:00:00', 5, RELOJ_A),
    fichaje('12:00:01', 2107, '2107', RELOJ_A),
  ], MARCADORES, opciones);

  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].employeeId, '2107');
  assert.equal(closedEvents[0].category, 'PARTICULAR');
});

// ---------------------------------------------------------------------------
// El orden de descarga
// ---------------------------------------------------------------------------

test('el orden en que se pasan los fichajes no cambia el resultado', () => {
  // Lo que preocupaba del analisis: "si descargo primero el reloj A y despues
  // el B, ¿se procesa en el orden equivocado?". No: detectMovements ordena
  // por hora antes de interpretar (y la consulta que lo alimenta ya viene con
  // ORDER BY CHECKTIME). Este test lo congela para que nadie lo rompa.
  const cronologico = [
    fichaje('09:59:59', 3119, '3119', RELOJ_B),
    marcador('10:00:00', 6, RELOJ_A),
    fichaje('10:00:01', 2107, '2107', RELOJ_A),
  ];
  // El mismo dia, pero como llegaria si se bajara primero A y despues B.
  const porRelojes = [
    marcador('10:00:00', 6, RELOJ_A),
    fichaje('10:00:01', 2107, '2107', RELOJ_A),
    fichaje('09:59:59', 3119, '3119', RELOJ_B),
  ];

  const a = detectMovements(cronologico, MARCADORES, opciones);
  const b = detectMovements(porRelojes, MARCADORES, opciones);

  assert.deepEqual([...a.openEvents.keys()], [...b.openEvents.keys()]);
  assert.deepEqual([...a.openEvents.keys()], ['2107'],
    'la salida es de quien ficho en el mismo reloj que el marcador');
});

// ---------------------------------------------------------------------------
// El caso de la hora extra, que es el que mas aparece en los datos
// ---------------------------------------------------------------------------

test('hora extra: el marcador 9 de un reloj no le abre la HE a alguien del otro', () => {
  // Reproduce un caso real de produccion:
  //   2026-06-04 13:51:14  marcador 9 en .33  ->  usuario 9995 en .30 (1s)
  const { openEvents } = detectMovements([
    marcador('13:51:14', 9, RELOJ_B),
    fichaje('13:51:15', 9995, '9995', RELOJ_A),
  ], MARCADORES, opciones);

  assert.equal(openEvents.size, 0,
    'la hora extra no se le puede abrir a quien ficho en el otro aparato');
});
