// Etapa 6 del plan "Motor de reglas de asistencia configurable" -- tests
// puros (sin backend, sin DB). Matriz de limites pedida explicitamente por
// el archivo de fases: 09:00 / 09:01 / 09:09 / 09:10 / 09:11 (entrada), y
// el equivalente simetrico para salida anticipada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timeToMinutes } = require('../motor-laboral/services/attendanceCalculations');
const {
  resolveToleranceConfig,
  evaluateEntranceTolerance,
  evaluateExitTolerance,
  resolvePolicyOutcome
} = require('../motor-laboral/services/toleranceResolver');

const m = timeToMinutes;

test('resolveToleranceConfig: plantilla sin ninguna columna nueva -> cae al comportamiento LEGACY exacto (10 o 60 segun el llamador)', () => {
  const cfg = resolveToleranceConfig({}, 10);
  assert.equal(cfg.entradaMinutos, 10);
  assert.equal(cfg.salidaAnticipadaMinutos, null, 'hoy no existe tolerancia de salida anticipada -- sin configurar, no se evalua nada');
  assert.equal(cfg.politicaLlegadaAnticipada, 'NO_COMPUTAR');
  assert.equal(cfg.politicaSalidaPosterior, 'NO_COMPUTAR');
});

test('resolveToleranceConfig: plantilla CON columnas nuevas -> las usa en vez del legacy', () => {
  const cfg = resolveToleranceConfig({
    tolerancia_entrada_minutos: 15,
    tolerancia_salida_anticipada_minutos: 5,
    politica_llegada_anticipada: 'TIEMPO_TRABAJADO',
    politica_salida_posterior: 'EXTRA_SI_AUTORIZADO'
  }, 10);
  assert.equal(cfg.entradaMinutos, 15);
  assert.equal(cfg.salidaAnticipadaMinutos, 5);
  assert.equal(cfg.politicaLlegadaAnticipada, 'TIEMPO_TRABAJADO');
  assert.equal(cfg.politicaSalidaPosterior, 'EXTRA_SI_AUTORIZADO');
});

// Horario 09:00, tolerancia 10 -- matriz exacta pedida por el archivo de fases.
test('tolerancia de entrada -- matriz de limites (horario 09:00, tolerancia 10)', () => {
  const scheduledStartMinutes = m('09:00');
  const cases = [
    ['09:00', false, 0],
    ['09:01', false, 0],
    ['09:09', false, 0],
    ['09:10', false, 0], // limite exacto: a favor del empleado, NO tardanza
    ['09:11', true, 11],
  ];
  for (const [time, expectedLate, expectedLateMinutes] of cases) {
    const result = evaluateEntranceTolerance({ scheduledStartMinutes, actualMinutes: m(time), toleranceMinutes: 10 });
    assert.equal(result.isLate, expectedLate, `fichaje ${time}`);
    assert.equal(result.lateMinutes, expectedLateMinutes, `fichaje ${time}`);
    // El fichaje real NUNCA se transforma -- pedido explicito del documento.
    assert.equal(result.actualMinutes, m(time));
  }
});

// Horario 18:00, tolerancia 5 -- equivalente simetrico para salida.
test('tolerancia de salida anticipada -- matriz de limites (horario 18:00, tolerancia 5)', () => {
  const scheduledEndMinutes = m('18:00');
  const cases = [
    ['18:00', false, 0],
    ['17:59', false, 0],
    ['17:56', false, 0],
    ['17:55', false, 0], // limite exacto: a favor del empleado, NO anticipada
    ['17:54', true, 6],
  ];
  for (const [time, expectedEarly, expectedEarlyMinutes] of cases) {
    const result = evaluateExitTolerance({ scheduledEndMinutes, actualMinutes: m(time), toleranceMinutes: 5 });
    assert.equal(result.isEarly, expectedEarly, `fichaje ${time}`);
    assert.equal(result.earlyMinutes, expectedEarlyMinutes, `fichaje ${time}`);
    assert.equal(result.actualMinutes, m(time));
  }
});

// Ejemplo literal del documento fuente: horario 21:00, margen 5 -- sale
// 20:57 (no anticipada), sale 20:54 (si anticipada).
test('ejemplo del documento: horario 21:00, margen 5 -- 20:57 no anticipada, 20:54 si anticipada', () => {
  const scheduledEndMinutes = m('21:00');
  assert.equal(evaluateExitTolerance({ scheduledEndMinutes, actualMinutes: m('20:57'), toleranceMinutes: 5 }).isEarly, false);
  assert.equal(evaluateExitTolerance({ scheduledEndMinutes, actualMinutes: m('20:54'), toleranceMinutes: 5 }).isEarly, true);
});

test('sin tolerancia configurada (0 o ausente): cualquier minuto de mas ya es tardanza/anticipada', () => {
  assert.equal(evaluateEntranceTolerance({ scheduledStartMinutes: m('09:00'), actualMinutes: m('09:01'), toleranceMinutes: 0 }).isLate, true);
  assert.equal(evaluateExitTolerance({ scheduledEndMinutes: m('18:00'), actualMinutes: m('17:59'), toleranceMinutes: 0 }).isEarly, true);
});

test('resolvePolicyOutcome: NO_COMPUTAR (default, = comportamiento actual) -- no se reconoce nada', () => {
  const outcome = resolvePolicyOutcome('NO_COMPUTAR', 30);
  assert.equal(outcome.recognized, false);
  assert.equal(outcome.category, null);
});

test('resolvePolicyOutcome: TIEMPO_TRABAJADO -- se reconoce como tiempo normal', () => {
  assert.equal(resolvePolicyOutcome('TIEMPO_TRABAJADO', 30).category, 'NORMAL');
});

test('resolvePolicyOutcome: EXTRA_SI_AUTORIZADO -- candidato a HE (la autorizacion real se resuelve en otra etapa)', () => {
  assert.equal(resolvePolicyOutcome('EXTRA_SI_AUTORIZADO', 30).category, 'OVERTIME_CANDIDATE');
});

test('resolvePolicyOutcome: REGISTRAR_SIN_EXTRA -- se anota pero no cuenta como HE', () => {
  const outcome = resolvePolicyOutcome('REGISTRAR_SIN_EXTRA', 30);
  assert.equal(outcome.recognized, true);
  assert.equal(outcome.category, 'INFORMATIVE_ONLY');
});

test('resolvePolicyOutcome: un valor invalido/desconocido cae a NO_COMPUTAR, no rompe', () => {
  assert.equal(resolvePolicyOutcome('ALGO_RARO', 30).policy, 'NO_COMPUTAR');
});
