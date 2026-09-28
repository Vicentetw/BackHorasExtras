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
  const params = [fromDate, toDateExclusive];
  let query = `
    SELECT c.CHECKTIME AS checktime, c.USERID AS rawUserId, e.employee_id AS employeeId,
           c.MACHINE_IP AS machineIp
    FROM Checkins c
    LEFT JOIN users u
      ON (u.USERID = c.USERID OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR))
      AND u.tenant_id = c.tenant_id
    LEFT JOIN user_employee_map uem ON uem.USERID = u.USERID AND uem.tenant_id = u.tenant_id
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
  return markerMap;
}

async function fetchMarkerMaxGapMs(db, tenantId) {
  const value = await getAppSetting('markerMaxGapSeconds', tenantId, db);
  const seconds = value ? Number(value) : 30;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
}

// Devuelve las campañas que TOCAN el rango: las cerradas cuyo regreso cae en
// o despues de `from`, y las que siguen abiertas. Una empresa sin marcadores
// CAMPANA sale en la primera consulta sin tocar Checkins -- si no usa
// campañas, esto no le cuesta nada.
//
// Usa `reboteRefinado` (ver movementsCalculations.js): sin eso se perdian 79
// de 582 salidas a campaña reales en AVP.
const CAMPANA_LOOKBACK_DAYS = 90;
async function detectarCampanas(db, tenantId, from, to) {
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
  const { closedEvents, openEvents } = movementsCalc.detectMovements(checkins, markerMap, {
    maxMarkerGapMs, todosLosMarcadores, reboteRefinado: true,
  });

  const fromDate = new Date(fy, fm - 1, fd);
  return [
    ...closedEvents.filter(e => e.timeIn >= fromDate).map(e => ({ ...e, hasReturn: true })),
    ...Array.from(openEvents.entries()).map(([employeeId, ev]) => ({
      employeeId, category: ev.category, timeOut: ev.timeOut, timeIn: null, hasReturn: false,
      salidaMarkerUserId: ev.salidaMarkerUserId ?? null, regresoMarkerUserId: null,
    })),
  ].filter(e => e.category === 'CAMPANA');
}

// Como cuenta Presentismo los dias habiles en campaña sin fichar -- ver
// /config/campana-presentismo-modo en horasdedica.js. 'ignorar' es el
// default: una empresa que no decidio no ve ningun cambio.
const CAMPANA_PRESENTISMO_MODOS = ['ignorar', 'trabajado', 'excusado'];
async function fetchCampanaPresentismoModo(db, tenantId) {
  const value = await getAppSetting('campanaPresentismoModo', tenantId, db);
  return CAMPANA_PRESENTISMO_MODOS.includes(value) ? value : 'ignorar';
}

// Para el motor diario: que empleados estan "adentro" de una campaña en
// `date` (mismo criterio que /attendance-range: ni el dia de salida ni el de
// regreso, ver diasInterioresDeCampana). Devuelve null si no hay nada que
// interpretar -- modo 'ignorar', o vista cruzada de superadmin (tenantId
// null: no hay UNA configuracion de empresa que aplicar). En ese caso no se
// hace ninguna consulta de fichajes.
async function empleadosEnCampanaElDia(db, tenantId, date) {
  if (tenantId == null) return null;
  const modo = await fetchCampanaPresentismoModo(db, tenantId);
  if (modo === 'ignorar') return null;
  const empleados = new Set();
  for (const ev of await detectarCampanas(db, tenantId, date, date)) {
    if (movementsCalc.diasInterioresDeCampana(ev.timeOut, ev.timeIn, date, date).length > 0) {
      empleados.add(String(ev.employeeId));
    }
  }
  return { modo, empleados };
}

module.exports = {
  fetchMovementCheckins,
  fetchMarkerMap,
  fetchMarkerMaxGapMs,
  detectarCampanas,
  fetchCampanaPresentismoModo,
  empleadosEnCampanaElDia,
  CAMPANA_PRESENTISMO_MODOS,
};
