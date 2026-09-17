// Tests unitarios del motor de deteccion de salidas (Particular/Oficial/Campana).
// No requieren DB ni backend levantado -- son funciones puras.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectMovements,
  closeOpenEventsAtScheduleExit,
  openOrphanReturnsAtScheduleEntrance,
  computeCampanaDias,
  isFirstRealCheckinOfDay,
  filterEventsOpenedByFirstCheckinOfDay
} = require('../motor-laboral/services/movementsCalculations');

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
  assert.deepEqual(closedEvents[0], {
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
  assert.deepEqual(openEvents.get('2525'), { category: 'PARTICULAR', timeOut: dt('09:00:05'), salidaMarkerUserId: 6 });
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
  assert.deepEqual(orphanReturns[0], { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('09:00:05'), regresoMarkerUserId: 5 });
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
  assert.deepEqual(orphanReturns[0], { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('08:43:17'), regresoMarkerUserId: 5 });
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
  assert.deepEqual(openEvents.get('2525'), { category: 'PARTICULAR', timeOut: dt2('13:34:15'), salidaMarkerUserId: 6 });
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
  assert.deepEqual(openEvents.get('2446'), { category: 'CAMPANA', timeOut: dt2('13:37:25'), salidaMarkerUserId: 8 });
});

test('closeOpenEventsAtScheduleExit: cierra con el horario de salida resuelto', () => {
  const openEvents = new Map([
    ['2525', { category: 'PARTICULAR', timeOut: dt('09:00:05'), salidaMarkerUserId: 6 }]
  ]);
  const exitTimeByEmployeeId = new Map([['2525', dt('13:40:00')]]);

  const result = closeOpenEventsAtScheduleExit(openEvents, exitTimeByEmployeeId);

  assert.deepEqual(result, [{
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

  assert.deepEqual(result, [{
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
