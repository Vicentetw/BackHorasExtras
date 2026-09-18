// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #2 de la auditoria (fichajes duplicados/de mas se
// perdian en silencio). Modulo puro, sin DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timeToMinutes } = require('../motor-laboral/services/attendanceCalculations');
const { normalizeCheckins } = require('../motor-laboral/services/checkinNormalizer');

const m = timeToMinutes;

test('sin duplicados ni marcas de mas: pasa igual, sin incidencias', () => {
  const result = normalizeCheckins([m('09:00'), m('18:00')], 1);
  assert.deepEqual(result.checkins, [m('09:00'), m('18:00')]);
  assert.deepEqual(result.incidents, []);
});

test('fichaje duplicado (mismo minuto dos veces): se colapsa a una sola marca, incidencia DUPLICATE_CHECKIN_IGNORED', () => {
  const result = normalizeCheckins([m('09:00'), m('09:00'), m('18:00')], 1);
  assert.deepEqual(result.checkins, [m('09:00'), m('18:00')], 'debe quedar la marca real de salida, no el duplicado');
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].type, 'DUPLICATE_CHECKIN_IGNORED');
  assert.equal(result.incidents[0].minutes, m('09:00'));
});

test('varios duplicados seguidos se colapsan todos, cada uno con su propia incidencia', () => {
  const result = normalizeCheckins([m('09:00'), m('09:00'), m('09:00'), m('18:00')], 1);
  assert.deepEqual(result.checkins, [m('09:00'), m('18:00')]);
  assert.equal(result.incidents.length, 2, 'dos marcas de mas colapsadas -> dos incidencias');
});

test('marcas a un minuto de distancia NO se consideran duplicado (solo el mismo minuto exacto)', () => {
  const result = normalizeCheckins([m('09:00'), m('09:01'), m('18:00')], 1);
  assert.deepEqual(result.checkins, [m('09:00'), m('09:01'), m('18:00')]);
  assert.equal(result.incidents.filter((i) => i.type === 'DUPLICATE_CHECKIN_IGNORED').length, 0);
});

test('mas fichajes de los esperados (multiples visitas en un solo segmento): incidencia UNEXPECTED_EXTRA_CHECKINS, nada se pierde sin rastro', () => {
  const result = normalizeCheckins([m('09:00'), m('13:00'), m('14:00'), m('18:00')], 1);
  const incident = result.incidents.find((i) => i.type === 'UNEXPECTED_EXTRA_CHECKINS');
  assert.ok(incident, 'debe quedar registrado que hubo mas marcas de las esperadas');
  assert.equal(incident.expectedCount, 2);
  assert.equal(incident.actualCount, 4);
  assert.deepEqual(incident.extra, [m('14:00'), m('18:00')]);
});

test('duplicado Y marcas de mas a la vez: ambas incidencias aparecen', () => {
  const result = normalizeCheckins([m('09:00'), m('09:00'), m('13:00'), m('14:00'), m('18:00')], 1);
  assert.equal(result.checkins.length, 4, 'un duplicado colapsado de 5 marcas -> 4');
  assert.ok(result.incidents.some((i) => i.type === 'DUPLICATE_CHECKIN_IGNORED'));
  const extra = result.incidents.find((i) => i.type === 'UNEXPECTED_EXTRA_CHECKINS');
  assert.ok(extra);
  assert.equal(extra.actualCount, 4);
});

test('turno partido (2 segmentos, 4 marcas): sin incidencias, comportamiento normal', () => {
  const result = normalizeCheckins([m('09:00'), m('12:00'), m('16:00'), m('21:00')], 2);
  assert.equal(result.incidents.length, 0);
  assert.equal(result.checkins.length, 4);
});

test('sin fichajes: pasa vacio, sin incidencias (NO_CHECKINS lo maneja el llamador)', () => {
  const result = normalizeCheckins([], 1);
  assert.deepEqual(result.checkins, []);
  assert.deepEqual(result.incidents, []);
});
