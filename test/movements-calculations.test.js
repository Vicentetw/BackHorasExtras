// Tests unitarios del motor de deteccion de salidas (Particular/Oficial/Campana).
// No requieren DB ni backend levantado -- son funciones puras.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectMovements,
  closeOpenEventsAtScheduleExit,
  openOrphanReturnsAtScheduleEntrance,
  computeCampanaDias,
  diasInterioresDeCampana,
  regresoCuentaComoCampana,
  isFirstRealCheckinOfDay,
  filterEventsOpenedByFirstCheckinOfDay
} = require('../motor-laboral/services/movementsCalculations');

// Los eventos traen tambien la hora exacta de cada marcador y si vino de una
// correccion manual (ver marcadores-corregidos.test.js). Son datos para la
// pantalla; estos tests comparan lo que el motor DECIDE, asi que los sacan.
const DETALLE_DE_MARCADOR = ['salidaMarkerAt', 'salidaCorregida', 'regresoMarkerAt', 'regresoCorregido'];
function sinDetalleDeMarcador(valor) {
  if (Array.isArray(valor)) return valor.map(sinDetalleDeMarcador);
  const copia = { ...valor };
  DETALLE_DE_MARCADOR.forEach(k => delete copia[k]);
  return copia;
}

const PARTICULAR_MARKERS = {
  5: { category: 'PARTICULAR', direction: 'REGRESO' },
  6: { category: 'PARTICULAR', direction: 'SALIDA' }
};

const dt = (hms) => new Date(`2026-07-23T${hms}`);

test('detectMovements: caso real legajo 2518 (23/07/2026), con ruido y marcadores repetidos', () => {
  // Traza real: fichaje normal, 4 lecturas seguidas del marcador 6 (rebote del
  // lector), la salida real de RUBINO, y el regreso recien en la 3ra lectura
  // del marcador 5 (las dos anteriores fueron seguidas de ruido del reloj).
  const checkins = [
    { checktime: dt('09:41:23'), userId: 2518, employeeId: '2518' },
    { checktime: dt('09:42:58'), userId: 6, employeeId: null },
    { checktime: dt('09:43:10'), userId: 6, employeeId: null },
    { checktime: dt('09:43:21'), userId: 6, employeeId: null },
    { checktime: dt('09:43:33'), userId: 6, employeeId: null },
    { checktime: dt('09:43:38'), userId: 2518, employeeId: '2518' },
    { checktime: dt('10:43:09'), userId: 5, employeeId: null },
    { checktime: dt('10:43:13'), userId: 99999, employeeId: null }, // ruido del reloj
    { checktime: dt('10:56:40'), userId: 5, employeeId: null },
    { checktime: dt('10:56:44'), userId: 99999, employeeId: null }, // ruido del reloj
    { checktime: dt('11:05:13'), userId: 5, employeeId: null },
    { checktime: dt('11:05:16'), userId: 2518, employeeId: '2518' }
  ];

  const { closedEvents, openEvents } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(openEvents.size, 0);
  assert.equal(closedEvents.length, 1);
  assert.deepEqual(sinDetalleDeMarcador(closedEvents[0]), {
    employeeId: '2518',
    category: 'PARTICULAR',
    timeOut: dt('09:43:38'),
    timeIn: dt('11:05:16'),
    salidaMarkerUserId: 6,
    regresoMarkerUserId: 5
  });
});

test('detectMovements: doble lectura del mismo empleado cierra en vez de abrir un evento fantasma', () => {
  // Salida marcada, el empleado ficha (abre), y 6 segundos despues vuelve a
  // fichar precedido de OTRO marcador de salida -- ese segundo fichaje debe
  // CERRAR la salida abierta, no abrir una nueva de 6 segundos.
  const checkins = [
    { checktime: dt('14:34:00'), userId: 4, employeeId: null },
    { checktime: dt('14:34:02'), userId: 2609, employeeId: '2609' }, // abre OFICIAL
    { checktime: dt('14:34:06'), userId: 4, employeeId: null },
    { checktime: dt('14:34:08'), userId: 2609, employeeId: '2609' }  // cierra, no abre otra
  ];
  const markers = { 4: { category: 'OFICIAL', direction: 'SALIDA' } };

  const { closedEvents, openEvents } = detectMovements(checkins, markers);

  assert.equal(openEvents.size, 0);
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].timeOut.getTime(), dt('14:34:02').getTime());
  assert.equal(closedEvents[0].timeIn.getTime(), dt('14:34:08').getTime());
  assert.equal(closedEvents[0].salidaMarkerUserId, 4);
  assert.equal(closedEvents[0].regresoMarkerUserId, 4, 'el marcador 4 vuelto a fichar justo antes queda como diagnostico, aunque su direccion configurada sea SALIDA');
});

test('detectMovements: sin fichaje de regreso ese dia queda abierta', () => {
  const checkins = [
    { checktime: dt('09:00:00'), userId: 6, employeeId: null },
    { checktime: dt('09:00:05'), userId: 2525, employeeId: '2525' }
  ];
  const { closedEvents, openEvents } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(closedEvents.length, 0);
  assert.equal(openEvents.size, 1);
  assert.deepEqual(sinDetalleDeMarcador(openEvents.get('2525')), { category: 'PARTICULAR', timeOut: dt('09:00:05'), salidaMarkerUserId: 6 });
});

test('detectMovements: marcador de regreso sin salida abierta no arma un evento cerrado/abierto, pero se reporta como orphanReturn', () => {
  const checkins = [
    { checktime: dt('09:00:00'), userId: 5, employeeId: null }, // REGRESO sin salida previa
    { checktime: dt('09:00:05'), userId: 2525, employeeId: '2525' }
  ];
  const { closedEvents, openEvents, orphanReturns } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(closedEvents.length, 0);
  assert.equal(openEvents.size, 0);
  assert.equal(orphanReturns.length, 1);
  assert.deepEqual(sinDetalleDeMarcador(orphanReturns[0]), { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('09:00:05'), regresoMarkerUserId: 5 });
});

test('detectMovements: caso real Perrotta 02/07/2026 -- aviso de entrada particular (regreso antes del primer ingreso del dia)', () => {
  // Confirmado contra Checkins real: marcador 5 a las 08:43:10, Perrotta
  // (legajo 2525) ficha 7s despues (08:43:17), su primer fichaje del dia --
  // nunca ficho una "salida" ese dia porque la autorizacion se firma el dia
  // anterior. Debe aparecer como orphanReturn, no perderse.
  const checkins = [
    { checktime: dt('08:43:10'), userId: 5, employeeId: null },
    { checktime: dt('08:43:17'), userId: 2525, employeeId: '2525' }
  ];
  const { closedEvents, openEvents, orphanReturns } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(closedEvents.length, 0);
  assert.equal(openEvents.size, 0);
  assert.equal(orphanReturns.length, 1);
  assert.deepEqual(sinDetalleDeMarcador(orphanReturns[0]), { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('08:43:17'), regresoMarkerUserId: 5 });
});

test('detectMovements: un marcador vencido (>2min sin consumirse) no se le atribuye a otro empleado', () => {
  // Caso real Perrotta 02/07/2026: badge 6 a las 13:33:54 -- casi seguro para
  // otro empleado (el fichaje que le siguió, 4s después, no resolvió a
  // nadie). Nadie más fichó hasta que Perrotta apareció 6m25s después por un
  // motivo no relacionado (dos fichajes propios seguidos) -- sin vencimiento,
  // el sistema le abría y cerraba una "salida particular" de 12s que nunca
  // pasó. Con el vencimiento, el marcador ya no está vivo para cuando llega.
  const dt2 = (hms) => new Date(`2026-07-02T${hms}`);
  const checkins = [
    { checktime: dt2('13:33:54'), userId: 6, employeeId: null }, // marcador, probablemente para otro empleado
    { checktime: dt2('13:33:58'), userId: 9999, employeeId: null }, // ruido, no resuelve a nadie
    { checktime: dt2('13:40:19'), userId: 2525, employeeId: '2525' }, // Perrotta, 6m25s despues, sin relacion
    { checktime: dt2('13:40:31'), userId: 2525, employeeId: '2525' }
  ];
  const { closedEvents, openEvents, orphanReturns } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(closedEvents.length, 0, 'no debe generar un evento cerrado de 12 segundos');
  assert.equal(openEvents.size, 0);
  assert.equal(orphanReturns.length, 0);
});

test('detectMovements: dentro de la ventana default (30s), el marcador sigue siendo valido', () => {
  const dt2 = (hms) => new Date(`2026-07-02T${hms}`);
  const checkins = [
    { checktime: dt2('13:33:54'), userId: 6, employeeId: null },
    { checktime: dt2('13:34:15'), userId: 2525, employeeId: '2525' } // 21s despues, todavia valido
  ];
  const { openEvents } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(openEvents.size, 1);
  assert.deepEqual(sinDetalleDeMarcador(openEvents.get('2525')), { category: 'PARTICULAR', timeOut: dt2('13:34:15'), salidaMarkerUserId: 6 });
});

test('detectMovements: rebote del propio empleado no consume el marcador de OTRO empleado fichado en el medio', () => {
  // Caso real: SANTIBAÑEZ (18/08/2026) fichó dos veces a 12s de distancia
  // (13:37:29 y 13:37:41) -- el mismo rebote de lector ya documentado para
  // marcadores, pero del lado del empleado. En el medio, OTRO empleado
  // fichó el marcador 8 (CAMPANA/SALIDA) a las 13:37:34. Sin el resguardo,
  // la segunda lectura de SANTIBAÑEZ "abria" una salida a Campaña que en
  // realidad era ajena -- aparecia el mismo fichaje como Campaña Y como
  // Hora Extra en los informes.
  const dt2 = (hms) => new Date(`2026-08-18T${hms}`);
  const markers = { 8: { category: 'CAMPANA', direction: 'SALIDA' } };
  const checkins = [
    { checktime: dt2('13:37:29'), userId: 2446, employeeId: '2446' }, // 1ra lectura, sin marcador previo relevante
    { checktime: dt2('13:37:34'), userId: 8, employeeId: null },      // marcador de OTRO empleado
    { checktime: dt2('13:37:41'), userId: 2446, employeeId: '2446' }, // 2da lectura (rebote), 12s despues de la propia
    { checktime: dt2('16:49:07'), userId: 2446, employeeId: '2446' }  // ultimo fichaje del dia
  ];

  const { closedEvents, openEvents, orphanReturns } = detectMovements(checkins, markers);

  assert.equal(closedEvents.length, 0, 'no debe generar una salida a Campaña que en realidad es un rebote');
  assert.equal(openEvents.size, 0);
  assert.equal(orphanReturns.length, 0);
});

test('detectMovements: dos lecturas propias mas alla de la ventana de rebote SI cuentan como dos acciones distintas', () => {
  // Mismo escenario que el anterior, pero con 25s entre las dos lecturas
  // propias (por encima del default de 20s) -- ya no es un rebote de
  // lector, es plausible que sea una accion real repetida, y el marcador
  // se atribuye normalmente.
  const dt2 = (hms) => new Date(`2026-08-18T${hms}`);
  const markers = { 8: { category: 'CAMPANA', direction: 'SALIDA' } };
  const checkins = [
    { checktime: dt2('13:37:00'), userId: 2446, employeeId: '2446' },
    { checktime: dt2('13:37:10'), userId: 8, employeeId: null },
    { checktime: dt2('13:37:25'), userId: 2446, employeeId: '2446' } // 25s despues de la propia anterior
  ];

  const { openEvents } = detectMovements(checkins, markers);

  assert.equal(openEvents.size, 1);
  assert.deepEqual(sinDetalleDeMarcador(openEvents.get('2446')), { category: 'CAMPANA', timeOut: dt2('13:37:25'), salidaMarkerUserId: 8 });
});

// ============================================================================
// Rebote refinado (opcion reboteRefinado) -- ver el comentario en
// movementsCalculations.js. Casos reales de AVP, medidos con
// DIAGNOSTICO_CAMPANA_REBOTE_DETALLE.sql (79 de 582 salidas a campaña perdidas).
// ============================================================================

const CAMPANA_MARKERS = {
  7: { category: 'CAMPANA', direction: 'REGRESO' },
  8: { category: 'CAMPANA', direction: 'SALIDA' },
};
const IP = '172.155.0.33';
const lect = (iso, userId, employeeId) => ({ checktime: new Date(iso), userId, employeeId, machineIp: IP });

// OLGUIN, legajo 2555 (USERID 159), agosto 2026, tal cual esta en Checkins.
const OLGUIN_AGOSTO = [
  lect('2026-08-01T19:23:03', 7, null), lect('2026-08-01T19:23:06', 159, '2555'),
  lect('2026-08-03T07:58:13', 159, '2555'), lect('2026-08-03T07:58:19', 8, null), lect('2026-08-03T07:58:22', 159, '2555'),
  lect('2026-08-15T20:33:37', 7, null), lect('2026-08-15T20:33:40', 159, '2555'),
  lect('2026-08-17T08:01:07', 159, '2555'), lect('2026-08-17T08:01:15', 8, null), lect('2026-08-17T08:01:19', 159, '2555'),
  lect('2026-08-29T12:48:58', 7, null), lect('2026-08-29T12:49:01', 159, '2555'),
  lect('2026-08-31T07:56:59', 159, '2555'), lect('2026-08-31T07:57:05', 8, null), lect('2026-08-31T07:57:07', 159, '2555'),
];

test('rebote refinado: sin la opcion, OLGUIN sigue sin campañas (el comportamiento de siempre no cambia)', () => {
  const { closedEvents, openEvents } = detectMovements(OLGUIN_AGOSTO, CAMPANA_MARKERS, { maxMarkerGapMs: 6000 });
  assert.equal(closedEvents.length, 0);
  assert.equal(openEvents.size, 0);
});

test('rebote refinado: caso OLGUIN (lectura, marcador, lectura) -- detecta las dos campañas de agosto y la abierta del 31', () => {
  const { closedEvents, openEvents } = detectMovements(OLGUIN_AGOSTO, CAMPANA_MARKERS, { maxMarkerGapMs: 6000, reboteRefinado: true });

  assert.deepEqual(
    closedEvents.map(e => [e.timeOut.getTime(), e.timeIn.getTime()]),
    [
      [new Date('2026-08-03T07:58:22').getTime(), new Date('2026-08-15T20:33:40').getTime()],
      [new Date('2026-08-17T08:01:19').getTime(), new Date('2026-08-29T12:49:01').getTime()],
    ]
  );
  assert.equal(closedEvents[0].salidaMarkerUserId, 8);
  assert.equal(closedEvents[0].regresoMarkerUserId, 7);
  assert.equal(openEvents.get('2555').timeOut.getTime(), new Date('2026-08-31T07:57:07').getTime());
});

test('rebote refinado: forma A (marcador, lectura, lectura) -- el rebote no cierra la campaña que acaba de abrirse', () => {
  // Legajo 9448, 05/01/2026: 07:05:31 marcador 8, 07:05:34 y 07:05:37 lecturas.
  // Volvio a fichar 107 horas despues. Sin la opcion quedaba una campaña de 3 s.
  const checkins = [
    lect('2026-01-05T07:05:31', 8, null),
    lect('2026-01-05T07:05:34', 9448, '9448'),
    lect('2026-01-05T07:05:37', 9448, '9448'),
    lect('2026-01-09T18:10:00', 9448, '9448'),
  ];

  const antes = detectMovements(checkins, CAMPANA_MARKERS, { maxMarkerGapMs: 6000 });
  assert.equal(antes.closedEvents[0].timeIn.getTime(), new Date('2026-01-05T07:05:37').getTime(), 'documenta el bug: se cerraba a los 3 s');

  const { closedEvents } = detectMovements(checkins, CAMPANA_MARKERS, { maxMarkerGapMs: 6000, reboteRefinado: true });
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].timeOut.getTime(), new Date('2026-01-05T07:05:34').getTime());
  assert.equal(closedEvents[0].timeIn.getTime(), new Date('2026-01-09T18:10:00').getTime());
});

test('rebote refinado: caso SANTIBAÑEZ sigue protegido aun con la ventana default de 30 s', () => {
  // Datos reales (con reloj): 13:37:29 ficha, 13:37:34 marcador 8, 13:37:41
  // ficha. El marcador esta a 5 s de la 1ra y a 7 s de la 2da: no es de la 2da.
  const checkins = [
    lect('2026-08-18T13:37:29', 2446, '2446'),
    lect('2026-08-18T13:37:34', 8, null),
    lect('2026-08-18T13:37:41', 2446, '2446'),
    lect('2026-08-18T16:49:07', 2446, '2446'),
  ];
  const { closedEvents, openEvents, orphanReturns } = detectMovements(checkins, CAMPANA_MARKERS, { reboteRefinado: true });
  assert.equal(closedEvents.length, 0);
  assert.equal(openEvents.size, 0);
  assert.equal(orphanReturns.length, 0);
});

test('rebote refinado: marcador a la misma distancia de las dos lecturas es de la segunda', () => {
  // Legajo 9404, 11/05/2026: 07:38:48 ficha, 07:38:54 marcador, 07:39:00 ficha
  // (6 s y 6 s). Volvio a fichar 778 horas despues.
  const checkins = [
    lect('2026-05-11T07:38:48', 9404, '9404'),
    lect('2026-05-11T07:38:54', 8, null),
    lect('2026-05-11T07:39:00', 9404, '9404'),
  ];
  const { openEvents } = detectMovements(checkins, CAMPANA_MARKERS, { maxMarkerGapMs: 6000, reboteRefinado: true });
  assert.equal(openEvents.get('9404').timeOut.getTime(), new Date('2026-05-11T07:39:00').getTime());
});

test('rebote refinado: la doble lectura con un marcador nuevo en el medio sigue cerrando (mismo resultado que sin la opcion)', () => {
  const checkins = [
    { checktime: dt('14:34:00'), userId: 4, employeeId: null },
    { checktime: dt('14:34:02'), userId: 2609, employeeId: '2609' },
    { checktime: dt('14:34:06'), userId: 4, employeeId: null },
    { checktime: dt('14:34:08'), userId: 2609, employeeId: '2609' },
  ];
  const markers = { 4: { category: 'OFICIAL', direction: 'SALIDA' } };
  assert.deepEqual(
    detectMovements(checkins, markers, { reboteRefinado: true }),
    detectMovements(checkins, markers)
  );
});

test('diasInterioresDeCampana: OLGUIN 03/08 -> 15/08 son del 04 al 14 (los extremos ya cuentan por sus fichajes)', () => {
  const dias = diasInterioresDeCampana(new Date('2026-08-03T07:58:22'), new Date('2026-08-15T20:33:40'), '2026-08-01', '2026-08-31');
  assert.equal(dias.length, 11);
  assert.equal(dias[0], '2026-08-04');
  assert.equal(dias[dias.length - 1], '2026-08-14');
});

test('diasInterioresDeCampana: campaña abierta llega hasta la fecha consultada, sin inventar un regreso', () => {
  assert.deepEqual(
    diasInterioresDeCampana(new Date('2026-08-31T07:57:07'), null, '2026-08-01', '2026-09-03'),
    ['2026-09-01', '2026-09-02', '2026-09-03']
  );
});

test('diasInterioresDeCampana: se recorta al rango pedido (campaña que empezo el mes anterior)', () => {
  assert.deepEqual(
    diasInterioresDeCampana(new Date('2026-07-20T08:00:00'), new Date('2026-08-03T19:00:00'), '2026-08-01', '2026-08-31'),
    ['2026-08-01', '2026-08-02']
  );
});

test('diasInterioresDeCampana: salida y regreso el mismo dia o al dia siguiente no dejan dias interiores', () => {
  assert.deepEqual(diasInterioresDeCampana(new Date('2026-08-10T08:00:00'), new Date('2026-08-10T18:00:00'), '2026-08-01', '2026-08-31'), []);
  assert.deepEqual(diasInterioresDeCampana(new Date('2026-08-10T08:00:00'), new Date('2026-08-11T09:00:00'), '2026-08-01', '2026-08-31'), []);
});

test('regresoCuentaComoCampana: con corte 09:00, volver a las 20:39 cuenta como campaña y a las 08:00 no', () => {
  // OLGUIN volvio el 11/09/2026 a las 20:39: ese dia lo paso viajando.
  assert.equal(regresoCuentaComoCampana(new Date('2026-09-11T20:39:00'), '09:00'), true);
  // Volver a las 08:00 es llegar a tiempo para trabajar: dia normal.
  assert.equal(regresoCuentaComoCampana(new Date('2026-09-11T08:00:00'), '09:00'), false);
  // Justo a la hora de corte ya cuenta (mismo criterio que computeCampanaDias).
  assert.equal(regresoCuentaComoCampana(new Date('2026-09-11T09:00:00'), '09:00'), true);
  // Campaña abierta: no hay regreso.
  assert.equal(regresoCuentaComoCampana(null, '09:00'), false);
});

test('regresoCuentaComoCampana y computeCampanaDias usan la misma regla (el reporte y Presentismo no pueden contar distinto)', () => {
  const salida = new Date('2026-09-07T07:39:00');
  for (const hora of ['06:00', '08:59', '09:00', '20:39']) {
    const regreso = new Date(`2026-09-11T${hora}:00`);
    const diasReporte = computeCampanaDias(salida, regreso, '09:00');
    assert.equal(diasReporte === 5, regresoCuentaComoCampana(regreso, '09:00'), hora);
  }
});

test('closeOpenEventsAtScheduleExit: cierra con el horario de salida resuelto', () => {
  const openEvents = new Map([
    ['2525', { category: 'PARTICULAR', timeOut: dt('09:00:05'), salidaMarkerUserId: 6 }]
  ]);
  const exitTimeByEmployeeId = new Map([['2525', dt('13:40:00')]]);

  const result = closeOpenEventsAtScheduleExit(openEvents, exitTimeByEmployeeId);

  assert.deepEqual(sinDetalleDeMarcador(result), [{
    employeeId: '2525',
    category: 'PARTICULAR',
    timeOut: dt('09:00:05'),
    timeIn: dt('13:40:00'),
    hasReturn: false,
    salidaMarkerUserId: 6,
    regresoMarkerUserId: null
  }]);
});

test('closeOpenEventsAtScheduleExit: si la salida real ocurrio DESPUES del horario de salida programado, no sintetiza el regreso (evita una duracion negativa)', () => {
  // Simetrico al caso de VERA (arriba): una salida real tarde (ej. 22:00)
  // con el horario de salida programado del dia (13:40 default) cayendo
  // ANTES -- "cerrar" ahi daria una duracion negativa. El frontend ya
  // muestra "Sin regreso" para hasReturn=false sin importar timeIn, pero
  // "Duracion" si usa timeIn -- se descarta en vez de mostrar un negativo.
  const openEvents = new Map([
    ['2525', { category: 'PARTICULAR', timeOut: dt('22:00:00'), salidaMarkerUserId: 6 }]
  ]);
  const exitTimeByEmployeeId = new Map([['2525', dt('13:40:00')]]);

  const result = closeOpenEventsAtScheduleExit(openEvents, exitTimeByEmployeeId);

  assert.equal(result[0].timeIn, null, 'no debe sintetizar un regreso que queda antes de la salida real');
  assert.equal(result[0].timeOut.getTime(), dt('22:00:00').getTime());
});

test('openOrphanReturnsAtScheduleEntrance: sintetiza la salida con el horario de entrada programado', () => {
  // Caso real Perrotta 02/07/2026: sin salida abierta, entrada particular a
  // las 08:43:17, con horario de entrada programado 07:00 -- esto es lo que
  // debe aparecer en salidas.html (Particular) como "duración" de la salida
  // particular, igual que cualquier otra fila.
  const orphanReturns = [
    { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('08:43:17'), regresoMarkerUserId: 5 }
  ];
  const entranceTimeByEmployeeId = new Map([['2525', dt('07:00:00')]]);

  const result = openOrphanReturnsAtScheduleEntrance(orphanReturns, entranceTimeByEmployeeId);

  assert.deepEqual(sinDetalleDeMarcador(result), [{
    employeeId: '2525',
    category: 'PARTICULAR',
    timeOut: dt('07:00:00'),
    timeIn: dt('08:43:17'),
    hasReturn: true,
    salidaMarkerUserId: null,
    regresoMarkerUserId: 5
  }]);
});

test('openOrphanReturnsAtScheduleEntrance: si el horario de entrada programado cae DESPUES del regreso real, no se sintetiza (evita una duracion negativa)', () => {
  // Caso real: VERA Tedy Oscar, legajo 9394, 01/04/2026 -- regreso real
  // (marcador 3) a las 00:04, con horario de entrada programado 07:00 para
  // ESE dia -- usar 07:00 como "salida" daria una salida DESPUES del
  // regreso (duracion "-7h -56m", sin sentido). Se deja sin salida en vez
  // de inventar un dato que contradice al fichaje real.
  const orphanReturns = [
    { employeeId: '9394', category: 'OFICIAL', timeIn: dt('00:04:00'), regresoMarkerUserId: 3 }
  ];
  const entranceTimeByEmployeeId = new Map([['9394', dt('07:00:00')]]);

  const result = openOrphanReturnsAtScheduleEntrance(orphanReturns, entranceTimeByEmployeeId);

  assert.equal(result[0].timeOut, null, 'no debe sintetizar una salida que queda despues del regreso real');
  assert.equal(result[0].timeIn.getTime(), dt('00:04:00').getTime());
});

test('computeCampanaDias: regreso antes del horario de corte no cuenta el ultimo dia', () => {
  const timeOut = new Date('2026-08-10T14:00:00');
  const timeIn = new Date('2026-08-13T08:30:00');
  assert.equal(computeCampanaDias(timeOut, timeIn, '09:00'), 3);
});

test('computeCampanaDias: regreso en/despues del horario de corte cuenta el ultimo dia completo', () => {
  const timeOut = new Date('2026-08-10T14:00:00');
  const timeIn = new Date('2026-08-13T09:15:00');
  assert.equal(computeCampanaDias(timeOut, timeIn, '09:00'), 4);
});

test('computeCampanaDias: sin regreso todavia devuelve null (sigue abierta)', () => {
  assert.equal(computeCampanaDias(new Date('2026-08-10T14:00:00'), null, '09:00'), null);
});

test('computeCampanaDias: salida y regreso el mismo dia cuentan 1 dia (regreso despues del corte)', () => {
  const timeOut = new Date('2026-08-10T08:00:00');
  const timeIn = new Date('2026-08-10T18:00:00');
  assert.equal(computeCampanaDias(timeOut, timeIn, '09:00'), 1);
});

// Caso real: AVILA Natalia, legajo 9006, 08/04/2026 y 14/04/2026 -- una
// llegada tarde (07:23) quedó marcada como "Salida Particular" de
// 6h29m/6h37m que nunca pasó (badge 6 fichado por otra persona justo
// antes de que Natalia marcara su propia entrada de la mañana).
test('isFirstRealCheckinOfDay: detecta cuando timeOut coincide con el primer fichaje real del dia de esa persona', () => {
  const dayCheckins = [
    { checktime: dt('07:23:00'), userId: '9006', employeeId: '9006' },
    { checktime: dt('13:51:00'), userId: '9006', employeeId: '9006' }
  ];
  assert.equal(isFirstRealCheckinOfDay('9006', dt('07:23:00'), dayCheckins), true);
  assert.equal(isFirstRealCheckinOfDay('9006', dt('13:51:00'), dayCheckins), false);
});

test('isFirstRealCheckinOfDay: sin fichajes de esa persona ese dia, false (no revienta)', () => {
  assert.equal(isFirstRealCheckinOfDay('9006', dt('07:23:00'), []), false);
  assert.equal(isFirstRealCheckinOfDay('9006', dt('07:23:00'), null), false);
});

test('filterEventsOpenedByFirstCheckinOfDay: saca el evento fantasma de AVILA (abrio con su primera entrada del dia)', () => {
  const dayCheckins = [
    { checktime: dt('07:23:00'), userId: '9006', employeeId: '9006' },
    { checktime: dt('13:51:00'), userId: '9006', employeeId: '9006' }
  ];
  // El mismo shape que devuelve closeOpenEventsAtScheduleExit para este caso:
  // se cerro al horario programado (13:51), sin ningun regreso real.
  const events = [{
    employeeId: '9006',
    category: 'PARTICULAR',
    timeOut: dt('07:23:00'),
    timeIn: dt('13:51:00'),
    hasReturn: false,
    salidaMarkerUserId: 6,
    regresoMarkerUserId: null
  }];

  const result = filterEventsOpenedByFirstCheckinOfDay(events, dayCheckins);

  assert.deepEqual(result, []);
});

test('filterEventsOpenedByFirstCheckinOfDay: NO saca una salida real (abrio bien entrada la jornada, no con la primera entrada)', () => {
  const dayCheckins = [
    { checktime: dt('07:02:00'), userId: '2609', employeeId: '2609' }, // entrada normal de la mañana
    { checktime: dt('14:34:02'), userId: '2609', employeeId: '2609' }, // ahora sí sale
    { checktime: dt('14:34:08'), userId: '2609', employeeId: '2609' }
  ];
  const events = [{
    employeeId: '2609',
    category: 'OFICIAL',
    timeOut: dt('14:34:02'),
    timeIn: dt('14:34:08'),
    hasReturn: true,
    salidaMarkerUserId: 4,
    regresoMarkerUserId: 4
  }];

  const result = filterEventsOpenedByFirstCheckinOfDay(events, dayCheckins);

  assert.deepEqual(result, events);
});
