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
// Rebote refinado (opcion `reboteRefinado`, apagada por defecto)
// ============================================================================
//
// POR QUE
// -------
// La regla de rebote de arriba trata cualquier segunda lectura de la misma
// persona dentro de 20 s como "la misma accion", sin mirar que paso en el
// medio. Medido en produccion (AVP, enero-septiembre 2026): de 582 salidas a
// Campaña, 79 se perdian por esa regla, en dos formas:
//
//   A) marcador -> lectura 1 -> lectura 2 (3 s despues)
//      La lectura 1 abre la campaña y la lectura 2, que es el rebote del
//      lector, la CIERRA en el acto: quedaba una "campaña" de 3 segundos.
//      Caso real: legajo 9448, 05/01/2026 07:05:31 / :34 / :37.
//
//   B) lectura 1 -> marcador -> lectura 2 (OLGUIN, legajo 2555)
//      07:58:13 ficha, 07:58:19 aprieta el 8, 07:58:22 vuelve a fichar. La
//      lectura 2 se tomaba como rebote y NO consumia el marcador: la campaña
//      nunca se abria.
//
// En los 79 casos la persona tardo DIAS en volver a fichar (58 a 800 horas),
// o sea que las campañas eran reales.
//
// EL PRINCIPIO
// ------------
// Dos lecturas de la misma persona dentro de la ventana de rebote son UNA
// accion, salvo que entre las dos se haya apretado un marcador y ese
// marcador este al menos tan cerca de la segunda lectura como de la primera.
// Eso es una accion nueva y deliberada: apretar el marcador y poner el dedo.
//
//   - Forma A: la lectura 2 no tiene marcador en el medio -> es rebote, y un
//     rebote NO cierra lo que la lectura 1 acaba de abrir.
//   - Forma B: el marcador esta a 6 s de la lectura 1 y a 3 s de la 2 -> es
//     de la lectura 2, que lo consume.
//
// El caso SANTIBAÑEZ (18/08/2026) sigue protegido: 13:37:29 ficha, 13:37:34
// marcador 8, 13:37:41 ficha. El marcador esta a 5 s de la primera y a 7 s
// de la segunda -> mas cerca de la primera -> la segunda sigue siendo rebote.
// (Con la ventana de 6 s de AVP, ademas, el marcador ya habria vencido.)
//
// En los 50 casos visibles del diagnostico, marcador -> lectura 2 fue de 3 a
// 6 s y siempre <= lectura 1 -> marcador. Ver DIAGNOSTICO_CAMPANA_REBOTE_DETALLE.sql.
//
// POR QUE ES UNA OPCION Y NO EL COMPORTAMIENTO DE SIEMPRE
// -------------------------------------------------------
// El mismo motor calcula horas extra y salidas particulares. Aplicarlo ahi
// cambiaria numeros de liquidacion ya calculados, y eso se decide midiendo
// primero, no de rebote. Hoy solo lo pide la deteccion de Campaña.
function marcadorEsDeEstaLectura(marcador, lecturaAnterior, ahora) {
  if (!marcador || lecturaAnterior == null) return false;
  if (marcador.markedAt <= lecturaAnterior) return false;
  return (ahora - marcador.markedAt) <= (marcador.markedAt - lecturaAnterior);
}

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

// ============================================================================
// Correcciones manuales: "este marcador era de otra persona"
// ============================================================================
//
// POR QUE
// -------
// Todo lo de arriba es una ADIVINANZA razonable: el marcador se le da al
// proximo fichaje real del mismo reloj. Cuando se equivoca (se metio otra
// persona en el medio), alguien que estuvo ahi puede decir de quien era de
// verdad. Esa palabra vale mas que cualquier regla, asi que un marcador
// corregido NO pasa por la adivinanza. Tabla `marker_corrections`, migracion
// 20261003.
//
// COMO SE APLICA
// --------------
// - "No era de nadie" (employeeId null): el marcador se ignora, como si no se
//   hubiera apretado. No pisa al marcador pendiente de ese reloj.
// - "Era de X": el marcador queda RESERVADO para X. Lo consume el proximo
//   fichaje real de X (de cualquier reloj: lo dijo una persona, no hace
//   falta inferirlo) dentro de VENTANA_MARCADOR_CORREGIDO_MS. Nadie mas
//   puede llevarselo, y tampoco toca la cola del reloj: el marcador pendiente
//   de otra persona sigue esperando a quien corresponde.
// - Un marcador corregido es siempre una accion nueva: no le aplica la regla
//   de rebote (alguien confirmo que X apreto el marcador y puso el dedo).
//
// La ventana es mucho mas larga que la de la adivinanza (6 s en AVP) porque
// el caso tipico es justamente que X puso el dedo tarde, despues de otro.
// Si X no ficho dentro de esos minutos, la correccion no tiene a que
// aplicarse: el endpoint lo rechaza al cargarla (POST /marker-corrections).
const VENTANA_MARCADOR_CORREGIDO_MS = 10 * 60 * 1000;

// 'YYYY-MM-DD HH:MM:SS' en hora local: el mismo formato en que la base
// devuelve CHECKTIME y marker_time (db.js usa dateStrings:true). Comparar por
// texto evita cualquier problema de zona horaria entre la base y Node.
function fechaHoraLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

// Clave de un fichaje de marcador en el mapa de correcciones.
function claveMarcador(userId, checktime) {
  return `${userId}|${fechaHoraLocal(checktime)}`;
}

function detectMovements(checkins, markerMap, options = {}) {
  const maxMarkerGapMs = options.maxMarkerGapMs ?? DEFAULT_MAX_MARKER_GAP_MS;
  // Map claveMarcador -> { employeeId: string|null }. Ver "Correcciones
  // manuales" arriba. Si no se pasa, el comportamiento es el de antes.
  const correcciones = options.correccionesMarcadores ?? null;
  const reservadosPorEmpleado = new Map(); // employeeId -> marcador corregido
  const ownCheckinBounceMs = options.ownCheckinBounceMs ?? DEFAULT_OWN_CHECKIN_BOUNCE_MS;
  const reboteRefinado = options.reboteRefinado === true;
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

    // Marcador corregido a mano: no entra en la cola del reloj.
    const correccion = correcciones && !row.employeeId
      ? correcciones.get(claveMarcador(row.userId, row.checktime))
      : undefined;
    if (correccion !== undefined) {
      if (marker && correccion.employeeId != null) {
        reservadosPorEmpleado.set(String(correccion.employeeId), {
          category: marker.category, direction: marker.direction,
          markedAt: row.checktime, userId: row.userId, corregido: true,
        });
      }
      continue;
    }

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
    //
    // Un marcador que una persona le asigno a este empleado gana sobre el del
    // reloj, y en ese caso la cola del reloj no se toca (pendiente = null).
    let reservado = reservadosPorEmpleado.get(row.employeeId) || null;
    if (reservado && (row.checktime - reservado.markedAt) > VENTANA_MARCADOR_CORREGIDO_MS) {
      reservadosPorEmpleado.delete(row.employeeId);
      reservado = null;
    }
    if (reservado) reservadosPorEmpleado.delete(row.employeeId);
    const pendiente = reservado ? null : marcadorDelReloj(marcadoresPorReloj, row.machineIp ?? null);
    const marcadorAplicable = reservado || (pendiente ? pendiente.marcador : null);

    const previousOwnCheckin = lastRealCheckinByEmployeeId.get(row.employeeId);
    const isOwnBounce = previousOwnCheckin != null && (row.checktime - previousOwnCheckin) <= ownCheckinBounceMs;
    const marcadorNuevoEnElMedio = reservado != null
      || (reboteRefinado && marcadorEsDeEstaLectura(marcadorAplicable, previousOwnCheckin, row.checktime));

    const open = openEvents.get(row.employeeId);
    if (open && reboteRefinado && isOwnBounce && !marcadorNuevoEnElMedio) {
      // Forma A (ver "Rebote refinado"): el rebote de la lectura que acaba
      // de abrir la salida no es un regreso.
      lastRealCheckinByEmployeeId.set(row.employeeId, row.checktime);
      continue;
    }
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
        salidaMarkerAt: open.salidaMarkerAt ?? null,
        salidaCorregida: open.salidaCorregida === true,
        regresoMarkerUserId: marcadorAplicable ? marcadorAplicable.userId : null,
        regresoMarkerAt: marcadorAplicable ? marcadorAplicable.markedAt : null,
        regresoCorregido: marcadorAplicable ? marcadorAplicable.corregido === true : false
      });
      openEvents.delete(row.employeeId);
      // Solo se consume el marcador de ESTE reloj: los de los otros siguen
      // esperando a quien los apretó.
      if (pendiente) marcadoresPorReloj.delete(pendiente.clave);
      lastRealCheckinByEmployeeId.set(row.employeeId, row.checktime);
      continue;
    }

    lastRealCheckinByEmployeeId.set(row.employeeId, row.checktime);

    if (isOwnBounce && !marcadorNuevoEnElMedio) {
      // No consume el marcador activo -- si en el medio fichó otra
      // persona (el caso real), el marcador le sigue llegando a ella en
      // vez de a este rebote. Con reboteRefinado, un marcador apretado
      // entre las dos lecturas y mas cerca de esta SI es suyo (forma B).
      continue;
    }

    if (marcadorAplicable && marcadorAplicable.direction === 'SALIDA') {
      openEvents.set(row.employeeId, {
        category: marcadorAplicable.category,
        timeOut: row.checktime,
        salidaMarkerUserId: marcadorAplicable.userId,
        salidaMarkerAt: marcadorAplicable.markedAt,
        salidaCorregida: marcadorAplicable.corregido === true
      });
    } else if (marcadorAplicable && marcadorAplicable.direction === 'REGRESO') {
      orphanReturns.push({
        employeeId: row.employeeId,
        category: marcadorAplicable.category,
        timeIn: row.checktime,
        regresoMarkerUserId: marcadorAplicable.userId,
        regresoMarkerAt: marcadorAplicable.markedAt,
        regresoCorregido: marcadorAplicable.corregido === true
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
      salidaMarkerAt: ev.salidaMarkerAt ?? null,
      salidaCorregida: ev.salidaCorregida === true,
      // El regreso se sintetizo con el horario de salida programado -- no
      // hubo ningun marcador real que lo cierre.
      regresoMarkerUserId: null,
      regresoMarkerAt: null,
      regresoCorregido: false
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
      salidaMarkerAt: null,
      salidaCorregida: false,
      regresoMarkerUserId: r.regresoMarkerUserId ?? null,
      regresoMarkerAt: r.regresoMarkerAt ?? null,
      regresoCorregido: r.regresoCorregido === true
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

// ¿El dia de regreso cuenta como dia de campaña? Misma regla que ya usa
// computeCampanaDias para la columna "Dias" del reporte, asi el reporte y
// Presentismo no pueden contar distinto: si vuelve a la hora de corte o
// despues, ese dia lo paso viajando/en el campo; si vuelve antes, llego a
// tiempo para trabajar y el dia se evalua normal (su fichaje de regreso es
// su entrada). La hora de corte la configura cada empresa
// (campanaArrivalCutoffTime, default 09:00).
function regresoCuentaComoCampana(timeIn, cutoffTimeStr) {
  if (!timeIn) return false;
  return timeIn.getHours() * 60 + timeIn.getMinutes() >= timeToMinutes(cutoffTimeStr);
}

// Dias "de adentro" de una campaña, los que Presentismo tiene que
// interpretar: los que caen ESTRICTAMENTE entre el dia de salida y el de
// regreso. Los dos extremos quedan afuera a proposito: esos dias la persona
// ficho, asi que ya cuentan por sus fichajes y sumarlos aca los contaria dos
// veces. Una campaña abierta (timeIn null) llega hasta `hasta` -- no se
// inventa ninguna fecha de regreso.
//
// Devuelve fechas 'YYYY-MM-DD' (hora local), recortadas a [desde, hasta].
// Que un dia sea habil, sabado o feriado NO se decide aca: eso lo sigue
// decidiendo la plantilla del empleado en /attendance-range.
function diasInterioresDeCampana(timeOut, timeIn, desde, hasta) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dias = [];
  const d = new Date(timeOut.getFullYear(), timeOut.getMonth(), timeOut.getDate() + 1);
  const ultimoExclusivo = timeIn ? fmt(timeIn) : null;
  for (; ; d.setDate(d.getDate() + 1)) {
    const s = fmt(d);
    if (s > hasta) break;
    if (ultimoExclusivo !== null && s >= ultimoExclusivo) break;
    if (s >= desde) dias.push(s);
  }
  return dias;
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
//
// Una salida cuyo marcador fue corregido a mano NO se filtra: la regla de
// arriba es una sospecha ("probablemente el marcador era de otro"), y una
// persona ya confirmo de quien era.
function filterEventsOpenedByFirstCheckinOfDay(events, dayCheckins) {
  return (events || []).filter((e) => e.salidaCorregida === true || !isFirstRealCheckinOfDay(e.employeeId, e.timeOut, dayCheckins));
}

module.exports = {
  detectMovements,
  closeOpenEventsAtScheduleExit,
  openOrphanReturnsAtScheduleEntrance,
  computeCampanaDias,
  diasInterioresDeCampana,
  regresoCuentaComoCampana,
  isFirstRealCheckinOfDay,
  filterEventsOpenedByFirstCheckinOfDay,
  claveMarcador,
  fechaHoraLocal,
  VENTANA_MARCADOR_CORREGIDO_MS
};
