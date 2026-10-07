// ============================================================================
// Campañas de una empresa -- UNA sola fuente para todo el sistema
// ============================================================================
//
// La usan el reporte de Campaña (/campana-range), Presentismo por rango
// (/attendance-range) y el motor diario (/api/labor-engine/attendance/:date).
// Vivia dentro de horasdedica.js y solo la veian los dos primeros: la vista
// diaria de Presentismo seguia mostrando "Ausente" a quien estaba en el campo
// (OLGUIN, 23/09/2026). Se movio aca, al Motor Laboral, para que las tres
// pantallas usen exactamente la misma deteccion. Ver CAMPANA.md.
//
// Las funciones reciben `db` como primer parametro (mismo criterio que los
// repositorios del Motor Laboral): no dependen de ningun modulo global.
const movementsCalc = require('./movementsCalculations');
const { getAppSetting } = require('../repositories/appSettingsRepository');

function formatLocalDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return formatLocalDate(new Date(y, m - 1, d + 1));
}

async function fetchMovementCheckins(db, fromDate, toDateExclusive, tenantId) {
  // El join por badge (ademas de por USERID) es necesario porque no todos
  // los relojes graban Checkins.USERID igual: algunos graban el USERID
  // interno, otros graban directamente el numero de legajo/badge -- mismo
  // fallback que ya usa /attendance-range. Sin esto, los fichajes de
  // cualquier empleado cuyo reloj haga esto quedan invisibles para el motor
  // de salidas (se tratan como ruido) aunque sí se calculen bien las horas
  // normales -- caso real: PERROTTA Valentina, legajo 1011, 07/07/2026.
  //
  // Fase 19: tenant_id en cada JOIN (users/Checkins/user_employee_map ya
  // no son unicos solo por USERID, migracion 20260909) -- el filtrado
  // final por employeeById.has(...) en /movements-range ya evitaba que
  // esto se viera en la respuesta, pero un legajo coincidente entre dos
  // empresas (ej. las dos usan "1000") podia igual atribuirle mal un
  // movimiento a la empresa equivocada antes de llegar a esta version.
  //
  // RENDIMIENTO (2026-09-28): este JOIN era
  //     ON (u.USERID = c.USERID OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR))
  // El OR entre dos columnas anula los indices de `users`: por CADA fichaje
  // MySQL recorria los 499 usuarios de la empresa. Es el mismo problema que
  // ya se habia resuelto el 2026-09-21 en /attendance-range (ver ahi y
  // ESTADO_PROYECTO.md), pero esta copia habia quedado con el OR viejo.
  // Medido con los fichajes de AVP (base local, 9 meses, 78.456 filas):
  // 13.113 ms con el OR, 80 ms asi -- mismas filas, mismo empleado en cada
  // una. Un reporte de Campaña de un mes pasaba 6,4 s solo en esta consulta.
  //
  // Son dos JOIN que si usan indice: primero por USERID (clave primaria
  // tenant_id+USERID) y, SOLO si no hubo coincidencia, por Badgenumber
  // (indice unico tenant_id+Badgenumber). Es la misma prioridad explicita que
  // usa /attendance-range; con el OR, un numero que coincidia con el USERID
  // de uno y el Badgenumber de otro devolvia dos filas y el fichaje se
  // duplicaba (en AVP no pasa: 0 casos).
  const params = [fromDate, toDateExclusive];
  let query = `
    SELECT c.CHECKTIME AS checktime, c.USERID AS rawUserId, e.employee_id AS employeeId,
           c.MACHINE_IP AS machineIp
    FROM Checkins c
    LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.USERID = c.USERID
    LEFT JOIN users ub ON u.USERID IS NULL AND ub.tenant_id = c.tenant_id
      AND ub.Badgenumber = CAST(c.USERID AS CHAR)
    LEFT JOIN user_employee_map uem ON uem.tenant_id = c.tenant_id AND uem.USERID = COALESCE(u.USERID, ub.USERID)
    LEFT JOIN employees e ON e.id = uem.employee_id
    WHERE c.CHECKTIME >= ? AND c.CHECKTIME < ?`;
  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND c.tenant_id = ?`;
    params.push(tenantId);
  }
  query += ` ORDER BY c.CHECKTIME`;
  const [rows] = await db.query(query, params);
  return rows.map(r => ({
    // db.js usa dateStrings:true -- CHECKTIME llega como 'YYYY-MM-DD HH:MM:SS',
    // no como Date. El motor de detección compara/formatea fechas, así que se
    // parsea acá, en el único lugar que toca la fila cruda de la DB.
    checktime: new Date(r.checktime.replace(' ', 'T')),
    userId: r.rawUserId,
    employeeId: r.employeeId !== null ? String(r.employeeId) : null,
    // De que reloj vino: un marcador solo lo puede consumir un fichaje del
    // MISMO aparato (ver mismoReloj en movementsCalculations.js).
    machineIp: r.machineIp ?? null
  }));
}

async function fetchMarkerMap(db, category, tenantId) {
  const params = [];
  let query = `SELECT userId, category, direction, badgeNumber FROM specialusers WHERE isActive = TRUE AND direction IS NOT NULL`;
  if (category) {
    query += ` AND category = ?`;
    params.push(category);
  }
  // Fase 19: sin esto, el mapa de marcadores (badge 9/10) de OTRA empresa
  // se mezclaba con el propio -- un USERID de marcador coincidente entre
  // dos empresas hubiera abierto/cerrado eventos con el criterio equivocado.
  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND tenant_id = ?`;
    params.push(tenantId);
  }
  const [rows] = await db.query(query, params);
  const markerMap = {};
  rows.forEach(m => { markerMap[m.userId] = { category: m.category, direction: m.direction, badgeNumber: m.badgeNumber }; });

  // EL MARCADOR TAMBIEN SE RECONOCE POR SU NUMERO DE TARJETA (2026-10-07)
  // ----------------------------------------------------------------------
  // Hay relojes que en Checkins graban el NUMERO DE TARJETA y no el USERID
  // interno. Para las personas eso ya se resolvia (ver fetchMovementCheckins:
  // primero por USERID, si no por Badgenumber); para los marcadores no. Caso
  // real AVP: el marcador 10 (fin de horas extra) esta cargado con USERID 2 y
  // tarjeta 10, el reloj lo manda como 10, y el motor nunca lo reconocio
  // (1.251 lecturas solo en septiembre de 2026).
  //
  // Solo si ese numero NO es el USERID de nadie en la empresa: si una persona
  // real tiene USERID 10, sus fichajes se tomarian como marcador.
  if (tenantId !== undefined && tenantId !== null) {
    const alias = rows.filter((m) => m.badgeNumber != null && String(m.badgeNumber) !== String(m.userId)
      && /^\d+$/.test(String(m.badgeNumber)) && markerMap[m.badgeNumber] === undefined);
    if (alias.length) {
      const [ocupados] = await db.query(
        'SELECT USERID FROM users WHERE tenant_id = ? AND USERID IN (?)',
        [tenantId, alias.map((m) => Number(m.badgeNumber))]
      );
      const tomados = new Set(ocupados.map((u) => String(u.USERID)));
      alias.forEach((m) => {
        if (!tomados.has(String(m.badgeNumber))) {
          markerMap[m.badgeNumber] = { category: m.category, direction: m.direction, badgeNumber: m.badgeNumber };
        }
      });
    }
  }
  return markerMap;
}

// Ventana de lectura repetida: dos lecturas de la MISMA persona dentro de
// estos segundos (sin un marcador nuevo en el medio) son una sola accion.
// Configurable por empresa en Marcadores; 20 s por defecto. Ver "Rebote
// refinado" en movementsCalculations.js y MARCADORES_Y_SALIDAS.md.
const VENTANA_REBOTE_DEFAULT_S = 20;
async function fetchVentanaReboteMs(db, tenantId) {
  const value = await getAppSetting('markerBounceSeconds', tenantId, db);
  const seconds = value ? Number(value) : VENTANA_REBOTE_DEFAULT_S;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : VENTANA_REBOTE_DEFAULT_S) * 1000;
}

async function fetchMarkerMaxGapMs(db, tenantId) {
  const value = await getAppSetting('markerMaxGapSeconds', tenantId, db);
  const seconds = value ? Number(value) : 30;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
}

// Correcciones manuales de marcadores ("este marcador era de X" / "no era de
// nadie") en [fromDate, toDateExclusive), listas para detectMovements
// (opcion correccionesMarcadores). Ver migracion 20261003 y el comentario
// "Correcciones manuales" en movementsCalculations.js.
//
// Se leen para TODAS las detecciones (HE, Particular, Oficial, Campaña): la
// correccion es un hecho sobre el marcador, no sobre un reporte. Si se
// corrigiera solo en un reporte, la misma hora extra diria una cosa en
// Salidas y otra en Presentismo.
async function fetchCorreccionesMarcadores(db, fromDate, toDateExclusive, tenantId) {
  const correcciones = new Map();
  if (tenantId === undefined || tenantId === null) return correcciones;
  // Si la migracion 20261003 todavia no se corrio (por ejemplo, el backend
  // se publico antes que la migracion), no hay correcciones: se sigue como
  // siempre en vez de romper Salidas y Presentismo por una tabla que falta.
  const [rows] = await db.query(
    `SELECT mc.id, mc.marker_user_id, mc.marker_time, mc.assigned_employee_id, mc.reason,
            COALESCE(mc.updated_at, mc.created_at) AS corrected_at,
            au.email AS corrected_by
     FROM marker_corrections mc
     LEFT JOIN app_users au ON au.id = COALESCE(mc.updated_by, mc.created_by)
     WHERE mc.tenant_id = ? AND mc.marker_time >= ? AND mc.marker_time < ?`,
    [tenantId, fromDate, toDateExclusive]
  ).catch((err) => {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return [[]];
    throw err;
  });
  for (const r of rows) {
    // El motor solo mira employeeId; el resto es para mostrar en pantalla
    // quien corrigio, cuando y por que.
    correcciones.set(`${r.marker_user_id}|${r.marker_time}`, {
      employeeId: r.assigned_employee_id != null ? String(r.assigned_employee_id) : null,
      id: r.id,
      reason: r.reason,
      correctedAt: r.corrected_at,
      correctedBy: r.corrected_by ?? null,
    });
  }
  return correcciones;
}

// "Solo detectar campañas de empleados afectados" (Salidas > Campaña). Por
// empresa, apagado por default: una empresa que no marco a nadie no ve
// ningun cambio.
async function fetchCampanaSoloAfectados(db, tenantId) {
  return (await getAppSetting('campanaSoloAfectados', tenantId, db)) === '1';
}

// Legajos con la tilde "Afectado a campaña / viajes", o null si la empresa
// no activo el ajuste (null = cualquiera puede llevarse un marcador, como
// siempre). Si la columna todavia no existe (backend publicado antes que la
// migracion 20261004), tambien null: se sigue como siempre.
async function legajosAfectadosACampana(db, tenantId) {
  if (tenantId === undefined || tenantId === null) return null;
  if (!(await fetchCampanaSoloAfectados(db, tenantId))) return null;
  const [rows] = await db.query(
    'SELECT employee_id FROM employees WHERE tenant_id = ? AND afectado_campana = 1',
    [tenantId]
  ).catch((err) => {
    if (err && err.code === 'ER_BAD_FIELD_ERROR') return [null];
    throw err;
  });
  return rows ? new Set(rows.map(r => String(r.employee_id))) : null;
}

// Lo que necesita una pantalla para mostrar (y corregir) los marcadores de un
// evento: el USERID y la hora exacta de cada marcador -- que es como se
// identifica al pedir una correccion -- y, si ya fue corregido, quien, cuando
// y por que. Devuelve campos planos para sumar a la fila del reporte.
function datosDeMarcadores(ev, correcciones) {
  const uno = (userId, at) => {
    if (userId == null || !at) return { userId: null, at: null, correccion: null };
    const clave = movementsCalc.claveMarcador(userId, at);
    const c = correcciones ? correcciones.get(clave) : undefined;
    return {
      userId,
      at: movementsCalc.fechaHoraLocal(at),
      correccion: c ? { id: c.id, reason: c.reason, correctedAt: c.correctedAt, correctedBy: c.correctedBy } : null,
    };
  };
  const salida = uno(ev.salidaMarkerUserId, ev.salidaMarkerAt);
  const regreso = uno(ev.regresoMarkerUserId, ev.regresoMarkerAt);
  return {
    salidaMarkerUserId: salida.userId,
    salidaMarkerAt: salida.at,
    salidaCorreccion: salida.correccion,
    regresoMarkerUserId: regreso.userId,
    regresoMarkerAt: regreso.at,
    regresoCorreccion: regreso.correccion,
  };
}

// Devuelve las campañas que TOCAN el rango: las cerradas cuyo regreso cae en
// o despues de `from`, y las que siguen abiertas. Una empresa sin marcadores
// CAMPANA sale en la primera consulta sin tocar Checkins -- si no usa
// campañas, esto no le cuesta nada.
//
// Usa `reboteRefinado` (ver movementsCalculations.js): sin eso se perdian 79
// de 582 salidas a campaña reales en AVP.
const CAMPANA_LOOKBACK_DAYS = 90;
// opciones.ignorarAfectados: detecta como si el ajuste "solo afectados"
// estuviera apagado. Lo usa la sugerencia de a quien marcar (si no, seria
// circular: nadie marcado -> ninguna campaña -> nadie para sugerir).
async function detectarCampanas(db, tenantId, from, to, opciones = {}) {
  const markerMap = await fetchMarkerMap(db, 'CAMPANA', tenantId);
  if (Object.keys(markerMap).length === 0) return [];

  // Una salida a campaña puede haber arrancado antes del "from" pedido --
  // se busca hasta CAMPANA_LOOKBACK_DAYS atrás para no perder el
  // emparejamiento con su regreso, que sí puede caer dentro del rango.
  const [fy, fm, fd] = from.split('-').map(Number);
  const lookbackFromStr = formatLocalDate(new Date(fy, fm - 1, fd - CAMPANA_LOOKBACK_DAYS));
  const checkins = await fetchMovementCheckins(db, lookbackFromStr, nextDayStr(to), tenantId);
  const maxMarkerGapMs = await fetchMarkerMaxGapMs(db, tenantId);
  const todosLosMarcadores = await fetchMarkerMap(db, null, tenantId);
  const correccionesMarcadores = await fetchCorreccionesMarcadores(db, lookbackFromStr, nextDayStr(to), tenantId);
  const soloPuedenConsumir = opciones.ignorarAfectados ? null : await legajosAfectadosACampana(db, tenantId);
  const { closedEvents, openEvents } = movementsCalc.detectMovements(checkins, markerMap, {
    maxMarkerGapMs, todosLosMarcadores, reboteRefinado: true, correccionesMarcadores, soloPuedenConsumir,
    ownCheckinBounceMs: await fetchVentanaReboteMs(db, tenantId),
  });

  const fromDate = new Date(fy, fm - 1, fd);
  const conMarcadores = (e) => ({ ...e, ...datosDeMarcadores(e, correccionesMarcadores) });
  return [
    ...closedEvents.filter(e => e.timeIn >= fromDate).map(e => ({ ...e, hasReturn: true })),
    ...Array.from(openEvents.entries()).map(([employeeId, ev]) => ({
      employeeId, category: ev.category, timeOut: ev.timeOut, timeIn: null, hasReturn: false,
      salidaMarkerUserId: ev.salidaMarkerUserId ?? null, salidaMarkerAt: ev.salidaMarkerAt ?? null,
      salidaCorregida: ev.salidaCorregida === true,
      regresoMarkerUserId: null, regresoMarkerAt: null, regresoCorregido: false,
    })),
  ].filter(e => e.category === 'CAMPANA').map(conMarcadores);
}

// Como cuenta Presentismo los dias habiles en campaña sin fichar -- ver
// /config/campana-presentismo-modo en horasdedica.js. 'ignorar' es el
// default: una empresa que no decidio no ve ningun cambio.
const CAMPANA_PRESENTISMO_MODOS = ['ignorar', 'trabajado', 'excusado'];
async function fetchCampanaPresentismoModo(db, tenantId) {
  const value = await getAppSetting('campanaPresentismoModo', tenantId, db);
  return CAMPANA_PRESENTISMO_MODOS.includes(value) ? value : 'ignorar';
}

// Hora de corte del dia de regreso (Salidas > Campaña). La misma para la
// columna "Dias" del reporte y para Presentismo.
async function fetchCampanaCutoff(db, tenantId) {
  const value = await getAppSetting('campanaArrivalCutoffTime', tenantId, db);
  return value || '09:00';
}

// Que dias de [from, to] le toca interpretar a Presentismo, para cada
// empleado. Devuelve null si no hay nada que interpretar -- modo 'ignorar', o
// vista cruzada de superadmin (tenantId null: no hay UNA configuracion de
// empresa que aplicar). En ese caso no se hace ninguna consulta de fichajes.
//
//   interiores: `${legajo}|${fecha}` -- los dias entre la salida y el regreso
//               (diasInterioresDeCampana: sin los extremos).
//   regresos:   `${legajo}|${fecha}` -- dias de regreso que cuentan como
//               campaña porque volvio a la hora de corte o despues
//               (regresoCuentaComoCampana). Si volvio antes, no esta aca y el
//               dia se evalua normal.
async function diasDeCampana(db, tenantId, from, to) {
  if (tenantId == null) return null;
  const modo = await fetchCampanaPresentismoModo(db, tenantId);
  if (modo === 'ignorar') return null;
  const cutoff = await fetchCampanaCutoff(db, tenantId);
  const interiores = new Set();
  const regresos = new Set();
  for (const ev of await detectarCampanas(db, tenantId, from, to)) {
    movementsCalc.diasInterioresDeCampana(ev.timeOut, ev.timeIn, from, to)
      .forEach(d => interiores.add(`${ev.employeeId}|${d}`));
    if (movementsCalc.regresoCuentaComoCampana(ev.timeIn, cutoff)) {
      const d = formatLocalDate(ev.timeIn);
      if (d >= from && d <= to) regresos.add(`${ev.employeeId}|${d}`);
    }
  }
  return { modo, cutoff, interiores, regresos };
}

// Para el motor diario: lo mismo que diasDeCampana, para un solo dia y por
// legajo. null = nada que interpretar.
async function empleadosEnCampanaElDia(db, tenantId, date) {
  const dias = await diasDeCampana(db, tenantId, date, date);
  if (!dias) return null;
  const legajos = (set) => new Set([...set].map(k => k.split('|')[0]));
  return { modo: dias.modo, empleados: legajos(dias.interiores), regresos: legajos(dias.regresos) };
}

module.exports = {
  fetchMovementCheckins,
  fetchMarkerMap,
  fetchMarkerMaxGapMs,
  fetchVentanaReboteMs,
  fetchCorreccionesMarcadores,
  fetchCampanaSoloAfectados,
  legajosAfectadosACampana,
  datosDeMarcadores,
  detectarCampanas,
  fetchCampanaPresentismoModo,
  fetchCampanaCutoff,
  diasDeCampana,
  empleadosEnCampanaElDia,
  CAMPANA_PRESENTISMO_MODOS,
};
