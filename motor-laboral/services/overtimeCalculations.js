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
const DEFAULT_CUTOFF_MINUTES = 13 * 60 + 40; // 13:40
const DEFAULT_CAP_MINUTES = 360; // 6:00

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
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

  const postCutoff = sorted.filter(d => minutesSinceMidnight(d) >= cutoffMinutes);
  const lastCheckin = sorted[sorted.length - 1];

  let start;
  let needsVerification;
  if (postCutoff.length >= 2 && postCutoff[1] !== lastCheckin) {
    start = postCutoff[1];
    needsVerification = false;
  } else {
    const base = sorted[0];
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 14, 0, 0);
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
function resolveDailyOvertime(heInterval, fallbackChecks, options = {}) {
  const capMinutes = options.capMinutes ?? DEFAULT_CAP_MINUTES;

  if (heInterval && heInterval.timeIn && heInterval.timeOut) {
    const minutes = Math.round((heInterval.timeIn - heInterval.timeOut) / 60000);
    if (minutes > 0) {
      return {
        source: 'marker',
        minutes,
        cappedMinutes: Math.min(minutes, capMinutes),
        overCap: minutes > capMinutes,
        needsVerification: false
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
  resolveDailyOvertime
};
