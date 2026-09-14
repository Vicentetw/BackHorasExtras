// Tests unitarios del conteo de dias de licencia (corridos vs habiles, con
// vigencias que pueden cambiar en el tiempo) -- funcion pura, sin DB. Ver
// el comentario de cabecera de leaveDaysCalculations.js para la regla
// completa. Fechas ancladas a enero 2026: 2026-01-05 es lunes (mismo
// anclaje que ya usa full-tenant-isolation.test.js / el detalle de
// Perrotta Vicente en Presentismo).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contarDiasLicencia, resolveModoEnFecha } = require('../motor-laboral/services/leaveDaysCalculations');

test('corridos (sin ninguna vigencia cargada) cuenta TODOS los dias, incluido el fin de semana', () => {
  // Lun 05 a Dom 11 de enero 2026 -- una semana completa.
  const dias = contarDiasLicencia('2026-01-05', '2026-01-11', []);
  assert.equal(dias, 7);
});

test('habiles excluye sabado y domingo', () => {
  const vigencias = [{ modo: 'habiles', vigente_desde: '2020-01-01' }];
  // Lun 05 a Dom 11 -- de esos, lun a vie son 5 dias habiles.
  const dias = contarDiasLicencia('2026-01-05', '2026-01-11', vigencias);
  assert.equal(dias, 5);
});

test('habiles ademas excluye un feriado exacto dentro del rango', () => {
  const vigencias = [{ modo: 'habiles', vigente_desde: '2020-01-01' }];
  // Miercoles 07/01 feriado puntual -- de los 5 habiles de la semana quedan 4.
  const feriados = { fechas: new Set(['2026-01-07']) };
  const dias = contarDiasLicencia('2026-01-05', '2026-01-11', vigencias, feriados);
  assert.equal(dias, 4);
});

test('habiles excluye un feriado RECURRENTE (mismo mes/dia todos los anios)', () => {
  const vigencias = [{ modo: 'habiles', vigente_desde: '2020-01-01' }];
  // Jueves 01/01 (Año Nuevo, recurrente) -- rango que arranca justo ahi.
  const feriados = { recurrentesMesDia: new Set(['01-01']) };
  const dias = contarDiasLicencia('2026-01-01', '2026-01-02', vigencias, feriados); // jue feriado + vie habil
  assert.equal(dias, 1);
});

test('una licencia que CRUZA un cambio de vigencia cuenta cada tramo con su propia regla', () => {
  // Motivo que era corridos "desde siempre" y pasa a habiles a partir del
  // 12/01/2026 (un lunes). Licencia del 05/01 (lun) al 18/01 (dom), dos
  // semanas completas, a caballo del cambio.
  const vigencias = [
    { modo: 'corridos', vigente_desde: '2020-01-01' },
    { modo: 'habiles', vigente_desde: '2026-01-12' },
  ];
  // Semana 1 (05-11), todavia corridos: cuentan los 7 dias.
  // Semana 2 (12-18), ya habiles: lun a vie = 5, sab/dom no.
  const dias = contarDiasLicencia('2026-01-05', '2026-01-18', vigencias);
  assert.equal(dias, 7 + 5);
});

test('el orden de las vigencias en el array no importa -- se ordenan solas', () => {
  const vigenciasDesordenadas = [
    { modo: 'habiles', vigente_desde: '2026-01-12' },
    { modo: 'corridos', vigente_desde: '2020-01-01' },
  ];
  const dias = contarDiasLicencia('2026-01-05', '2026-01-18', vigenciasDesordenadas);
  assert.equal(dias, 12);
});

test('un evento de un solo dia en habiles, cayendo sabado, da 0 (no es un bug: ese dia no es habil)', () => {
  const vigencias = [{ modo: 'habiles', vigente_desde: '2020-01-01' }];
  const dias = contarDiasLicencia('2026-01-10', '2026-01-10', vigencias); // sabado
  assert.equal(dias, 0);
});

test('sin ninguna vigencia todavia, un motivo nuevo se comporta EXACTO igual que antes (corridos)', () => {
  const dias = contarDiasLicencia('2026-01-05', '2026-01-05', undefined);
  assert.equal(dias, 1);
});

test('resolveModoEnFecha: antes de la primera vigencia es corridos por default', () => {
  const vigencias = [{ modo: 'habiles', vigente_desde: '2026-01-12' }];
  assert.equal(resolveModoEnFecha('2026-01-01', vigencias), 'corridos');
  assert.equal(resolveModoEnFecha('2026-01-12', vigencias), 'habiles'); // el mismo dia del cambio ya rige la nueva
  assert.equal(resolveModoEnFecha('2026-06-01', vigencias), 'habiles');
});
