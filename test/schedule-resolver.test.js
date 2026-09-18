// Etapa 5 del plan "Motor de reglas de asistencia configurable" -- tests
// puros (sin backend levantado, sin DB) para resolveScheduleSegments.
// Casos pedidos explicitamente por el archivo de fases: jornada partida
// 09-12/16-21, y turno nocturno 22-06.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveScheduleSegments } = require('../motor-laboral/services/scheduleResolver');

function block(overrides) {
  return {
    id: 1,
    template_id: 1,
    day_of_week: 1,
    block_name: null,
    start_time: '09:00:00',
    end_time: '18:00:00',
    block_type: 'WORK',
    crosses_midnight: 0,
    active: 1,
    ...overrides
  };
}

test('jornada normal (un solo segmento 09:00-18:00)', () => {
  const segments = resolveScheduleSegments([block({ id: 1 })]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].durationMinutes, 540); // 9hs
  assert.equal(segments[0].crossesMidnight, false);
});

test('jornada partida (09:00-12:00 y 16:00-21:00): dos segmentos independientes, sin fusionar el intervalo del medio', () => {
  const segments = resolveScheduleSegments([
    block({ id: 2, start_time: '16:00:00', end_time: '21:00:00' }), // a proposito fuera de orden
    block({ id: 1, start_time: '09:00:00', end_time: '12:00:00' }),
  ]);
  assert.equal(segments.length, 2);
  // Ordenados por hora de inicio, sin importar el orden de entrada.
  assert.equal(segments[0].blockId, 1);
  assert.equal(segments[0].startTime, '09:00:00');
  assert.equal(segments[0].durationMinutes, 180);
  assert.equal(segments[1].blockId, 2);
  assert.equal(segments[1].startTime, '16:00:00');
  assert.equal(segments[1].durationMinutes, 300);
  // El intervalo 12:00-16:00 no aparece en ningun lado -- no es ausencia,
  // no es descanso computable, simplemente no existe como segmento.
  const gapCovered = segments.some((s) => s.startMinutes <= 13 * 60 && s.endMinutes >= 13 * 60);
  assert.equal(gapCovered, false);
});

test('segmentos consecutivos (09:00-12:00 y 12:00-15:00): quedan como dos segmentos distintos, no se fusionan', () => {
  const segments = resolveScheduleSegments([
    block({ id: 1, start_time: '09:00:00', end_time: '12:00:00' }),
    block({ id: 2, start_time: '12:00:00', end_time: '15:00:00' }),
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].endTime, '12:00:00');
  assert.equal(segments[1].startTime, '12:00:00');
});

test('turno nocturno con cruce de medianoche (22:00-06:00): un segmento, duracion correcta de 8hs', () => {
  const segments = resolveScheduleSegments([
    block({ id: 1, start_time: '22:00:00', end_time: '06:00:00', crosses_midnight: 1 }),
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].crossesMidnight, true);
  assert.equal(segments[0].durationMinutes, 480); // 2hs hasta medianoche + 6hs
});

test('cruce de medianoche inferido defensivamente aunque falte el flag (end < start)', () => {
  const segments = resolveScheduleSegments([
    block({ id: 1, start_time: '22:00:00', end_time: '06:00:00', crosses_midnight: 0 }),
  ]);
  assert.equal(segments[0].crossesMidnight, true);
  assert.equal(segments[0].durationMinutes, 480);
});

test('dia sin jornada (franco implicito): sin bloques WORK -> cero segmentos', () => {
  assert.deepEqual(resolveScheduleSegments([]), []);
  assert.deepEqual(resolveScheduleSegments([block({ block_type: 'BREAK' })]), []);
});

test('bloques inactivos se ignoran', () => {
  const segments = resolveScheduleSegments([block({ active: 0 })]);
  assert.equal(segments.length, 0);
});

test('cualquier cantidad razonable de tramos (3 visitas en el mismo dia)', () => {
  const segments = resolveScheduleSegments([
    block({ id: 1, start_time: '07:00:00', end_time: '09:00:00' }),
    block({ id: 2, start_time: '11:00:00', end_time: '13:00:00' }),
    block({ id: 3, start_time: '17:00:00', end_time: '20:00:00' }),
  ]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((s) => s.blockId), [1, 2, 3]);
});
