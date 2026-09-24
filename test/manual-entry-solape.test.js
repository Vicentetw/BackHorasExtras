// "Si fichó, esa es la fuente de la verdad".
//
// EL CASO (23/09/2026, legajo 2525)
// ----------------------------------
// Fichajes reales: 07:00:34, 13:39:10, 13:39:17, 14:22:11.
// Carga manual de HE: 13:40 -> 14:00 (20 minutos).
//
// Esos 20 minutos caen DENTRO del tiempo ya fichado y el cálculo los sumaba
// igual: 20 minutos contados dos veces. Medido en producción el mismo día: de
// 9 cargas manuales de HE, 4 se superponían, 323 minutos (5,4 horas) contados
// dos veces.
//
// Hay dos mitades, y las dos se prueban acá:
//   1. BLOQUEAR AL CARGAR -- avisa cuando la persona puede corregir;
//   2. NO CONTAR DOS VECES AL CALCULAR -- porque los fichajes pueden llegar
//      DESPUÉS (el agente sincroniza a la noche, la carga se hizo a la
//      mañana) y ahí la validación del alta no ve nada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const reglas = require('../manualEntryRules');

// Los fichajes reales del caso.
const FICHAJES = [
  '2026-09-23 07:00:34',
  '2026-09-23 13:39:10',
  '2026-09-23 13:39:17',
  '2026-09-23 14:22:11',
];

// ---------------------------------------------------------------------------
// El tramo fichado
// ---------------------------------------------------------------------------

test('el tramo va del primer fichaje al último', () => {
  const t = reglas.tramoFichado(FICHAJES);
  assert.equal(new Date(t.desde).getHours(), 7);
  assert.equal(new Date(t.hasta).getHours(), 14);
});

test('con un solo fichaje no hay tramo', () => {
  // Alguien que fichó la entrada y se olvidó la salida: no se puede afirmar
  // hasta cuándo estuvo, así que no se bloquea nada. Es justamente el caso
  // en que la carga manual hace falta.
  assert.equal(reglas.tramoFichado(['2026-09-23 07:00:00']), null);
  assert.equal(reglas.tramoFichado([]), null);
  assert.equal(reglas.tramoFichado(null), null);
});

// ---------------------------------------------------------------------------
// Bloquear al cargar
// ---------------------------------------------------------------------------

test('EL CASO: cargar HE de 13:40 a 14:00 sobre un día fichado hasta 14:22 se rechaza', () => {
  const msg = reglas.validarSolape(
    { startDatetime: '2026-09-23 13:40:00', endDatetime: '2026-09-23 14:00:00' }, FICHAJES);

  assert.ok(msg, 'tiene que rechazarlo');
  assert.match(msg, /ya está fichado/);
  assert.match(msg, /07:00/, 'dice desde cuándo');
  assert.match(msg, /14:22/, 'y hasta cuándo');
  assert.match(msg, /20 minutos/, 'y cuánto se superpone');
  // El mensaje tiene que decir qué hacer, no solo que está mal.
  assert.match(msg, /no esté fichado/);
});

test('una carga DESPUÉS del último fichaje se acepta', () => {
  // Es el caso legítimo: se quedó trabajando y no fichó la salida real.
  assert.equal(reglas.validarSolape(
    { startDatetime: '2026-09-23 14:30:00', endDatetime: '2026-09-23 16:00:00' }, FICHAJES), null);
});

test('una carga ANTES del primer fichaje se acepta', () => {
  assert.equal(reglas.validarSolape(
    { startDatetime: '2026-09-23 05:00:00', endDatetime: '2026-09-23 06:30:00' }, FICHAJES), null);
});

test('pegada al borde, sin pisar, se acepta', () => {
  // Termina justo cuando empieza el tramo fichado: no hay ni un minuto
  // compartido. Rechazarlo obligaría a dejar un hueco artificial.
  assert.equal(reglas.validarSolape(
    { startDatetime: '2026-09-23 06:00:00', endDatetime: '2026-09-23 07:00:34' }, FICHAJES), null);
  assert.equal(reglas.validarSolape(
    { startDatetime: '2026-09-23 14:22:11', endDatetime: '2026-09-23 15:00:00' }, FICHAJES), null);
});

test('si se pisa aunque sea parcialmente, también se rechaza', () => {
  // Empieza dentro del tramo y termina afuera.
  const msg = reglas.validarSolape(
    { startDatetime: '2026-09-23 14:00:00', endDatetime: '2026-09-23 15:00:00' }, FICHAJES);
  assert.ok(msg);
  assert.match(msg, /22 minutos/, '14:00 a 14:22 son 22 minutos');
});

test('sin fichajes ese día no se bloquea nada', () => {
  assert.equal(reglas.validarSolape(
    { startDatetime: '2026-09-23 13:40:00', endDatetime: '2026-09-23 14:00:00' }, []), null);
});

// ---------------------------------------------------------------------------
// No contar dos veces al calcular
// ---------------------------------------------------------------------------

test('LA GARANTÍA: los minutos ya fichados no se suman de nuevo', () => {
  const min = reglas.minutosQueNoSeSolapan(
    { durationMinutes: 20, startDatetime: '2026-09-23 13:40:00', endDatetime: '2026-09-23 14:00:00' },
    FICHAJES);
  assert.equal(min, 0, 'los 20 minutos ya estaban contados por el reloj');
});

test('de una carga a medias, solo cuenta la parte no fichada', () => {
  // 14:00 a 15:00 = 60 minutos, de los cuales 22 (hasta 14:22) ya estaban.
  const min = reglas.minutosQueNoSeSolapan(
    { durationMinutes: 60, startDatetime: '2026-09-23 14:00:00', endDatetime: '2026-09-23 15:00:00' },
    FICHAJES);
  assert.equal(min, 38);
});

test('una carga que no se pisa cuenta entera', () => {
  const min = reglas.minutosQueNoSeSolapan(
    { durationMinutes: 90, startDatetime: '2026-09-23 14:30:00', endDatetime: '2026-09-23 16:00:00' },
    FICHAJES);
  assert.equal(min, 90);
});

test('sin fichajes, la carga cuenta entera', () => {
  const min = reglas.minutosQueNoSeSolapan(
    { durationMinutes: 120, startDatetime: '2026-09-23 13:00:00', endDatetime: '2026-09-23 15:00:00' }, []);
  assert.equal(min, 120);
});

test('nunca devuelve negativo', () => {
  // Una duración menor que el solape (alguien cargó "de 13:00 a 15:00, 10
  // minutos"): no puede restar del total del día.
  const min = reglas.minutosQueNoSeSolapan(
    { durationMinutes: 10, startDatetime: '2026-09-23 08:00:00', endDatetime: '2026-09-23 14:00:00' },
    FICHAJES);
  assert.equal(min, 0);
});

test('la duración guardada manda sobre el largo del rango', () => {
  // Alguien puede cargar "de 18:00 a 22:00, 90 minutos" para reflejar que
  // dentro de ese rango trabajó hora y media. Sin solape, valen los 90, no
  // los 240 del rango.
  const min = reglas.minutosQueNoSeSolapan(
    { durationMinutes: 90, startDatetime: '2026-09-23 18:00:00', endDatetime: '2026-09-23 22:00:00' },
    FICHAJES);
  assert.equal(min, 90);
});
