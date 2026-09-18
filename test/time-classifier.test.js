// Etapa 7 del plan "Motor de reglas de asistencia configurable" -- tests
// puros (sin backend, sin DB) para el motor de clasificacion v1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timeToMinutes } = require('../motor-laboral/services/attendanceCalculations');
const { resolveScheduleSegments } = require('../motor-laboral/services/scheduleResolver');
const { resolveToleranceConfig } = require('../motor-laboral/services/toleranceResolver');
const { computeAttendanceResult } = require('../motor-laboral/services/timeClassifier');

const m = timeToMinutes;

function segment(overrides) {
  return resolveScheduleSegments([{
    id: 1, block_type: 'WORK', start_time: '09:00:00', end_time: '18:00:00', crosses_midnight: 0, active: 1, ...overrides
  }])[0];
}

const NO_POLICY_CONFIG = resolveToleranceConfig({}, 10); // legacy: NO_COMPUTAR / NO_COMPUTAR

// Ejemplo LITERAL del documento fuente: horario 09:00-18:00, fichajes
// 09:00-20:00 -> 09:00-18:00 NORMAL, 18:00-20:00 OVERTIME (si esta
// autorizado; si no, UNAUTHORIZED_OVERTIME, pero nunca se pierde).
test('ejemplo del documento: 09:00-18:00 programado, fichajes 09:00-20:00, politica EXTRA_SI_AUTORIZADO + autorizado -> NORMAL 540 + OVERTIME 120', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_salida_posterior: 'EXTRA_SI_AUTORIZADO' }, 10);
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00'), m('20:00')],
    toleranceConfig,
    isOvertimeAuthorized: true
  });
  assert.equal(result.scheduledMinutes, 540);
  assert.equal(result.normalMinutes, 540);
  assert.equal(result.overtimeMinutes, 120);
  assert.equal(result.unauthorizedMinutes, 0);
  assert.equal(result.workedMinutes, 660); // 540 normal + 120 HE reconocida
  assert.equal(result.ruleSetVersion, 1);
});

test('mismo ejemplo pero SIN autorizacion: el exceso NUNCA se pierde, queda como UNAUTHORIZED_OVERTIME + incidencia', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_salida_posterior: 'EXTRA_SI_AUTORIZADO' }, 10);
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00'), m('20:00')],
    toleranceConfig,
    isOvertimeAuthorized: false
  });
  assert.equal(result.normalMinutes, 540);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.unauthorizedMinutes, 120);
  assert.equal(result.workedMinutes, 660, 'el tiempo trabajado incluye la HE no autorizada -- nunca se descarta');
  assert.ok(result.incidents.some((i) => i.type === 'UNAUTHORIZED_OVERTIME'));
});

test('politica NO_COMPUTAR (default = comportamiento actual): el exceso se ficha pero no cuenta como nada', () => {
  const seg = segment();
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00'), m('20:00')],
    toleranceConfig: NO_POLICY_CONFIG,
    isOvertimeAuthorized: true
  });
  assert.equal(result.normalMinutes, 540);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.unauthorizedMinutes, 0);
  assert.equal(result.workedMinutes, 540, 'el exceso no computado no suma a trabajado, pero SI queda registrado');
  const notComputed = result.classifiedSegments.find((s) => s.type === 'NOT_COMPUTED');
  assert.ok(notComputed, 'el intervalo 18:00-20:00 debe seguir apareciendo en classifiedSegments, nunca se pierde');
  assert.equal(notComputed.minutes, 120);
});

test('politica TIEMPO_TRABAJADO: el exceso cuenta como trabajado reconocido, pero no es HE ni normal', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_salida_posterior: 'TIEMPO_TRABAJADO' }, 10);
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00'), m('20:00')],
    toleranceConfig,
    isOvertimeAuthorized: false
  });
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.unauthorizedMinutes, 0);
  assert.equal(result.workedMinutes, 660);
  assert.ok(result.classifiedSegments.some((s) => s.type === 'RECOGNIZED_WORKED_TIME' && s.minutes === 120));
});

test('llegada anticipada con politica EXTRA_SI_AUTORIZADO: el tiempo antes del horario tambien se clasifica (no solo el de despues)', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_llegada_anticipada: 'EXTRA_SI_AUTORIZADO' }, 10);
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('08:30'), m('18:00')],
    toleranceConfig,
    isOvertimeAuthorized: true
  });
  assert.equal(result.normalMinutes, 540);
  assert.equal(result.overtimeMinutes, 30);
  assert.ok(result.classifiedSegments.some((s) => s.label === 'ANTES_DEL_HORARIO' && s.type === 'OVERTIME'));
});

test('jornada partida (dos segmentos): cada uno se clasifica de forma independiente', () => {
  const segments = resolveScheduleSegments([
    { id: 1, block_type: 'WORK', start_time: '09:00:00', end_time: '12:00:00', crosses_midnight: 0, active: 1 },
    { id: 2, block_type: 'WORK', start_time: '16:00:00', end_time: '21:00:00', crosses_midnight: 0, active: 1 },
  ]);
  const result = computeAttendanceResult({
    segments,
    checkins: [m('09:00'), m('12:00'), m('16:00'), m('21:00')],
    toleranceConfig: NO_POLICY_CONFIG,
    isOvertimeAuthorized: true
  });
  assert.equal(result.scheduledMinutes, 480); // 180 + 300
  assert.equal(result.normalMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  // El intervalo 12:00-16:00 no aparece clasificado en ningun lado -- no
  // es ausencia ni descanso computable, simplemente no existe.
  const gapMentioned = result.classifiedSegments.some((s) => s.startMinutes < m('16:00') && s.endMinutes > m('12:00') && s.startMinutes >= m('12:00'));
  assert.equal(gapMentioned, false);
});

test('llegada tarde dentro de tolerancia: no genera incidencia, normalMinutes se calcula sobre el fichaje real', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_entrada_minutos: 10 }, 10);
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:07'), m('18:00')],
    toleranceConfig,
    isOvertimeAuthorized: true
  });
  assert.equal(result.incidents.some((i) => i.type === 'LATE_ARRIVAL'), false);
  assert.equal(result.normalMinutes, 533); // 09:07 a 18:00
});

test('llegada tarde FUERA de tolerancia: incidencia LATE_ARRIVAL, el fichaje real nunca se transforma', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_entrada_minutos: 10 }, 10);
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:11'), m('18:00')],
    toleranceConfig,
    isOvertimeAuthorized: true
  });
  const incident = result.incidents.find((i) => i.type === 'LATE_ARRIVAL');
  assert.ok(incident);
  assert.equal(incident.lateMinutes, 11);
});

test('fichaje incompleto (falta la salida): se registra como incidencia, no rompe ni inventa una salida', () => {
  const seg = segment();
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00')],
    toleranceConfig: NO_POLICY_CONFIG,
    isOvertimeAuthorized: true
  });
  assert.ok(result.incidents.some((i) => i.type === 'MISSING_EXIT'));
  assert.equal(result.normalMinutes, 0);
});

test('sin fichajes en absoluto: scheduledMinutes se preserva, resto en cero, incidencia NO_CHECKINS', () => {
  const seg = segment();
  const result = computeAttendanceResult({ segments: [seg], checkins: [], toleranceConfig: NO_POLICY_CONFIG, isOvertimeAuthorized: true });
  assert.equal(result.scheduledMinutes, 540);
  assert.equal(result.workedMinutes, 0);
  assert.ok(result.incidents.some((i) => i.type === 'NO_CHECKINS'));
});

test('dia sin jornada (franco) con un fichaje igual: se preserva como incidencia, no se inventa clasificacion', () => {
  const result = computeAttendanceResult({ segments: [], checkins: [m('09:00')], toleranceConfig: NO_POLICY_CONFIG, isOvertimeAuthorized: true });
  assert.equal(result.scheduledMinutes, 0);
  assert.ok(result.incidents.some((i) => i.type === 'CHECKIN_ON_NON_SCHEDULED_DAY'));
});

test('turno nocturno (22:00-06:00) fichado exacto: NORMAL = duracion completa del segmento', () => {
  const seg = segment({ start_time: '22:00:00', end_time: '06:00:00', crosses_midnight: 1 });
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('22:00'), m('06:00') + 24 * 60], // salida al dia siguiente, en minutos continuos desde el inicio del turno
    toleranceConfig: NO_POLICY_CONFIG,
    isOvertimeAuthorized: true
  });
  assert.equal(result.scheduledMinutes, 480);
  assert.equal(result.normalMinutes, 480);
});
