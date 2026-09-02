// Tests unitarios del motor de deteccion de salidas (Particular/Oficial/Campana).
// No requieren DB ni backend levantado -- son funciones puras.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectMovements,
  closeOpenEventsAtScheduleExit,
  openOrphanReturnsAtScheduleEntrance,
  computeCampanaDias
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
    timeIn: dt('11:05:16')
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
});

test('detectMovements: sin fichaje de regreso ese dia queda abierta', () => {
  const checkins = [
    { checktime: dt('09:00:00'), userId: 6, employeeId: null },
    { checktime: dt('09:00:05'), userId: 2525, employeeId: '2525' }
  ];
  const { closedEvents, openEvents } = detectMovements(checkins, PARTICULAR_MARKERS);

  assert.equal(closedEvents.length, 0);
  assert.equal(openEvents.size, 1);
  assert.deepEqual(openEvents.get('2525'), { category: 'PARTICULAR', timeOut: dt('09:00:05') });
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
  assert.deepEqual(orphanReturns[0], { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('09:00:05') });
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
  assert.deepEqual(orphanReturns[0], { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('08:43:17') });
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
  assert.deepEqual(openEvents.get('2525'), { category: 'PARTICULAR', timeOut: dt2('13:34:15') });
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
  assert.deepEqual(openEvents.get('2446'), { category: 'CAMPANA', timeOut: dt2('13:37:25') });
});

test('closeOpenEventsAtScheduleExit: cierra con el horario de salida resuelto', () => {
  const openEvents = new Map([
    ['2525', { category: 'PARTICULAR', timeOut: dt('09:00:05') }]
  ]);
  const exitTimeByEmployeeId = new Map([['2525', dt('13:40:00')]]);

  const result = closeOpenEventsAtScheduleExit(openEvents, exitTimeByEmployeeId);

  assert.deepEqual(result, [{
    employeeId: '2525',
    category: 'PARTICULAR',
    timeOut: dt('09:00:05'),
    timeIn: dt('13:40:00'),
    hasReturn: false
  }]);
});

test('openOrphanReturnsAtScheduleEntrance: sintetiza la salida con el horario de entrada programado', () => {
  // Caso real Perrotta 02/07/2026: sin salida abierta, entrada particular a
  // las 08:43:17, con horario de entrada programado 07:00 -- esto es lo que
  // debe aparecer en salidas.html (Particular) como "duración" de la salida
  // particular, igual que cualquier otra fila.
  const orphanReturns = [
    { employeeId: '2525', category: 'PARTICULAR', timeIn: dt('08:43:17') }
  ];
  const entranceTimeByEmployeeId = new Map([['2525', dt('07:00:00')]]);

  const result = openOrphanReturnsAtScheduleEntrance(orphanReturns, entranceTimeByEmployeeId);

  assert.deepEqual(result, [{
    employeeId: '2525',
    category: 'PARTICULAR',
    timeOut: dt('07:00:00'),
    timeIn: dt('08:43:17'),
    hasReturn: true
  }]);
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
