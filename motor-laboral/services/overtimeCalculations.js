// Calculo de horas extra "clasicas" (sin marcador dedicado 9/10) -- misma
// regla que ya usaba SOLO index.html/js/app.js ("H. Extras desde Archivos" /
// "Horas Extras online"), extraida aca como funcion pura para que
// /attendance-range (attendance.html) calcule EXACTAMENTE lo mismo en vez de
// su propia heuristica distinta (ultimo fichaje menos un corte fijo de
// 13:40, sin tope). Confirmado por el usuario 2026-08-07: la regla de
// index.html es la que vale, con el tope configurable (antes fijo a 360min).
//
// Regla (ver ayuda de index.html):
//   1. Si no hubo NINGUN fichaje entre las 07:00 y las 14:00 ese dia, se
//      descarta -- probablemente un dia de comision/campo, no un dia de
//      oficina con posible hora extra.
//   2. De los fichajes con hora >= cutoff ("post-corte"), si hay 2 o mas Y
//      el segundo no es tambien el ultimo fichaje del dia, la hora extra
//      "calculada" arranca en ese segundo fichaje y termina en el ultimo
//      fichaje del dia (el primer fichaje post-corte se asume que es "salida
//      a comer/corte", el segundo es el reingreso real).
//   3. Si no (0 o 1 fichaje post-corte, o el segundo es tambien el ultimo),
//      no hay forma de saber cuando arranco la hora extra real -- se asume
//      un inicio de fallback a las 14:00 y se marca needsVerification=true
//      para que un humano lo revise (tipicamente el empleado se olvido de
//      fichar el corte).
//   4. La duracion se topea a capMinutes (configurable, default 360 = 6:00);
//      lo que exceda se marca aparte (overCap) pero no se descarta.
//
// NO incluye la prioridad de marcadores dedicados (badges 9/10, "Marcado
// 9-10" en app.js) -- esa es una fuente de datos distinta (fichajes de un
// usuario ficticio, no de este empleado) que el llamador debe resolver
// aparte (ver movementsCalculations.js) y usar en lugar de esto cuando estan
// presentes ese dia.
const { timeToMinutes } = require('./attendanceCalculations');

const DEFAULT_CUTOFF_MINUTES = 13 * 60 + 40; // 13:40
const DEFAULT_CAP_MINUTES = 360; // 6:00

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

// Pedido real del usuario: "no todos tienen el mismo horario" -- un corte de
// HE unico para toda la empresa (el viejo /config/overtime-settings) no
// tiene sentido cuando un sereno (22:00-06:00) y un administrativo (09:00-
// 18:00) conviven en la misma empresa. El corte para el heuristico clasico
// (Prioridad 2, cuando no hay marcador real ese dia) pasa a resolverse por
// PLANTILLA de cada empleado:
//   1. Si la plantilla asignada tiene su propio "Corte HE" (overtime_cutoff_time),
//      se usa ese -- lo carga un admin en la plantilla (Motor Laboral > Plantillas).
//   2. Si no, se usa el horario de SALIDA de la plantilla de ese dia (schedule.timeExit)
//      -- "despues de terminar su horario" (solo importa si esta autorizado a
//      hacer HE, algo que ya se filtra aparte via employees.overtime_authorized/
//      overtimeAuthorizationMode, no es responsabilidad de esta funcion).
//   3. Si no se pudo resolver ni siquiera el horario (schedule null/sin timeExit
//      -- caso raro, dato faltante), cae al corte global configurado
//      (globalCutoffMinutes) como ultimo respaldo, para no dejar de calcular HE.
// schedule: el objeto que ya arma scheduleRepository.buildScheduleFromBlocks
// (trae overtimeCutoffTime y timeExit) -- puede ser null si no se pudo resolver.
function resolveOvertimeCutoffMinutes(schedule, globalCutoffMinutes) {
  if (schedule && schedule.overtimeCutoffTime) {
    return timeToMinutes(schedule.overtimeCutoffTime);
  }
  if (schedule && schedule.timeExit) {
    return timeToMinutes(schedule.timeExit);
  }
  return globalCutoffMinutes ?? DEFAULT_CUTOFF_MINUTES;
}

// Mismo criterio que resolveOvertimeCutoffMinutes, para el TOPE diario de HE:
// el de la plantilla (si esta cargado) gana sobre el tope global configurado
// -- sin fallback a "horario de salida" aca (un tope no tiene un equivalente
// de horario, a diferencia del corte).
function resolveOvertimeCapMinutes(schedule, globalCapMinutes) {
  if (schedule && schedule.overtimeCapMinutes !== null && schedule.overtimeCapMinutes !== undefined) {
    return Number(schedule.overtimeCapMinutes);
  }
  return globalCapMinutes ?? DEFAULT_CAP_MINUTES;
}

// checkins: Date[] -- todos los fichajes de UN empleado en UN dia (no hace
// falta que vengan ordenados). Devuelve null si ese dia no genera hora extra
// (sin actividad normal, o duracion resultante <= 0), o:
//   { needsVerification, start, end, minutes, cappedMinutes, overCap }
function computeDailyOvertime(checkins, options = {}) {
  const cutoffMinutes = options.cutoffMinutes ?? DEFAULT_CUTOFF_MINUTES;
  const capMinutes = options.capMinutes ?? DEFAULT_CAP_MINUTES;

  if (!checkins || checkins.length === 0) return null;
  const sorted = checkins.slice().sort((a, b) => a - b);

  const huboActividadNormal = sorted.some(d => {
    const m = minutesSinceMidnight(d);
    return m >= 7 * 60 && m <= 14 * 60;
  });
  if (!huboActividadNormal) return null;

  // "posterior a" el corte, estricto -- una marca justo EN el corte todavia
  // es el fichaje normal del corte, no el reingreso a hora extra (pedido
  // explicito del usuario: el ingreso a HE tiene que ser posterior a la
  // hora configurada, no igual).
  const postCutoff = sorted.filter(d => minutesSinceMidnight(d) > cutoffMinutes);
  const lastCheckin = sorted[sorted.length - 1];

  let start;
  let needsVerification;
  if (postCutoff.length >= 2 && postCutoff[1] !== lastCheckin) {
    start = postCutoff[1];
    needsVerification = false;
  } else {
    // Antes esto usaba un "14:00" fijo (heredado de js/app.js) sin importar
    // que corte estuviera configurado -- si alguien configuraba, por
    // ejemplo, las 13:38, el fallback igual asumia 14:00 e ignoraba lo
    // configurado. Ahora el fallback ES la hora de corte configurada (sigue
    // siendo una suposicion que necesita needsVerification=true, pero
    // arranca del corte real en vez de un horario hardcodeado que no
    // respeta la configuracion).
    const base = sorted[0];
    const cutoffHour = Math.floor(cutoffMinutes / 60);
    const cutoffMin = Math.floor(cutoffMinutes % 60);
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), cutoffHour, cutoffMin, 0);
    needsVerification = true;
  }

  const minutes = Math.round((lastCheckin - start) / 60000);
  if (minutes <= 0) return null;

  return {
    needsVerification,
    start,
    end: lastCheckin,
    minutes,
    cappedMinutes: Math.min(minutes, capMinutes),
    overCap: minutes > capMinutes
  };
}

// Jerarquia completa de un dia, igual a la que ya usaba js/app.js/index.html
// (y ahora tambien /attendance-range): PRIORIDAD 1, un intervalo real
// marcado con badges dedicados (9/10, category HE en specialusers, via
// movementsCalculations.detectMovements -- el llamador ya lo resolvio
// aparte, esta funcion no sabe de marcadores); PRIORIDAD 2, el heuristico
// "clasico" (computeDailyOvertime) si ese dia no tuvo marca real. Separado
// en su propia funcion pura para poder testear la jerarquia sin tocar DB.
//
// heInterval: { timeOut: Date, timeIn: Date } | null | undefined -- ya
//   resuelto por el llamador (un closedEvent de categoria HE para este
//   empleado/dia, o nada si no marco).
// fallbackChecks: Date[] -- todos los fichajes de ese empleado ese dia,
//   para la Prioridad 2.
// Bug real (Perrotta, legajo 2525, 16/09/2026 -- confirmado contra Checkins
// de produccion): un marcador de "Ingreso a HE" (badge 9) fichado por OTRA
// persona (ej. un sereno saliendo de su turno) justo antes de que este
// empleado marcara su entrada normal de la mañana quedaba "vivo" (dentro de
// maxMarkerGapMs) y detectMovements se lo atribuia a ESE fichaje -- abriendo
// una HE fantasma desde la hora de entrada normal (6:56) hasta el fichaje
// siguiente, horas despues (6h43m que nunca pasaron).
//
// Un "ingreso a HE" real de esta persona practicamente nunca es TAMBIEN su
// PRIMER fichaje del dia -- si arranco una hora extra, ya venia trabajando
// desde la mañana. Si el fichaje que "abrio" el intervalo (heInterval.timeOut)
// coincide con el primer fichaje del dia de esta persona, es mucho mas
// probable que el marcador fuera de otra persona y este fichaje, al ser el
// siguiente en sonar el lector, se lo haya "robado" -- se lo descarta (queda
// igual que si el marcador no hubiera sonado ese dia).
function isFirstCheckinOfDay(moment, fallbackChecks) {
  if (!moment || !fallbackChecks || fallbackChecks.length === 0) return false;
  const first = fallbackChecks.reduce((min, d) => (d < min ? d : min), fallbackChecks[0]);
  return first.getTime() === moment.getTime();
}

function resolveDailyOvertime(heInterval, fallbackChecks, options = {}) {
  const capMinutes = options.capMinutes ?? DEFAULT_CAP_MINUTES;

  const heIntervalIsSuspicious = !!(heInterval && heInterval.timeOut && isFirstCheckinOfDay(heInterval.timeOut, fallbackChecks));

  if (!heIntervalIsSuspicious && heInterval && heInterval.timeIn && heInterval.timeOut) {
    const minutes = Math.round((heInterval.timeIn - heInterval.timeOut) / 60000);
    if (minutes > 0) {
      return {
        source: 'marker',
        minutes,
        cappedMinutes: Math.min(minutes, capMinutes),
        overCap: minutes > capMinutes,
        needsVerification: false,
        // start/end -- igual que ya devuelve el fallback de abajo, para que
        // el listado "Horas Extra por Regimen" pueda mostrar la hora exacta
        // en la que empezo la HE sin importar de que fuente salio.
        start: heInterval.timeOut,
        end: heInterval.timeIn
      };
    }
  }

  const fallback = computeDailyOvertime(fallbackChecks, options);
  if (!fallback) return null;
  return { ...fallback, source: 'fallback' };
}

module.exports = {
  DEFAULT_CUTOFF_MINUTES,
  DEFAULT_CAP_MINUTES,
  computeDailyOvertime,
  resolveDailyOvertime,
  resolveOvertimeCutoffMinutes,
  resolveOvertimeCapMinutes
};
