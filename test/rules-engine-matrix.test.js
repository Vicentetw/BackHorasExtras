// Etapa 13 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt): "Construye una matriz exhaustiva de
// pruebas". Modulo PURO (sin backend, sin DB) -- corre el motor completo
// (scheduleResolver + toleranceResolver + timeClassifier + dayTypeRuleResolver)
// para cada caso del documento fuente, verificando tanto el RESULTADO como
// la EXPLICACION de las reglas aplicadas (appliedRules), que es la parte
// que los tests de las Etapas 5-8 no cubrian explicitamente (verificaban
// classifiedSegments/incidents, pero no el array appliedRules en si).
//
// No se duplican casos ya cubiertos en otro lado -- se referencian:
// - Jornada normal, jornada partida, HE con/sin autorizacion, politicas
//   NO_COMPUTAR/TIEMPO_TRABAJADO, feriado/franco ALL_DAY, sabado puntual,
//   turno nocturno: ver test/time-classifier.test.js (Etapas 7/8).
// - Matriz de limites de tolerancia a nivel resolver puro (sin motor
//   completo): ver test/tolerance-resolver.test.js (Etapa 6).
// - Desempate de reglas por especificidad: ver test/day-type-rule-resolver.test.js (Etapa 8).
// - Cambio de convenio/categoria a mitad de año + recalculo historico:
//   ver test/convention-assignment-repository.test.js (Etapa 9, ya cubre
//   el corte 01/07 exacto que pide este documento).
// - Vacaciones/Permiso (dia excusado, el motor nunca corre) + Salida
//   particular/oficial (fuera del alcance del motor): ver
//   test/attendance-range-shadow-mode.test.js (Etapa 12).
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

function ruleNames(appliedRules) {
  return appliedRules.map((r) => r.rule);
}

// --- Tolerancia de entrada: 09:00 / 09:10 (limite) / 09:11 (fuera) ---
// A traves del motor COMPLETO (no solo evaluateEntranceTolerance suelto),
// verificando que appliedRules explica la decision en los 3 puntos.

test('tolerancia de entrada a traves del motor completo: 09:00 (a horario) -> sin tardanza, ENTRANCE_TOLERANCE explica por que', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_entrada_minutos: 10 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:00'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  assert.equal(result.incidents.some((i) => i.type === 'LATE_ARRIVAL'), false);
  const rule = result.appliedRules.find((r) => r.rule === 'ENTRANCE_TOLERANCE');
  assert.ok(rule, 'debe quedar explicito que se evaluo la tolerancia de entrada');
  assert.equal(rule.result.isLate, false);
});

test('tolerancia de entrada a traves del motor completo: 09:10 (limite exacto) -> el borde favorece al empleado, sin tardanza', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_entrada_minutos: 10 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:10'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  assert.equal(result.incidents.some((i) => i.type === 'LATE_ARRIVAL'), false);
  const rule = result.appliedRules.find((r) => r.rule === 'ENTRANCE_TOLERANCE');
  assert.equal(rule.result.isLate, false);
  assert.equal(rule.result.lateMinutes, 0);
});

test('tolerancia de entrada a traves del motor completo: 09:11 (fuera) -> LATE_ARRIVAL, ENTRANCE_TOLERANCE explica lateMinutes=11', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_entrada_minutos: 10 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:11'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  const incident = result.incidents.find((i) => i.type === 'LATE_ARRIVAL');
  assert.ok(incident);
  const rule = result.appliedRules.find((r) => r.rule === 'ENTRANCE_TOLERANCE');
  assert.equal(rule.result.isLate, true);
  assert.equal(rule.result.lateMinutes, 11);
});

// --- Salida anticipada: 18:00 / 17:55 (limite) / 17:54 (fuera), tolerancia=5 ---

test('salida anticipada a traves del motor completo: 18:00 (a horario) -> sin incidencia, EXIT_TOLERANCE explica por que', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_salida_anticipada_minutos: 5 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:00'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  assert.equal(result.incidents.some((i) => i.type === 'EARLY_DEPARTURE'), false);
  const rule = result.appliedRules.find((r) => r.rule === 'EXIT_TOLERANCE');
  assert.equal(rule.result.isEarly, false);
});

test('salida anticipada a traves del motor completo: 17:55 (limite exacto) -> el borde favorece al empleado, sin incidencia', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_salida_anticipada_minutos: 5 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:00'), m('17:55')], toleranceConfig, isOvertimeAuthorized: true });
  assert.equal(result.incidents.some((i) => i.type === 'EARLY_DEPARTURE'), false);
  assert.equal(result.normalMinutes, 535);
});

test('salida anticipada a traves del motor completo: 17:54 (fuera) -> EARLY_DEPARTURE, EXIT_TOLERANCE explica earlyMinutes=6 (medido contra el horario, no contra el limite)', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_salida_anticipada_minutos: 5 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:00'), m('17:54')], toleranceConfig, isOvertimeAuthorized: true });
  const incident = result.incidents.find((i) => i.type === 'EARLY_DEPARTURE');
  assert.ok(incident);
  assert.equal(incident.earlyMinutes, 6);
  const rule = result.appliedRules.find((r) => r.rule === 'EXIT_TOLERANCE');
  assert.equal(rule.result.isEarly, true);
  assert.equal(rule.result.earlyMinutes, 6);
});

// --- Llegada anticipada: 08:30 / 08:59 / 09:00 (justo a horario, no cuenta) ---

test('llegada anticipada 08:30: EARLY_ARRIVAL_POLICY se aplica y explica 30 minutos antes', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_llegada_anticipada: 'EXTRA_SI_AUTORIZADO' }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('08:30'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  const rule = result.appliedRules.find((r) => r.rule === 'EARLY_ARRIVAL_POLICY');
  assert.ok(rule, 'debe quedar explicito que hubo tiempo antes del horario');
  assert.equal(rule.outcome.minutesOutside, 30);
});

test('llegada anticipada 08:59 (1 minuto antes): EARLY_ARRIVAL_POLICY tambien se aplica, aunque sea un solo minuto', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_llegada_anticipada: 'EXTRA_SI_AUTORIZADO' }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('08:59'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  const rule = result.appliedRules.find((r) => r.rule === 'EARLY_ARRIVAL_POLICY');
  assert.ok(rule);
  assert.equal(rule.outcome.minutesOutside, 1);
});

test('llegada anticipada 09:00 (justo a horario): NO hay tiempo antes del horario, EARLY_ARRIVAL_POLICY ni se evalua', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ politica_llegada_anticipada: 'EXTRA_SI_AUTORIZADO' }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:00'), m('18:00')], toleranceConfig, isOvertimeAuthorized: true });
  assert.equal(ruleNames(result.appliedRules).includes('EARLY_ARRIVAL_POLICY'), false);
});

// --- Domingo con regla ALL_DAY (mismo patron que el feriado/sabado ya
// probados en time-classifier.test.js -- se agrega el tipo de dia que
// faltaba en la matriz del documento) ---

test('domingo con regla ALL_DAY rate=100 sin requerir autorizacion -- TODO el tiempo trabajado pasa a OVERTIME al 100%, con appliedRules ALL_DAY_OVERRIDE', () => {
  const seg = segment();
  const dayTypeRules = [{ day_type: 'SUNDAY', trigger_type: 'ALL_DAY', rate: 100, requires_authorization: 0 }];
  const result = computeAttendanceResult({
    segments: [seg], checkins: [m('09:00'), m('18:00')], toleranceConfig: resolveToleranceConfig({}, 10),
    isOvertimeAuthorized: false, dayType: 'SUNDAY', dayTypeRules
  });
  assert.equal(result.normalMinutes, 0);
  assert.equal(result.overtimeMinutes, 540);
  const overrideRule = result.appliedRules.find((r) => r.rule === 'ALL_DAY_OVERRIDE');
  assert.ok(overrideRule, 'debe quedar explicito que se aplico la regla de todo el dia');
  assert.equal(overrideRule.outcome.rate, 100);
});

// --- appliedRules explica CADA regla -- caso compuesto: entrada y salida
// dentro de tolerancia a la vez, ambas deben quedar en el array ---

test('appliedRules acumula una entrada por CADA regla evaluada (entrada + salida el mismo dia)', () => {
  const seg = segment();
  const toleranceConfig = resolveToleranceConfig({ tolerancia_entrada_minutos: 10, tolerancia_salida_anticipada_minutos: 5 }, 10);
  const result = computeAttendanceResult({ segments: [seg], checkins: [m('09:05'), m('17:57')], toleranceConfig, isOvertimeAuthorized: true });
  const names = ruleNames(result.appliedRules);
  assert.ok(names.includes('ENTRANCE_TOLERANCE'));
  assert.ok(names.includes('EXIT_TOLERANCE'));
});

// --- Turno partido con salida faltante en el SEGUNDO tramo, a traves del
// motor completo (Legacy ya prueba esto via evaluateMultiVisitDay en
// split-shift-attendance.test.js -- este caso confirma que el motor NUEVO
// tambien lo maneja bien, de forma independiente por segmento) ---

test('turno partido: falta la salida del segundo tramo -> MISSING_EXIT solo en ese tramo, el primero queda NORMAL completo', () => {
  const segments = resolveScheduleSegments([
    { id: 1, block_type: 'WORK', start_time: '09:00:00', end_time: '12:00:00', crosses_midnight: 0, active: 1 },
    { id: 2, block_type: 'WORK', start_time: '16:00:00', end_time: '21:00:00', crosses_midnight: 0, active: 1 },
  ]);
  const result = computeAttendanceResult({
    segments, checkins: [m('09:00'), m('12:00'), m('16:00')], toleranceConfig: resolveToleranceConfig({}, 10), isOvertimeAuthorized: true
  });
  assert.equal(result.normalMinutes, 180, 'el primer tramo, completo, se computa igual');
  const missingExit = result.incidents.find((i) => i.type === 'MISSING_EXIT');
  assert.ok(missingExit);
});

// --- Hallazgos de la Etapa 13, CORREGIDOS en la Etapa 14 (ver
// checkinNormalizer.js) -- se actualizan estos mismos tests para
// verificar el comportamiento seguro en vez del bug original. ---

test('CORREGIDO (Etapa 14, hallazgo #2): multiples fichajes en UN SOLO segmento -- ya NO se ignoran en silencio, queda incidencia explicita', () => {
  // Un solo bloque WORK (09-18) espera EXACTAMENTE 2 fichajes (entrada,
  // salida). El emparejamiento posicional sigue usando las primeras 2
  // marcas (adivinar cual de las 2 marcas de en medio es la "real" seria
  // peor que no saberlo) -- pero ahora UNEXPECTED_EXTRA_CHECKINS deja
  // registradas las marcas sobrantes (14:00, 18:00) para que un admin las
  // revise, en vez de que desaparezcan sin dejar rastro.
  const seg = segment();
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00'), m('13:00'), m('14:00'), m('18:00')],
    toleranceConfig: resolveToleranceConfig({}, 10),
    isOvertimeAuthorized: true
  });
  assert.equal(result.normalMinutes, 240, '09:00 a 13:00 -- el emparejamiento de las 2 primeras marcas no cambia (no hay forma segura de adivinar mejor)');
  const extra = result.incidents.find((i) => i.type === 'UNEXPECTED_EXTRA_CHECKINS');
  assert.ok(extra, 'ahora SI queda una incidencia explicita -- ya no desaparece sin rastro');
  assert.deepEqual(extra.extra, [m('14:00'), m('18:00')]);
});

test('CORREGIDO (Etapa 14, hallazgo #2): fichaje duplicado (misma hora dos veces) -- ya NO trunca el dia, se ignora el duplicado y se usa la salida real', () => {
  // Un reloj que registra la misma marca dos veces (rebote, doble tilde)
  // ya no hace que checkinOut tome ese duplicado -- se colapsa antes de
  // emparejar, y el dia se calcula CORRECTAMENTE con la salida real.
  const seg = segment();
  const result = computeAttendanceResult({
    segments: [seg],
    checkins: [m('09:00'), m('09:00'), m('18:00')],
    toleranceConfig: resolveToleranceConfig({}, 10),
    isOvertimeAuthorized: true
  });
  assert.equal(result.normalMinutes, 540, 'el dia se calcula bien -- 09:00 a 18:00, el duplicado no lo arruina mas');
  const duplicateIncident = result.incidents.find((i) => i.type === 'DUPLICATE_CHECKIN_IGNORED');
  assert.ok(duplicateIncident, 'queda una incidencia explicita marcando que hubo un duplicado, aunque el calculo ya sea correcto');
});

test('HALLAZGO Etapa 13: cambio de configuracion de plantilla (tolerancia) NO tiene vigencia historica, a diferencia de los convenios', () => {
  // A diferencia de employee_convention_assignments (valid_from/valid_to,
  // ver convention-assignment-repository.test.js), work_schedule_templates
  // no versiona sus columnas de tolerancia -- son un valor mutable unico.
  // Cambiar la tolerancia HOY afecta el recalculo de CUALQUIER fecha
  // pasada exactamente igual que el de hoy, sin importar que ese cambio
  // se haya hecho meses despues. Esto responde de antemano la pregunta
  // de auditoria de la Etapa 14 ("Historico: ¿una configuracion actual
  // puede alterar calculos historicos?"): SI puede, y hoy no hay forma de
  // evitarlo para esta configuracion en particular.
  const templateBeforeChange = { tolerancia_entrada_minutos: 10 };
  const configForJanuary = resolveToleranceConfig(templateBeforeChange, 10);
  assert.equal(configForJanuary.entradaMinutos, 10);

  // "01/07": el admin cambia la tolerancia de esta plantilla a 20.
  const templateAfterChange = { ...templateBeforeChange, tolerancia_entrada_minutos: 20 };

  // Recalcular la MISMA fecha de enero, DESPUES del cambio de julio, usa
  // la tolerancia NUEVA (20), no la que estaba vigente en enero (10).
  const configForJanuaryRecalculatedAfterJuly = resolveToleranceConfig(templateAfterChange, 10);
  assert.equal(configForJanuaryRecalculatedAfterJuly.entradaMinutos, 20, 'sin vigencia, el recalculo historico usa el valor ACTUAL, no el vigente en su momento');
});
