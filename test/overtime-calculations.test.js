// Tests unitarios de la regla de horas extra "clasicas" (sin marcador 9/10),
// portada 1:1 desde js/app.js (index.html) a motor-laboral/services -- ver
// comentario de cabecera de overtimeCalculations.js para la regla completa.
// No requieren DB -- son funciones puras.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDailyOvertime,
  resolveDailyOvertime,
  resolveOvertimeCutoffMinutes,
  resolveOvertimeCapMinutes,
  DEFAULT_CUTOFF_MINUTES,
  DEFAULT_CAP_MINUTES
} = require('../motor-laboral/services/overtimeCalculations');

const dt = (hms) => new Date(`2026-08-01T${hms}`);

test('computeDailyOvertime: caso normal -- 2do fichaje post-corte hasta el ultimo', () => {
  // 07:02 entrada, 13:41 "corte" (primer post-corte), 14:15 reingreso real
  // (segundo post-corte), 18:30 salida final -- la HE va de 14:15 a 18:30.
  const checkins = [dt('07:02:00'), dt('13:41:00'), dt('14:15:00'), dt('18:30:00')];
  const result = computeDailyOvertime(checkins);

  assert.equal(result.needsVerification, false);
  assert.equal(result.start.getTime(), dt('14:15:00').getTime());
  assert.equal(result.end.getTime(), dt('18:30:00').getTime());
  assert.equal(result.minutes, 255); // 4h15
  assert.equal(result.cappedMinutes, 255);
  assert.equal(result.overCap, false);
});

test('computeDailyOvertime: sin actividad entre 07:00 y 14:00 -- se descarta (probable comision)', () => {
  const checkins = [dt('15:00:00'), dt('20:00:00')];
  assert.equal(computeDailyOvertime(checkins), null);
});

test('computeDailyOvertime: un solo fichaje post-corte -- Auto-Verificar con fallback al corte configurado', () => {
  // Entro normal, y una unica marca a la salida final (19:00) -- no hay forma
  // de saber cuando arranco la HE real, se asume el corte configurado
  // (13:40 default) y se pide verificar. Antes esto asumia un "14:00" fijo
  // sin importar el corte configurado -- corregido a pedido del usuario
  // (el inicio de HE tiene que respetar la hora de corte real).
  const checkins = [dt('07:00:00'), dt('12:30:00'), dt('19:00:00')];
  const result = computeDailyOvertime(checkins);

  assert.equal(result.needsVerification, true);
  assert.equal(result.start.getTime(), dt('13:40:00').getTime());
  assert.equal(result.end.getTime(), dt('19:00:00').getTime());
  assert.equal(result.minutes, 320); // 5h20 (13:40 -> 19:00)
});

test('computeDailyOvertime: el segundo fichaje post-corte es tambien el ultimo -- Auto-Verificar', () => {
  // Solo dos marcas post-corte: la del corte (13:45) y la salida final
  // (19:50) -- tomar la 2da como "reingreso" daria una duracion de 0 (inicio
  // y fin serian la misma marca). Debe pedir verificar con el fallback al
  // corte configurado, no calcular una HE de 0 minutos.
  const checkins = [dt('07:00:00'), dt('13:45:00'), dt('19:50:00')];
  const result = computeDailyOvertime(checkins);

  assert.equal(result.needsVerification, true);
  assert.equal(result.start.getTime(), dt('13:40:00').getTime());
  assert.equal(result.end.getTime(), dt('19:50:00').getTime());
});

test('computeDailyOvertime: el fichaje de inicio de HE debe ser POSTERIOR al corte, no igual', () => {
  // Marca justo EN el corte (13:40:00 con cutoff 13:40) no cuenta como
  // "post-corte" -- pedido explicito del usuario: tiene que ser posterior,
  // no exactamente a esa hora. Con esta unica marca post-corte real
  // ausente, cae al fallback (arranca del corte configurado).
  const checkins = [dt('07:00:00'), dt('13:40:00'), dt('19:00:00')];
  const result = computeDailyOvertime(checkins);

  assert.equal(result.needsVerification, true);
  assert.equal(result.start.getTime(), dt('13:40:00').getTime());
});

test('computeDailyOvertime: topeado a capMinutes, marca overCap sin descartar', () => {
  const checkins = [dt('07:00:00'), dt('13:41:00'), dt('14:00:00'), dt('22:00:00')];
  const result = computeDailyOvertime(checkins, { capMinutes: 360 });

  assert.equal(result.minutes, 480); // 8h
  assert.equal(result.cappedMinutes, 360);
  assert.equal(result.overCap, true);
});

test('computeDailyOvertime: cutoff configurable (13:38 en vez del default 13:40)', () => {
  const checkins = [dt('07:00:00'), dt('13:39:00'), dt('14:10:00'), dt('18:00:00')];
  // Con el default 13:40, la marca de 13:39 no cuenta como "post-corte" -> un
  // solo fichaje post-corte (14:10) -> needsVerification.
  const withDefault = computeDailyOvertime(checkins);
  assert.equal(withDefault.needsVerification, true);

  // Con cutoff 13:38, la de 13:39 SI cuenta como post-corte -> 2 marcas
  // post-corte (13:39 y 14:10) y la 2da no es la ultima -> calculado.
  const withCustomCutoff = computeDailyOvertime(checkins, { cutoffMinutes: 13 * 60 + 38 });
  assert.equal(withCustomCutoff.needsVerification, false);
  assert.equal(withCustomCutoff.start.getTime(), dt('14:10:00').getTime());
});

test('computeDailyOvertime: fallback al corte cae DESPUES del ultimo fichaje -- se descarta', () => {
  // Caso limite real: si el ultimo fichaje del dia es ANTES del corte (se
  // retiro temprano, sin ninguna marca post-corte), el fallback -- que
  // arranca en el corte configurado -- da una duracion negativa. Se omite
  // el dia en vez de sumar una HE negativa (mismo criterio que ya tenia
  // app.js con su fallback fijo de las 14:00, solo que ahora el punto de
  // referencia es el corte real configurado).
  const checkins = [dt('07:00:00'), dt('12:30:00')];
  assert.equal(computeDailyOvertime(checkins), null);
});

test('computeDailyOvertime: sin fichajes ese dia devuelve null', () => {
  assert.equal(computeDailyOvertime([]), null);
  assert.equal(computeDailyOvertime(null), null);
});

test('defaults exportados coinciden con los que usaba index.html hardcodeados', () => {
  assert.equal(DEFAULT_CUTOFF_MINUTES, 13 * 60 + 40);
  assert.equal(DEFAULT_CAP_MINUTES, 360);
});

// resolveDailyOvertime: jerarquia PRIORIDAD 1 (marcador real badge 9/10) /
// PRIORIDAD 2 (heuristico "clasico"), igual a la que ya usaba
// js/app.js/index.html -- ahora tambien en /attendance-range.
test('resolveDailyOvertime: con intervalo de marcador (badge 9/10) real, usa eso -- ignora los fichajes crudos', () => {
  const heInterval = { timeOut: dt('13:40:00'), timeIn: dt('17:00:00') }; // 3h20 = 200min
  // Fichajes crudos que, solos, darian un resultado MUY distinto por la
  // regla clasica -- no debe usarse, porque hay marcador real.
  const fallbackChecks = [dt('07:00:00'), dt('13:41:00'), dt('20:00:00')];

  const result = resolveDailyOvertime(heInterval, fallbackChecks);

  assert.equal(result.source, 'marker');
  assert.equal(result.minutes, 200);
  assert.equal(result.cappedMinutes, 200);
  assert.equal(result.needsVerification, false);
});

test('resolveDailyOvertime: el intervalo de marcador tambien se topea al cap configurado', () => {
  const heInterval = { timeOut: dt('13:00:00'), timeIn: dt('22:00:00') }; // 9h = 540min
  const result = resolveDailyOvertime(heInterval, [], { capMinutes: 360 });

  assert.equal(result.source, 'marker');
  assert.equal(result.minutes, 540);
  assert.equal(result.cappedMinutes, 360);
  assert.equal(result.overCap, true);
});

test('resolveDailyOvertime: sin intervalo de marcador, cae al heuristico clasico (Prioridad 2)', () => {
  const fallbackChecks = [dt('07:00:00'), dt('13:41:00'), dt('14:15:00'), dt('18:30:00')];
  const result = resolveDailyOvertime(null, fallbackChecks);

  assert.equal(result.source, 'fallback');
  assert.equal(result.needsVerification, false);
  assert.equal(result.minutes, 255); // mismo resultado que computeDailyOvertime solo
});

test('resolveDailyOvertime: intervalo de marcador con duracion invalida (<=0) tambien cae al heuristico', () => {
  // Defensivo: si el marcador diera una duracion negativa o cero (dato
  // corrupto/orden invertido), no se reporta una HE negativa -- se cae al
  // heuristico como si no hubiera marcador.
  const heInterval = { timeOut: dt('17:00:00'), timeIn: dt('13:00:00') }; // invertido
  const fallbackChecks = [dt('07:00:00'), dt('13:41:00'), dt('14:15:00'), dt('18:30:00')];

  const result = resolveDailyOvertime(heInterval, fallbackChecks);

  assert.equal(result.source, 'fallback');
  assert.equal(result.minutes, 255);
});

test('resolveDailyOvertime: sin marcador ni actividad valida, null (ningun dia con HE)', () => {
  assert.equal(resolveDailyOvertime(null, []), null);
  assert.equal(resolveDailyOvertime(undefined, [dt('15:00:00'), dt('20:00:00')]), null); // sin actividad 07-14h
});

// Caso real: Perrotta, legajo 2525, 16/09/2026. Otra persona (probablemente
// un sereno saliendo de su turno) fichó el marcador "Ingreso a HE" (badge 9)
// justo antes de que Perrotta marcara su entrada normal de la mañana (6:56)
// -- el marcador seguia "vivo" y detectMovements se lo atribuyo a ESE
// fichaje, abriendo una HE fantasma de 6:56 hasta su fichaje siguiente
// (6h43m que nunca pasaron). Confirmado contra los Checkins reales de
// produccion antes de este fix.
test('resolveDailyOvertime: el intervalo de marcador se descarta si "abre" con el PRIMER fichaje del dia de la persona', () => {
  const heInterval = { timeOut: dt('06:56:00'), timeIn: dt('13:39:00') }; // 6h43 -- fantasma
  const fallbackChecks = [dt('06:56:00'), dt('13:39:00')];

  const result = resolveDailyOvertime(heInterval, fallbackChecks);

  // Sin actividad entre 07:00 y 14:00 en este ejemplo puntual -- computeDailyOvertime
  // devuelve null (mismo criterio que "sin marcador ese dia"), no los 6h43m fantasma.
  assert.equal(result, null);
});

// Corte de HE por plantilla (pedido real: "no todos tienen el mismo
// horario") -- reemplaza el corte único global como fuente principal.
test('resolveOvertimeCutoffMinutes: usa el corte propio de la plantilla cuando existe', () => {
  const schedule = { overtimeCutoffTime: '18:00:00', timeExit: '17:00:00' };
  assert.equal(resolveOvertimeCutoffMinutes(schedule, 820), 18 * 60);
});

test('resolveOvertimeCutoffMinutes: sin corte propio, usa el horario de salida de la plantilla', () => {
  const schedule = { overtimeCutoffTime: null, timeExit: '22:30:00' }; // ej. un sereno
  assert.equal(resolveOvertimeCutoffMinutes(schedule, 820), 22 * 60 + 30);
});

test('resolveOvertimeCutoffMinutes: sin plantilla resuelta, cae al corte global configurado', () => {
  assert.equal(resolveOvertimeCutoffMinutes(null, 820), 820);
  assert.equal(resolveOvertimeCutoffMinutes({}, 820), 820);
});

test('resolveOvertimeCutoffMinutes: sin plantilla ni corte global, cae al default histórico (13:40)', () => {
  assert.equal(resolveOvertimeCutoffMinutes(null, undefined), DEFAULT_CUTOFF_MINUTES);
});

test('resolveOvertimeCapMinutes: usa el tope propio de la plantilla cuando esta cargado', () => {
  assert.equal(resolveOvertimeCapMinutes({ overtimeCapMinutes: 180 }, 360), 180);
});

test('resolveOvertimeCapMinutes: tope propio en 0 es un valor valido (no cae al global)', () => {
  assert.equal(resolveOvertimeCapMinutes({ overtimeCapMinutes: 0 }, 360), 0);
});

test('resolveOvertimeCapMinutes: sin tope propio, cae al tope global configurado', () => {
  assert.equal(resolveOvertimeCapMinutes({ overtimeCapMinutes: null }, 360), 360);
  assert.equal(resolveOvertimeCapMinutes(null, 360), 360);
});

test('resolveOvertimeCapMinutes: sin plantilla ni tope global, cae al default histórico (360)', () => {
  assert.equal(resolveOvertimeCapMinutes(null, undefined), DEFAULT_CAP_MINUTES);
});

test('resolveDailyOvertime: el intervalo de marcador se respeta si NO coincide con el primer fichaje del dia', () => {
  // Mismo heInterval que arriba, pero esta persona ya tenia un fichaje ANTES
  // (entrada normal real a las 06:30) -- el marcador de las 06:56 no es su
  // primer fichaje del dia, se confia en el normalmente.
  const heInterval = { timeOut: dt('06:56:00'), timeIn: dt('13:39:00') };
  const fallbackChecks = [dt('06:30:00'), dt('06:56:00'), dt('13:39:00')];

  const result = resolveDailyOvertime(heInterval, fallbackChecks);

  assert.equal(result.source, 'marker');
  assert.equal(result.minutes, 403); // 6h43, real esta vez
});
