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
  resolveLateJustification
} = require('../motor-laboral/services/attendanceCalculations');

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
