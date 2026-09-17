// Motor de deteccion de "salidas" (Particular / Oficial / Campana) a partir de
// usuarios ficticios (marcadores) fichados en el reloj. Mismo principio que ya
// funciona para horas extra (badges 9/10), generalizado a badges 3-8.
//
// Funciones puras (sin I/O) -- el llamador resuelve DB (checkins, specialusers,
// horarios) y le pasa datos ya crudos/resueltos. Validado contra un caso real
// (legajo 2518, 23/07/2026): el reloj genera ruido (USERID que no resuelve a
// nadie) y lecturas repetidas del mismo marcador en segundos, asi que "la fila
// que sigue" al marcador no alcanza -- hay que ignorar ruido y, si el empleado
// ya tenia una salida abierta, su proximo fichaje la cierra en vez de abrir
// una nueva (evita "salidas" fantasma de segundos por doble lectura del reloj).
// Tambien vencen los marcadores no consumidos en unos minutos (ver
// DEFAULT_MAX_MARKER_GAP_MS) para no atribuirle a un empleado el marcador de
// otro que quedo "colgado" por ruido en el medio.
const { timeToMinutes } = require('./attendanceCalculations');

// checkins: [{ checktime: Date, userId: number, employeeId: string|null }, ...]
//   employeeId null = fichaje que no resuelve a un empleado real (ruido del
//   reloj o un marcador). No hace falta que vengan ordenados.
// markerMap: { [userId]: { category: 'PARTICULAR'|'OFICIAL'|'CAMPANA', direction: 'SALIDA'|'REGRESO' } }
//
// Devuelve { closedEvents, openEvents, orphanReturns } donde:
//   closedEvents:  [{ employeeId, category, timeOut, timeIn }]
//   openEvents:    Map employeeId -> { category, timeOut } (no se encontro regreso en el rango dado)
//   orphanReturns: [{ employeeId, category, timeIn }] -- marcador REGRESO que
//     precedio a un fichaje real sin que ese empleado tuviera una salida
//     abierta. No es necesariamente un dato inconsistente: para PARTICULAR
//     tambien pasa cuando alguien avisa el dia anterior que va a entrar tarde
//     (autorizacion firmada) -- nunca ficha una "salida" ese dia, solo el
//     regreso antes de su primer ingreso. El llamador decide que hacer con
//     esto (ver /attendance-range, que lo usa para sugerir justificar una
//     tardanza) -- closedEvents/openEvents no cambian, es aditivo.
// maxMarkerGapMs: si pasa mas de esto entre que se ficha un marcador y el
// proximo fichaje real que lo "consume", el marcador se descarta por vencido
// en vez de atribuirse a quien sea que aparezca despues. Caso real que
// destapo esto (Perrotta, legajo 2525, 02/07/2026): un badge 6 a las 13:33:54
// -- casi seguro para OTRO empleado, el fichaje que le siguio 4s despues no
// resolvio a nadie -- quedo "vivo" 6m25s hasta que Perrotta fichó dos veces
// seguidas por otro motivo, y el sistema le atribuyo una "salida particular"
// de 12 segundos que nunca ocurrió. En todos los casos reales confirmados
// (RUBINO, Perrotta entrada particular) el marcador se consume en segundos,
// nunca en minutos -- configurable desde marcadores.html (/config/marker-max-gap-seconds),
// default 30s.
const DEFAULT_MAX_MARKER_GAP_MS = 30 * 1000;

// Rebote del lector del PROPIO empleado: dos lecturas de una misma accion
// fisica (mismo empleado, un puñado de segundos de diferencia -- el mismo
// fenomeno ya documentado para marcadores, ver RUBINO en los tests, ahi con
// ~12s entre lecturas repetidas). Sin este resguardo, si otra persona
// distinta fichaba un marcador justo en el medio de esas dos lecturas, la
// SEGUNDA lectura (la redundante) "consumia" ese marcador como si fuera
// una accion nueva -- caso real: SANTIBAÑEZ 18/08/2026, dos fichajes
// propios a 12s (13:37:29 y 13:37:41) con un marcador de Salida a Campaña
// de OTRO empleado fichado justo en el medio (13:37:34); la segunda
// lectura de SANTIBAÑEZ abria una "salida a Campaña" que en realidad era
// solo su propia hora extra (badges 9/10), no una salida real -- aparecia
// duplicada en dos informes distintos.
const DEFAULT_OWN_CHECKIN_BOUNCE_MS = 20 * 1000;

function detectMovements(checkins, markerMap, options = {}) {
  const maxMarkerGapMs = options.maxMarkerGapMs ?? DEFAULT_MAX_MARKER_GAP_MS;
  const ownCheckinBounceMs = options.ownCheckinBounceMs ?? DEFAULT_OWN_CHECKIN_BOUNCE_MS;
  const sorted = checkins.slice().sort((a, b) => a.checktime - b.checktime);
  let lastMarker = null; // { category, direction, markedAt, userId }
  const openEvents = new Map();
  const closedEvents = [];
  const orphanReturns = [];
  const lastRealCheckinByEmployeeId = new Map();

  for (const row of sorted) {
    const marker = markerMap[row.userId];
    if (marker) {
      lastMarker = { category: marker.category, direction: marker.direction, markedAt: row.checktime, userId: row.userId };
      continue;
    }

    if (!row.employeeId) {
      // Ruido del reloj: USERID que no resuelve a ningun empleado ni marcador.
      // No se toca lastMarker -- sigue "vivo" hasta el proximo fichaje real
      // (o hasta vencer, ver maxMarkerGapMs).
      continue;
    }

    if (lastMarker && (row.checktime - lastMarker.markedAt) > maxMarkerGapMs) {
      lastMarker = null;
    }

    const open = openEvents.get(row.employeeId);
    if (open) {
      // Este empleado ya tenia una salida abierta: este fichaje la cierra,
      // sin importar si tambien vino precedido de un marcador de regreso.
      // No se aplica el resguardo de rebote aca a proposito -- cerrar es
      // idempotente en el sentido de que no inventa un evento nuevo, solo
      // le pone fin a uno que ya existia.
      // Pedido real: "quiero ver que marcador hubo (si lo hubo)" para poder
      // detectar/corregir una atribucion erronea (ej. AVILA, 08/04/2026 --
      // su propia entrada se tomo como Salida por un marcador ajeno) --
      // regresoMarkerUserId es INFORMATIVO, el cierre pasa igual aunque no
      // haya ningun marcador de regreso pendiente en este momento.
      closedEvents.push({
        employeeId: row.employeeId,
        category: open.category,
        timeOut: open.timeOut,
        timeIn: row.checktime,
        salidaMarkerUserId: open.salidaMarkerUserId,
        regresoMarkerUserId: lastMarker ? lastMarker.userId : null
      });
      openEvents.delete(row.employeeId);
      lastMarker = null;
      lastRealCheckinByEmployeeId.set(row.employeeId, row.checktime);
      continue;
    }

    const previousOwnCheckin = lastRealCheckinByEmployeeId.get(row.employeeId);
    const isOwnBounce = previousOwnCheckin != null && (row.checktime - previousOwnCheckin) <= ownCheckinBounceMs;
    lastRealCheckinByEmployeeId.set(row.employeeId, row.checktime);

    if (isOwnBounce) {
      // No consume el marcador activo -- si en el medio fichó otra
      // persona (el caso real), el marcador le sigue llegando a ella en
      // vez de a este rebote.
      continue;
    }

    if (lastMarker && lastMarker.direction === 'SALIDA') {
      openEvents.set(row.employeeId, {
        category: lastMarker.category,
        timeOut: row.checktime,
        salidaMarkerUserId: lastMarker.userId
      });
    } else if (lastMarker && lastMarker.direction === 'REGRESO') {
      orphanReturns.push({
        employeeId: row.employeeId,
        category: lastMarker.category,
        timeIn: row.checktime,
        regresoMarkerUserId: lastMarker.userId
      });
    }
    lastMarker = null;
  }

  return { closedEvents, openEvents, orphanReturns };
}

// Para Particular/Oficial: una salida que sigue abierta al terminar el rango
// consultado se cierra con el horario de salida programado de ese empleado
// ese dia (Campana NO usa esto -- ver comentario en el endpoint).
// exitTimeByEmployeeId: Map employeeId -> Date|null (ya resuelto por el
// llamador via scheduleRepository, mismo patron que usa /attendance-range).
function closeOpenEventsAtScheduleExit(openEvents, exitTimeByEmployeeId) {
  const results = [];
  for (const [employeeId, ev] of openEvents.entries()) {
    const exit = exitTimeByEmployeeId.get(employeeId) || null;
    results.push({
      employeeId,
      category: ev.category,
      timeOut: ev.timeOut,
      timeIn: exit,
      hasReturn: false,
      salidaMarkerUserId: ev.salidaMarkerUserId ?? null,
      // El regreso se sintetizo con el horario de salida programado -- no
      // hubo ningun marcador real que lo cierre.
      regresoMarkerUserId: null
    });
  }
  return results;
}

// Caso simétrico al anterior: un regreso huérfano (marcador REGRESO sin
// salida abierta -- ver orphanReturns en detectMovements) representa una
// salida que nunca se marcó como tal, típicamente porque arrancó ANTES del
// primer fichaje del día (aviso de "entrada particular": el día anterior se
// autorizó entrar tarde, nunca hay un badge de salida ese día). Se sintetiza
// el "timeOut" como el horario de entrada programado de ese empleado ese día,
// para que la salida/duración se pueda mostrar igual que cualquier otra.
// entranceTimeByEmployeeId: Map employeeId -> Date|null (ya resuelto por el
// llamador via scheduleRepository, mismo patron que closeOpenEventsAtScheduleExit).
function openOrphanReturnsAtScheduleEntrance(orphanReturns, entranceTimeByEmployeeId) {
  return orphanReturns.map(r => ({
    employeeId: r.employeeId,
    category: r.category,
    timeOut: entranceTimeByEmployeeId.get(r.employeeId) || null,
    timeIn: r.timeIn,
    hasReturn: true,
    // La salida se sintetizo con el horario de entrada programado -- no
    // hubo ningun marcador real que la abra.
    salidaMarkerUserId: null,
    regresoMarkerUserId: r.regresoMarkerUserId ?? null
  }));
}

// Cantidad de dias de una salida a Campana: dias corridos entre la fecha de
// salida y la de regreso (ambos extremos incluidos); el dia de regreso cuenta
// completo solo si la hora de regreso es >= al horario de corte configurado.
// timeOut/timeIn: Date. cutoffTimeStr: 'HH:MM' o 'HH:MM:SS'.
function computeCampanaDias(timeOut, timeIn, cutoffTimeStr) {
  if (!timeIn) return null; // sigue abierta, todavia no hay dias definitivos

  const outDateOnly = new Date(timeOut.getFullYear(), timeOut.getMonth(), timeOut.getDate());
  const inDateOnly = new Date(timeIn.getFullYear(), timeIn.getMonth(), timeIn.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  let dias = Math.round((inDateOnly - outDateOnly) / msPerDay) + 1;

  const cutoffMinutes = timeToMinutes(cutoffTimeStr);
  const inMinutes = timeIn.getHours() * 60 + timeIn.getMinutes();
  if (inMinutes < cutoffMinutes) {
    dias -= 1;
  }

  return Math.max(dias, 0);
}

// Caso real: AVILA Natalia, legajo 9006, abril 2026 -- una llegada tarde
// (07:23) quedó marcada como "Salida Particular" de 6h29m/6h37m que nunca
// pasó. Alguien más fichó el marcador de Salida (badge 6) justo antes de
// que Natalia marcara su propia entrada de la mañana; ese marcador seguía
// "vivo" (ver maxMarkerGapMs) y detectMovements se lo atribuyó a ESE
// fichaje -- abriendo una salida fantasma desde su hora de entrada normal.
// Se cerraba recién al horario de salida programado (por eso "Marcador
// Regreso" salía vacío: no hubo un regreso real, se cerró por horario).
//
// Mismo principio que el fix análogo para HE (ver
// overtimeCalculations.resolveDailyOvertime): una Salida Particular/
// Oficial real de una persona prácticamente nunca coincide con su PRIMER
// fichaje real del día -- si de verdad se fue, ya venía trabajando desde
// antes. Si coincide, es mucho más probable que el marcador fuera de otra
// persona.
//
// NO se resuelve dentro de detectMovements (que ya tiene una batería de
// tests con casos reales confirmados, y esta función corre TAMBIÉN para
// Campaña, donde "primer fichaje del día" no es la pregunta correcta --
// una salida a Campaña dura varios días, se procesa sobre una ventana
// larga de hasta 90 días, no día por día). Se expone acá como un filtro
// aparte, que el llamador aplica SOLO donde corresponde (Particular/
// Oficial, procesado día por día en /movements-range).
//
// dayCheckins: los mismos checkins crudos (con employeeId) de ESE día que
// ya se le pasaron a detectMovements. Devuelve true si timeOut coincide
// con el primer fichaje real de ese empleado ese día.
function isFirstRealCheckinOfDay(employeeId, timeOut, dayCheckins) {
  let first = null;
  for (const c of dayCheckins || []) {
    if (c.employeeId !== employeeId) continue;
    if (!first || c.checktime < first) first = c.checktime;
  }
  return !!(first && timeOut && timeOut.getTime() === first.getTime());
}

// Aplica isFirstRealCheckinOfDay a un array de eventos (cerrados o los
// resultados ya de closeOpenEventsAtScheduleExit) -- se sacan los que
// abrieron con el primer fichaje real del día de esa persona.
function filterEventsOpenedByFirstCheckinOfDay(events, dayCheckins) {
  return (events || []).filter((e) => !isFirstRealCheckinOfDay(e.employeeId, e.timeOut, dayCheckins));
}

module.exports = {
  detectMovements,
  closeOpenEventsAtScheduleExit,
  openOrphanReturnsAtScheduleEntrance,
  computeCampanaDias,
  isFirstRealCheckinOfDay,
  filterEventsOpenedByFirstCheckinOfDay
};
