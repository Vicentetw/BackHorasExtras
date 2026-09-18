// Etapa 12 del plan "Motor de reglas de asistencia configurable" --
// modulo puro, sin DB. Cubre buildLegacyComparable, deriveEngineClassification
// y compareAttendanceResults con y sin configuracion nueva cargada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DIFF_TYPES,
  buildLegacyComparable,
  deriveEngineClassification,
  compareAttendanceResults
} = require('../motor-laboral/services/shadowComparator');

test('buildLegacyComparable: jornada normal sin turno partido -> workedMinutes = lastMin - firstMin', () => {
  const result = buildLegacyComparable({
    firstMinutes: 540, // 09:00
    lastMinutes: 1080, // 18:00
    isLate: false,
    lateMinutes: 0,
    isPartialAbsence: false,
    overtimeMinutes: 0,
    visits: null
  });
  assert.equal(result.workedMinutes, 540);
  assert.equal(result.normalMinutes, 540);
  assert.equal(result.classification, 'OnTime');
  assert.deepEqual(result.incidents, []);
});

test('buildLegacyComparable: llegada tarde -> incidents incluye LATE_ARRIVAL y classification Late', () => {
  const result = buildLegacyComparable({
    firstMinutes: 555, // 09:15
    lastMinutes: 1080,
    isLate: true,
    lateMinutes: 15,
    isPartialAbsence: false,
    overtimeMinutes: 0,
    visits: null
  });
  assert.equal(result.classification, 'Late');
  assert.deepEqual(result.incidents, [{ type: 'LATE_ARRIVAL', lateMinutes: 15 }]);
});

test('buildLegacyComparable: turno partido -> workedMinutes suma cada visita completa, ignora visitas incompletas', () => {
  const result = buildLegacyComparable({
    firstMinutes: 540,
    lastMinutes: 1260,
    isLate: false,
    lateMinutes: 0,
    isPartialAbsence: false,
    overtimeMinutes: 0,
    visits: [
      { entrada: '2026-09-18 09:00:00', salida: '2026-09-18 12:00:00' },
      { entrada: '2026-09-18 16:00:00', salida: null }
    ]
  });
  assert.equal(result.workedMinutes, 180);
});

test('buildLegacyComparable: overtimeMinutes automatico se descuenta de normalMinutes, nunca de workedMinutes', () => {
  const result = buildLegacyComparable({
    firstMinutes: 540,
    lastMinutes: 1200, // 20:00
    isLate: false,
    lateMinutes: 0,
    isPartialAbsence: false,
    overtimeMinutes: 120,
    visits: null
  });
  assert.equal(result.workedMinutes, 660);
  assert.equal(result.normalMinutes, 540);
  assert.equal(result.overtimeMinutes, 120);
});

test('deriveEngineClassification: sin incidents -> OnTime; con LATE_ARRIVAL -> Late; con MISSING_EXIT -> PartialAbsence', () => {
  assert.equal(deriveEngineClassification({ incidents: [] }), 'OnTime');
  assert.equal(deriveEngineClassification({ incidents: [{ type: 'LATE_ARRIVAL' }] }), 'Late');
  assert.equal(deriveEngineClassification({ incidents: [{ type: 'MISSING_EXIT' }] }), 'PartialAbsence');
});

test('compareAttendanceResults: resultados identicos -> sin diferencias', () => {
  const legacy = { workedMinutes: 540, normalMinutes: 540, overtimeMinutes: 0, incidents: [], classification: 'OnTime' };
  const engine = { workedMinutes: 540, normalMinutes: 540, overtimeMinutes: 0, incidents: [] };
  const diffs = compareAttendanceResults({ legacy, engine, hasCustomConfig: false });
  assert.deepEqual(diffs, []);
});

test('compareAttendanceResults: sin config nueva, diferencia en overtimeMinutes -> POSSIBLE_REGRESSION', () => {
  const legacy = { workedMinutes: 660, normalMinutes: 540, overtimeMinutes: 120, incidents: [], classification: 'OnTime' };
  const engine = { workedMinutes: 660, normalMinutes: 660, overtimeMinutes: 0, incidents: [] };
  const diffs = compareAttendanceResults({ legacy, engine, hasCustomConfig: false });
  const overtimeDiff = diffs.find((d) => d.field === 'overtimeMinutes');
  assert.ok(overtimeDiff);
  assert.equal(overtimeDiff.diffType, 'POSSIBLE_REGRESSION');
});

test('compareAttendanceResults: sin config nueva, diferencia solo en incidents (no numerica) -> UNEXPECTED', () => {
  const legacy = { workedMinutes: 540, normalMinutes: 540, overtimeMinutes: 0, incidents: [], classification: 'OnTime' };
  const engine = { workedMinutes: 540, normalMinutes: 540, overtimeMinutes: 0, incidents: [{ type: 'EARLY_DEPARTURE', earlyMinutes: 3 }] };
  const diffs = compareAttendanceResults({ legacy, engine, hasCustomConfig: false });
  const incidentsDiff = diffs.find((d) => d.field === 'incidents');
  assert.ok(incidentsDiff);
  assert.equal(incidentsDiff.diffType, 'UNEXPECTED');
});

test('compareAttendanceResults: CON config nueva (tolerancia configurada), cualquier diferencia -> NEW_FEATURE', () => {
  const legacy = { workedMinutes: 555, normalMinutes: 555, overtimeMinutes: 0, incidents: [{ type: 'LATE_ARRIVAL', lateMinutes: 15 }], classification: 'Late' };
  const engine = { workedMinutes: 555, normalMinutes: 555, overtimeMinutes: 0, incidents: [] };
  const diffs = compareAttendanceResults({ legacy, engine, hasCustomConfig: true });
  const classificationDiff = diffs.find((d) => d.field === 'classifications');
  assert.ok(classificationDiff);
  assert.equal(classificationDiff.diffType, 'NEW_FEATURE');
});

test('DIFF_TYPES expone las 4 categorias del documento fuente', () => {
  assert.deepEqual(DIFF_TYPES, ['EXPECTED', 'NEW_FEATURE', 'UNEXPECTED', 'POSSIBLE_REGRESSION']);
});
