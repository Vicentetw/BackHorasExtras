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

// ============================================================================
// Un marcador solo lo puede consumir un fichaje del MISMO reloj
// ============================================================================
//
// POR QUE
// -------
// El marcador no dice de quien es: nadie se identifica al apretarlo. El
// sistema se lo atribuye al proximo fichaje real que llegue. Con un solo
// reloj eso es razonable -- la persona aprieta el marcador y despues pone el
// dedo, en el mismo aparato, con un segundo de diferencia.
//
// Con DOS relojes deja de serlo. Si alguien aprieta el marcador 9 (inicio de
// hora extra) en un aparato y otra persona pone el dedo en el OTRO un segundo
// despues, el sistema le daba la hora extra a la segunda.
//
// No es hipotetico. Medido sobre los 111.529 fichajes de produccion con reloj
// identificado: de 24.664 fichajes de marcador, 20.369 tuvieron a alguien
// fichando dentro de la ventana de 6 segundos, y **272 de esos venian del
// OTRO reloj**. Casi todos con el marcador 9. Ejemplo real:
//
//     2026-06-04 13:51:14  marcador 9 en .33  ->  usuario 9995 en .30 (1s)
//
// Si los dos aparatos estan en lugares distintos, la persona que apreto el
// marcador NO puede ser la que ficho un segundo despues en el otro.
//
// Confirmado con quien opera el sistema: "si yo ingreso a la hora extra voy a
// fichar el usuario ficticio y poner el dedo o mi clave en el mismo reloj
// siempre; seria tonto hacerlo en diferentes relojes y con segundos de
// diferencia".
//
// EL CASO DEL RELOJ DESCONOCIDO
// ------------------------------
// 46.203 fichajes viejos se guardaron sin MACHINE_IP (son anteriores a que el
// agente lo anotara). Si de un lado no se sabe el reloj, NO se puede afirmar
// que sean distintos -- se deja pasar, igual que antes. La regla solo rechaza
// cuando los dos relojes se conocen Y son distintos: agregar informacion no
// puede cambiar el resultado de lo que ya estaba calculado.
// UN MARCADOR PENDIENTE POR RELOJ, NO UNO SOLO PARA TODOS
// -------------------------------------------------------
// No alcanza con rechazar el cruce: `lastMarker` era un unico casillero, asi
// que dos marcadores apretados a la vez en dos aparatos se pisaban y solo
// sobrevivia el ultimo. Eso pasa todos los dias a la salida del turno --
// varias personas marcando hora extra al mismo tiempo, cada una en su reloj--
// y uno de los dos se quedaba sin su hora extra.
//
// Cada aparato es una cola independiente, que es lo que fisicamente son.
// CLAVE_SIN_RELOJ agrupa los fichajes viejos que no tienen MACHINE_IP (46.203
// en produccion): se comportan como un unico "reloj desconocido", igual que
// antes de este cambio.
const CLAVE_SIN_RELOJ = '__sin_reloj__';

function claveReloj(machineIp) {
  return machineIp == null ? CLAVE_SIN_RELOJ : String(machineIp);
}

// Que marcador pendiente le corresponde a un fichaje de este reloj. Si de
// algun lado no se sabe el aparato no se puede afirmar que sean distintos, y
// se cae al comportamiento de siempre: agregar informacion no puede cambiar
// lo que ya estaba calculado.
function marcadorDelReloj(marcadoresPorReloj, machineIp) {
  const clave = claveReloj(machineIp);
  if (marcadoresPorReloj.has(clave)) return { clave, marcador: marcadoresPorReloj.get(clave) };
  // Fichaje sin reloj conocido: le sirve cualquiera. Y un fichaje con reloj
  // conocido puede consumir un marcador sin reloj conocido, por lo mismo.
  if (clave === CLAVE_SIN_RELOJ) {
    const primera = marcadoresPorReloj.keys().next();
    if (!primera.done) return { clave: primera.value, marcador: marcadoresPorReloj.get(primera.value) };
  } else if (marcadoresPorReloj.has(CLAVE_SIN_RELOJ)) {
    return { clave: CLAVE_SIN_RELOJ, marcador: marcadoresPorReloj.get(CLAVE_SIN_RELOJ) };
  }
  return null;
}

function detectMovements(checkins, markerMap, options = {}) {
  const maxMarkerGapMs = options.maxMarkerGapMs ?? DEFAULT_MAX_MARKER_GAP_MS;
  const ownCheckinBounceMs = options.ownCheckinBounceMs ?? DEFAULT_OWN_CHECKIN_BOUNCE_MS;
  // TODOS los marcadores de la empresa, no solo los de la categoria que se
  // esta detectando en esta pasada. Hace falta para que "gana el ultimo"
  // funcione entre categorias distintas -- ver el comentario en el loop.
  // Si no se pasa, el comportamiento es el de antes.
  const todosLosMarcadores = options.todosLosMarcadores ?? null;
  const sorted = checkins.slice().sort((a, b) => a.checktime - b.checktime);
  // Un marcador pendiente POR RELOJ (ver claveReloj/marcadorDelReloj arriba).
  const marcadoresPorReloj = new Map(); // claveReloj -> { category, direction, markedAt, userId }
  const openEvents = new Map();
  const closedEvents = [];
  const orphanReturns = [];
  const lastRealCheckinByEmployeeId = new Map();

  for (const row of sorted) {
    const marker = markerMap[row.userId];
    if (marker) {
      // Dos marcadores seguidos: gana el ULTIMO. El .set() pisa al anterior.
      // Caso real: alguien aprieta el 5 (regreso de salida particular) y se
      // da cuenta de que era el 9 (inicio de hora extra), asi que aprieta el
      // 9 tres segundos despues. Vale el 9.
      marcadoresPorReloj.set(claveReloj(row.machineIp), {
        category: marker.category, direction: marker.direction,
        markedAt: row.checktime, userId: row.userId,
      });
      continue;
    }

    // ¿Es un marcador de OTRA categoria? Esto importa mas de lo que parece.
    //
    // Los llamadores filtran markerMap por categoria: /attendance-range corre
    // esta funcion una vez con solo los marcadores PARTICULAR y otra vez con
    // solo los de HE. En la pasada de PARTICULAR, el marcador 9 (HE) no
    // estaba en el mapa y caia como "ruido del reloj" mas abajo, que NO toca
    // los marcadores pendientes.
    //
    // Resultado del caso real de arriba: en la pasada de PARTICULAR, el 5
    // quedaba vivo, el 9 pasaba invisible, y el fichaje de la persona se
    // llevaba el 5 -- justo lo que habia querido corregir.
    //
    // Un marcador de otra categoria tiene que PISAR al pendiente igual que
    // uno de la misma: la regla es "gana el ultimo", no "gana el ultimo de
    // esta categoria". Para esta pasada eso significa quedarse sin marcador.
    if (todosLosMarcadores && todosLosMarcadores[row.userId]) {
      marcadoresPorReloj.delete(claveReloj(row.machineIp));
      continue;
    }

    if (!row.employeeId) {
      // Ruido del reloj: USERID que no resuelve a ningun empleado ni marcador.
      // No se toca ningun marcador -- siguen "vivos" hasta el proximo fichaje
      // real de su aparato (o hasta vencer, ver maxMarkerGapMs).
      continue;
    }

    // Vencer los marcadores viejos, de todos los relojes.
    for (const [clave, m] of marcadoresPorReloj) {
      if ((row.checktime - m.markedAt) > maxMarkerGapMs) marcadoresPorReloj.delete(clave);
    }

    // El marcador pendiente DE ESTE RELOJ, si hay alguno. Los de los otros
    // aparatos quedan intactos, esperando al fichaje que sí les corresponde.
    //
    // Una version anterior de este arreglo MATABA el marcador al ver un
    // fichaje de otro reloj, y estaba mal. Lo mostraron los datos: en 276 de
    // los 277 casos cruzados de produccion, quien ficho nunca en su vida uso
    // el reloj del marcador (ej.: marcador en .33 y el que ficho tiene 241
    // fichajes en .30 y CERO en .33). O sea que el marcador SI era de
    // alguien: de alguien parado frente al otro aparato, cuyo fichaje llega
    // un instante despues. Matarlo le quitaba la hora extra tambien a esa
    // persona, que no hizo nada mal.
    //
    // Y tampoco se puede cortar el procesamiento de la fila aca: este fichaje
    // puede estar CERRANDO una salida que el propio empleado tenia abierta, y
    // eso no tiene nada que ver con el marcador pendiente de otro aparato.
    const pendiente = marcadorDelReloj(marcadoresPorReloj, row.machineIp ?? null);
    const marcadorAplicable = pendiente ? pendiente.marcador : null;

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
        regresoMarkerUserId: marcadorAplicable ? marcadorAplicable.userId : null
      });
      openEvents.delete(row.employeeId);
      // Solo se consume el marcador de ESTE reloj: los de los otros siguen
      // esperando a quien los apretó.
      if (pendiente) marcadoresPorReloj.delete(pendiente.clave);
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

    if (marcadorAplicable && marcadorAplicable.direction === 'SALIDA') {
      openEvents.set(row.employeeId, {
        category: marcadorAplicable.category,
        timeOut: row.checktime,
        salidaMarkerUserId: marcadorAplicable.userId
      });
    } else if (marcadorAplicable && marcadorAplicable.direction === 'REGRESO') {
      orphanReturns.push({
        employeeId: row.employeeId,
        category: marcadorAplicable.category,
        timeIn: row.checktime,
        regresoMarkerUserId: marcadorAplicable.userId
      });
    }
    // Se consume SOLO el de este reloj. Si no habia ninguno para este
    // aparato, los de los otros quedan intactos.
    if (pendiente) marcadoresPorReloj.delete(pendiente.clave);
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
    const exitRaw = exitTimeByEmployeeId.get(employeeId) || null;
    // Mismo bug que openOrphanReturnsAtScheduleEntrance, del otro lado: si
    // la salida REAL ocurrio tarde (ej. cerca de medianoche), el horario
    // de salida programado (usado para "cerrar" el evento) puede caer
    // ANTES de esa salida real -- una duracion negativa que no tiene
    // sentido. El frontend ya muestra "Sin regreso" para hasReturn=false
    // sin importar este valor, pero "Duracion" SI se calcula con el; se
    // descarta en vez de mostrar un numero negativo.
    const exit = (exitRaw && exitRaw.getTime() > ev.timeOut.getTime()) ? exitRaw : null;
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
  return orphanReturns.map(r => {
    const entrance = entranceTimeByEmployeeId.get(r.employeeId) || null;
    // Bug real (VERA Tedy Oscar, legajo 9394, 01/04/2026): el regreso real
    // (ej. 00:04, recien pasada la medianoche) puede caer ANTES del
    // horario de entrada programado que se usa para "inventar" la salida
    // -- sintetizarla igual daba una salida DESPUES del regreso (duracion
    // negativa, "-7h -56m"). Si el horario de entrada no es anterior al
    // regreso real, no tiene sentido usarlo: se deja sin salida (se
    // muestra "-" en vez de un numero negativo sin sentido) en lugar de
    // inventar un dato que contradice al fichaje real.
    const timeOut = (entrance && entrance.getTime() < r.timeIn.getTime()) ? entrance : null;
    return {
      employeeId: r.employeeId,
      category: r.category,
      timeOut,
      timeIn: r.timeIn,
      hasReturn: true,
      // La salida se sintetizo con el horario de entrada programado -- no
      // hubo ningun marcador real que la abra.
      salidaMarkerUserId: null,
      regresoMarkerUserId: r.regresoMarkerUserId ?? null
    };
  });
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
