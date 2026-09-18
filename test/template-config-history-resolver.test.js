// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #3 de la auditoria. Modulo puro, sin DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveHistoricalToleranceFields } = require('../motor-laboral/services/templateConfigHistoryResolver');

const liveTemplate = { id: 5, name: 'Plantilla (test)', tolerancia_entrada_minutos: 20, politica_llegada_anticipada: 'TIEMPO_TRABAJADO' };

test('sin ningun snapshot para esta plantilla: devuelve la plantilla EN VIVO tal cual (cero cambio de comportamiento)', () => {
  const result = resolveHistoricalToleranceFields([], 5, '2026-01-15', liveTemplate);
  assert.equal(result, liveTemplate);
});

test('fecha DENTRO de un snapshot cerrado: usa los valores del snapshot, no los de la plantilla en vivo', () => {
  const historyRows = [
    { template_id: 5, tolerancia_entrada_minutos: 10, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null, valid_from: '2026-01-01', valid_to: '2026-06-30' }
  ];
  const result = resolveHistoricalToleranceFields(historyRows, 5, '2026-03-15', liveTemplate);
  assert.equal(result.tolerancia_entrada_minutos, 10, 'usa el valor historico (10), no el actual (20)');
  assert.equal(result.politica_llegada_anticipada, null, 'tambien reemplaza el resto de los campos de tolerancia por el snapshot');
});

test('fecha DESPUES de todos los snapshots (posterior al ultimo cambio): usa la plantilla EN VIVO', () => {
  const historyRows = [
    { template_id: 5, tolerancia_entrada_minutos: 10, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null, valid_from: '2026-01-01', valid_to: '2026-06-30' }
  ];
  const result = resolveHistoricalToleranceFields(historyRows, 5, '2026-07-15', liveTemplate);
  assert.equal(result.tolerancia_entrada_minutos, 20, 'julio ya es posterior al cambio -- usa el valor actual');
});

test('cambio de configuracion DOS veces: cada rango de fechas resuelve al snapshot que corresponde', () => {
  const historyRows = [
    { template_id: 5, tolerancia_entrada_minutos: 5, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null, valid_from: '2026-01-01', valid_to: '2026-02-28' },
    { template_id: 5, tolerancia_entrada_minutos: 10, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null, valid_from: '2026-03-01', valid_to: '2026-06-30' }
  ];
  assert.equal(resolveHistoricalToleranceFields(historyRows, 5, '2026-01-15', liveTemplate).tolerancia_entrada_minutos, 5);
  assert.equal(resolveHistoricalToleranceFields(historyRows, 5, '2026-04-15', liveTemplate).tolerancia_entrada_minutos, 10);
  assert.equal(resolveHistoricalToleranceFields(historyRows, 5, '2026-07-15', liveTemplate).tolerancia_entrada_minutos, 20, 'el valor actual, posterior a ambos cambios');
});

test('snapshots de OTRA plantilla se ignoran (filtra por templateId)', () => {
  const historyRows = [
    { template_id: 999, tolerancia_entrada_minutos: 1, valid_from: '2026-01-01', valid_to: '2026-12-31' }
  ];
  const result = resolveHistoricalToleranceFields(historyRows, 5, '2026-05-01', liveTemplate);
  assert.equal(result, liveTemplate);
});
