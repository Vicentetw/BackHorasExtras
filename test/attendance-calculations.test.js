// Tests unitarios de las piezas de calculo compartidas entre /attendance-range
// (horasdedica2.js) y el motor diario (attendanceService.js), extraidas a
// motor-laboral/services/attendanceCalculations.js. No requieren DB ni backend
// levantado -- son funciones puras.
//
// Cubren a proposito los casos de tardanza justificada (excTo) que hoy no
// existen en datos reales (no hay ninguna userexclusion con excTo cargado
// todavia), para no perder cobertura de esa regla de negocio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getEntranceReference,
  resolveToleranceMinutes,
  resolveLateJustification,
  evaluateMultiVisitDay,
  findCrossingWorkBlock,
  stripOvernightCarryover,
  reassignOvernightCheckins
} = require('../motor-laboral/services/attendanceCalculations');

// ==========================
// Turnos que cruzan medianoche ("sereno") -- ver el comentario de cabecera
// de stripOvernightCarryover/reassignOvernightCheckins en
// attendanceCalculations.js para la explicacion completa del bug real que
// esto corrige (prueba de estres pre-venta, sept 2026).
// ==========================

const SERENO_SCHEDULE = {
  source: 'motor',
  blocks: [{ block_type: 'WORK', start_time: '22:00:00', end_time: '06:00:00', crosses_midnight: 1 }]
};
const NORMAL_SCHEDULE = {
  source: 'motor',
  blocks: [{ block_type: 'WORK', start_time: '08:00:00', end_time: '16:00:00', crosses_midnight: 0 }]
};

test('findCrossingWorkBlock: encuentra el bloque WORK con crosses_midnight, ignora el resto', () => {
  assert.equal(findCrossingWorkBlock(SERENO_SCHEDULE).start_time, '22:00:00');
  assert.equal(findCrossingWorkBlock(NORMAL_SCHEDULE), null);
  assert.equal(findCrossingWorkBlock(null), null);
  assert.equal(findCrossingWorkBlock({ blocks: [{ block_type: 'BREAK', crosses_midnight: 1 }] }), null); // BREAK no cuenta, solo WORK
});

test('stripOvernightCarryover: sin schedule del dia anterior, no filtra nada (comportamiento de siempre)', () => {
  const { checks, carryover } = stripOvernightCarryover(['2026-01-07 06:10:00', '2026-01-07 22:35:00'], null);
  assert.deepEqual(checks, ['2026-01-07 06:10:00', '2026-01-07 22:35:00']);
  assert.deepEqual(carryover, []);
});

test('stripOvernightCarryover: si el dia anterior cruzo medianoche, saca la marca de madrugada (es su salida)', () => {
  const { checks, carryover } = stripOvernightCarryover(['2026-01-07 06:10:00', '2026-01-07 22:35:00'], SERENO_SCHEDULE);
  assert.deepEqual(checks, ['2026-01-07 22:35:00']); // le queda SOLO la entrada de esta noche
  assert.deepEqual(carryover, ['2026-01-07 06:10:00']); // esto es la salida de la noche anterior
});

test('stripOvernightCarryover: una marca bien entrada la mañana (fuera del margen) NO se toca -- es una entrada nueva de verdad', () => {
  // Fin de turno 06:00 + 4hs de margen = 10:00. Una marca a las 11:00 ya no
  // se puede confundir con "la salida de anoche".
  const { checks, carryover } = stripOvernightCarryover(['2026-01-07 11:00:00'], SERENO_SCHEDULE);
  assert.deepEqual(checks, ['2026-01-07 11:00:00']);
  assert.deepEqual(carryover, []);
});

test('reassignOvernightCheckins: 3 noches seguidas, la 3ra con una llegada tarde real -- caso exacto de la prueba de estres', () => {
  // Mismo escenario verificado en vivo contra el servidor real: entra
  // 22:05/22:10 a horario las primeras dos noches, y 22:35 (media hora
  // tarde) la tercera. Antes del fix, el 07/01 daba "a horario" porque
  // tomaba la salida de las 06:10 como si fuera la entrada.
  const checksByDate = {
    '2026-01-05': ['2026-01-05 22:05:00'],
    '2026-01-06': ['2026-01-06 06:05:00', '2026-01-06 22:10:00'],
    '2026-01-07': ['2026-01-07 06:10:00', '2026-01-07 22:35:00'],
    '2026-01-08': ['2026-01-08 06:05:00']
  };
  const getSchedule = () => SERENO_SCHEDULE; // el mismo turno rige todos los dias en este caso
  const dates = ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
  const adjusted = reassignOvernightCheckins(checksByDate, getSchedule, dates);

  // Cada dia termina con [su propia entrada, la salida real que le llega
  // del dia siguiente] -- el encadenado hacia atras hace que la salida de
  // la noche del 06 (fichada el 07 a la madrugada) se le sume al 06, no al
  // 07, y asi sucesivamente. El 07 queda con SOLO su entrada tardia (22:35)
  // para el chequeo de tardanza -- ya no se mezcla con la salida de la
  // noche anterior.
  assert.deepEqual(adjusted['2026-01-05'], ['2026-01-05 22:05:00', '2026-01-06 06:05:00']);
  assert.deepEqual(adjusted['2026-01-06'], ['2026-01-06 22:10:00', '2026-01-07 06:10:00']);
  assert.deepEqual(adjusted['2026-01-07'], ['2026-01-07 22:35:00', '2026-01-08 06:05:00']);
  assert.deepEqual(adjusted['2026-01-08'], []); // se le saco la unica marca (era la salida del 07), no le queda ninguna entrada propia

  // Con "checks" ya corregido, el pipeline normal de tardanza SI detecta la llegada tarde.
  const primerFichaje07 = adjusted['2026-01-07'][0];
  const horaMin = Number(primerFichaje07.split(' ')[1].split(':')[0]) * 60 + Number(primerFichaje07.split(' ')[1].split(':')[1]);
  const { isLate, lateMinutes } = resolveLateJustification({
    firstMinutes: horaMin,
    entranceMinutes: 22 * 60, // 22:00
    toleranceMinutes: 10,
    exclusion: null
  });
  assert.equal(isLate, true);
  assert.equal(lateMinutes, 35);
});

test('reassignOvernightCheckins: un empleado con horario normal (no cruza medianoche) no se toca en nada', () => {
  const checksByDate = {
    '2026-01-05': ['2026-01-05 08:05:00'],
    '2026-01-06': ['2026-01-06 08:10:00']
  };
  const getSchedule = () => NORMAL_SCHEDULE;
  const dates = ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'];
  const adjusted = reassignOvernightCheckins(checksByDate, getSchedule, dates);
  assert.deepEqual(adjusted['2026-01-05'], ['2026-01-05 08:05:00']);
  assert.deepEqual(adjusted['2026-01-06'], ['2026-01-06 08:10:00']);
});

test('getEntranceReference: usa el bloque WORK de una plantilla motor si existe', () => {
  const schedule = {
    source: 'motor',
    timeEntrance: '08:00:00',
    blocks: [{ block_type: 'WORK', start_time: '07:00:00' }]
  };
  assert.equal(getEntranceReference(schedule), '07:00:00');
});

test('getEntranceReference: cae a timeEntrance si no hay bloques WORK', () => {
  assert.equal(getEntranceReference({ source: 'motor', timeEntrance: '07:00:00', blocks: [] }), '07:00:00');
  assert.equal(getEntranceReference({ source: 'legacy', timeEntrance: '07:00:00' }), '07:00:00');
});

test('resolveToleranceMinutes: 60 solo si la plantilla motor es FLEXIBLE, si no 10', () => {
  assert.equal(resolveToleranceMinutes({ source: 'motor', template_type: 'FLEXIBLE' }), 60);
  assert.equal(resolveToleranceMinutes({ source: 'motor', template_type: 'FIXED' }), 10);
  assert.equal(resolveToleranceMinutes({ source: 'legacy' }), 10);
});

test('resolveLateJustification: a tiempo (dentro de tolerancia)', () => {
  const r = resolveLateJustification({ firstMinutes: 425, entranceMinutes: 420, toleranceMinutes: 10, exclusion: null });
  assert.deepEqual(r, { isLate: false, lateMinutes: 0, justified: false });
});

test('resolveLateJustification: tarde, sin exclusion cargada -> no justificada', () => {
  const r = resolveLateJustification({ firstMinutes: 500, entranceMinutes: 420, toleranceMinutes: 10, exclusion: null });
  assert.equal(r.isLate, true);
  assert.equal(r.justified, false);
  assert.equal(r.lateMinutes, 80);
});

test('resolveLateJustification: tarde, exclusion sin excTo cargado -> justificada igual', () => {
  const r = resolveLateJustification({
    firstMinutes: 500,
    entranceMinutes: 420,
    toleranceMinutes: 10,
    exclusion: { excTo: null }
  });
  assert.equal(r.justified, true);
});

test('resolveLateJustification: tarde, llegada dentro de la ventana excTo -> justificada', () => {
  const r = resolveLateJustification({
    firstMinutes: 500, // 08:20
    entranceMinutes: 420, // 07:00
    toleranceMinutes: 10,
    exclusion: { excTo: '08:30' } // 510 min, 500 <= 510
  });
  assert.equal(r.justified, true);
});

test('resolveLateJustification: tarde, llegada despues de la ventana excTo -> no justificada', () => {
  const r = resolveLateJustification({
    firstMinutes: 500, // 08:20
    entranceMinutes: 420,
    toleranceMinutes: 10,
    exclusion: { excTo: '08:00' } // 480 min, 500 > 480
  });
  assert.equal(r.justified, false);
});

// Turno partido / visitas multiples (profesor, medico que va varias veces
// por dia): un dia con mas de un bloque WORK, cada uno con su propia
// entrada + salida. Caso real que motivo esto: "va 4 veces a la escuela".
test('evaluateMultiVisitDay: sin fichajes -> null (el llamador decide Absent/Excused)', () => {
  const workBlocks = [{ id: 1, start_time: '08:00:00', end_time: '12:00:00' }];
  assert.equal(evaluateMultiVisitDay({ workBlocks, checkinsSorted: [], toleranceMinutes: 10 }), null);
});

test('evaluateMultiVisitDay: las dos visitas completas y a tiempo -> OnTime, sin parcialidad', () => {
  const workBlocks = [
    { id: 1, block_name: 'Mañana', start_time: '08:00:00', end_time: '12:00:00' },
    { id: 2, block_name: 'Tarde', start_time: '16:00:00', end_time: '21:00:00' }
  ];
  const checkinsSorted = [
    '2026-09-04 08:02:00', '2026-09-04 12:00:00',
    '2026-09-04 16:00:00', '2026-09-04 21:05:00'
  ];
  const r = evaluateMultiVisitDay({ workBlocks, checkinsSorted, toleranceMinutes: 10, exclusion: null });
  assert.equal(r.isPartial, false);
  assert.equal(r.isLate, false);
  assert.equal(r.visits.length, 2);
  assert.equal(r.visits[0].missing, 'none');
  assert.equal(r.visits[1].missing, 'none');
});

test('evaluateMultiVisitDay: llega tarde a la primera visita -> Late (segun la 1ra visita)', () => {
  const workBlocks = [
    { id: 1, start_time: '08:00:00', end_time: '12:00:00' },
    { id: 2, start_time: '16:00:00', end_time: '21:00:00' }
  ];
  const checkinsSorted = [
    '2026-09-04 08:30:00', '2026-09-04 12:00:00',
    '2026-09-04 16:00:00', '2026-09-04 21:00:00'
  ];
  const r = evaluateMultiVisitDay({ workBlocks, checkinsSorted, toleranceMinutes: 10, exclusion: null });
  assert.equal(r.isLate, true);
  assert.equal(r.justified, false);
  assert.equal(r.lateMinutes, 30);
  assert.equal(r.isPartial, false);
});

test('evaluateMultiVisitDay: marco entrada de la 2da visita pero no la salida -> Ausente parcial', () => {
  const workBlocks = [
    { id: 1, start_time: '08:00:00', end_time: '12:00:00' },
    { id: 2, start_time: '16:00:00', end_time: '21:00:00' }
  ];
  const checkinsSorted = [
    '2026-09-04 08:00:00', '2026-09-04 12:00:00',
    '2026-09-04 16:00:00'
  ];
  const r = evaluateMultiVisitDay({ workBlocks, checkinsSorted, toleranceMinutes: 10, exclusion: null });
  assert.equal(r.isPartial, true);
  assert.equal(r.visits[0].missing, 'none');
  assert.equal(r.visits[1].missing, 'salida');
});

test('evaluateMultiVisitDay: no fue a la 2da visita en absoluto -> Ausente parcial, detalle marca cual bloque', () => {
  const workBlocks = [
    { id: 1, block_name: 'Mañana', start_time: '08:00:00', end_time: '12:00:00' },
    { id: 2, block_name: 'Tarde', start_time: '16:00:00', end_time: '21:00:00' }
  ];
  const checkinsSorted = ['2026-09-04 08:00:00', '2026-09-04 12:00:00'];
  const r = evaluateMultiVisitDay({ workBlocks, checkinsSorted, toleranceMinutes: 10, exclusion: null });
  assert.equal(r.isPartial, true);
  assert.equal(r.visits[0].missing, 'none');
  assert.equal(r.visits[1].missing, 'both');
  assert.equal(r.visits[1].blockName, 'Tarde');
});
