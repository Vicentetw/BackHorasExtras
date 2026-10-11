// Marcador repetido = un solo gesto, vale el último par (decisión del dueño,
// 2026-10-11: "el marcador nunca es una persona"). Prueba pura de
// detectMovements: no necesita el backend ni la base.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectMovements } = require('../motor-laboral/services/movementsCalculations');

const dt = (hhmmss) => new Date(`2026-09-07T${hhmmss}`);
const HE = { 9: { category: 'HE', direction: 'SALIDA' }, 10: { category: 'HE', direction: 'REGRESO' } };
const OF = { 3: { category: 'OFICIAL', direction: 'REGRESO' }, 4: { category: 'OFICIAL', direction: 'SALIDA' } };
const c = (t, userId, employeeId = null) => ({ checktime: dt(t), userId, employeeId, machineIp: '10.0.0.1' });
const opciones = { ownCheckinBounceMs: 20000 };

test('9 + dedo dos veces (sin pausa larga antes): la hora extra NO se cierra a los segundos; vale el último par', () => {
  // Fichó la salida, apretó el 9 y puso el dedo, y lo repitió por las dudas.
  const r = detectMovements([
    c('06:52:21', 2559, '2559'),
    c('14:01:26', 2559, '2559'),
    c('14:01:39', 9), c('14:01:43', 2559, '2559'),
    c('14:01:50', 9), c('14:01:53', 2559, '2559'),
    c('16:13:18', 10), c('16:13:21', 2559, '2559'),
  ], HE, opciones);
  assert.equal(r.closedEvents.length, 1);
  assert.equal(r.closedEvents[0].timeOut.getTime(), dt('14:01:53').getTime());
  assert.equal(r.closedEvents[0].timeIn.getTime(), dt('16:13:21').getTime());
});

test('9 + dedo dos veces al VOLVER después de una pausa larga: sigue el resguardo (no se decide con marcadores)', () => {
  // 2549 05/01 (era hora extra) y AGUILAR 17/02 (era su turno) tienen la misma forma;
  // se deja como estaba hasta que lo decida la plantilla.
  const r = detectMovements([
    c('07:05:13', 2549, '2549'),
    c('13:50:10', 9), c('13:50:13', 2549, '2549'),
    c('13:50:17', 9), c('13:50:20', 2549, '2549'),
  ], HE, opciones);
  assert.equal(r.openEvents.size, 0);
});

test('regreso repetido (3 veces en 20 s): es UN regreso, a la hora del último par', () => {
  // Caso real (PEREZ 9411, 05/09/2026 21:38).
  const r = detectMovements([
    c('21:38:15', 3), c('21:38:19', 9411, '9411'),
    c('21:38:22', 3), c('21:38:25', 9411, '9411'), c('21:38:28', 9411, '9411'),
    c('21:38:31', 3), c('21:38:34', 9411, '9411'),
  ], OF, opciones);
  assert.equal(r.orphanReturns.length, 1);
  assert.equal(r.orphanReturns[0].timeIn.getTime(), dt('21:38:34').getTime());
});

test('regreso repetido después de cerrar una salida: no suma un regreso de más', () => {
  const r = detectMovements([
    c('09:00:00', 77, '77'),
    c('10:00:00', 4), c('10:00:03', 77, '77'),
    c('11:00:00', 3), c('11:00:03', 77, '77'),
    c('11:00:08', 3), c('11:00:11', 77, '77'),
  ], OF, opciones);
  assert.equal(r.closedEvents.length, 1);
  assert.equal(r.orphanReturns.length, 0);
  assert.equal(r.closedEvents[0].timeIn.getTime(), dt('11:00:11').getTime());
});

test('fuera de la ventana sí es otra acción: el segundo 9 a los 5 minutos cierra la hora extra', () => {
  const r = detectMovements([
    c('07:00:00', 50, '50'),
    c('14:00:00', 9), c('14:00:03', 50, '50'),
    c('14:05:00', 9), c('14:05:03', 50, '50'),
  ], HE, opciones);
  assert.equal(r.closedEvents.length, 1);
  assert.equal(r.closedEvents[0].timeIn.getTime(), dt('14:05:03').getTime());
});

test('dos marcadores seguidos (sin dedo en el medio): vale el último, como siempre', () => {
  const r = detectMovements([
    c('08:00:00', 60, '60'),
    c('10:00:00', 4), c('10:00:02', 9), c('10:00:05', 60, '60'),
  ], { ...OF, ...HE }, opciones);
  assert.equal(r.openEvents.get('60').category, 'HE');
});

test('mientras llega (resguardo NAIN/AGUILAR): 9 + dedo repetido al entrar sigue sin ser hora extra', () => {
  const r = detectMovements([
    c('06:59:30', 9), c('06:59:35', 3051, '3051'),
    c('06:59:38', 9), c('06:59:41', 3051, '3051'),
  ], HE, opciones);
  // Igual que antes del cambio: la 2ª lectura cierra (0 minutos), no queda una HE abierta todo el día.
  assert.equal(r.openEvents.size, 0);
});
