// Correcciones de fichajes (etapa G, 2026-10-30). Diseño completo:
// CORRECCIONES_FICHAJES.md. Tabla: migración 20261027_correcciones_fichajes.
//
// QUE ES
// ------
// Una corrección NO modifica lo que mandó el reloj (Checkins no se toca
// nunca). Es una interpretación administrativa guardada aparte: "este
// fichaje no vale" (OMITIR), "este fichaje no lleva marcador"
// (QUITAR_MARCADOR) o "lleva este otro marcador" (CAMBIAR_MARCADOR), con
// motivo, quién y cuándo. Se aplica en memoria, en el momento en que cada
// lector trae los fichajes y ANTES de que lleguen a los motores. Los motores
// no cambian.
//
// POR QUE NO SE SACA EL FICHAJE DE LA LISTA SIN MAS
// -------------------------------------------------
// detectMovements le da cada marcador al siguiente fichaje del MISMO reloj.
// Sacar un fichaje deja su marcador suelto y se lo lleva el que fichó atrás:
// medido en octubre de AVP, a otra persona le cambiaba el resultado en el
// 14 % de los casos. Por eso, para el motor de marcadores:
//   - el fichaje corregido queda EN SU RELOJ, a nombre de "nadie"
//     (`corr:<id>`): se lleva exactamente el mismo marcador que antes y
//     nadie más lo recibe;
//   - si la persona sigue fichando (QUITAR / CAMBIAR), su copia va a un
//     CARRIL PRIVADO (`corr:<id>@<reloj>`), una cola de marcadores que no
//     coincide con ningún reloj real: no puede recibir marcadores de un
//     reloj ni pasárselos a otro (regla del dueño: los fichajes de un reloj
//     nunca se mezclan con los de otro);
//   - CAMBIAR pone en ese carril el marcador elegido, con la MISMA hora
//     exacta del fichaje, justo antes por posición (el ordenamiento de
//     JavaScript es estable). Ninguna hora se mueve.
// Para las horas (entrada, salida, presencia) un fichaje omitido no existe y
// los otros dos siguen contando.
//
// SIN CORRECCIONES, NADA CAMBIA
// -----------------------------
// Si no hay correcciones activas (o la tabla no existe todavía), cada
// función devuelve la MISMA lista que recibió, sin copiarla: el cálculo es
// idéntico al de antes de esta etapa.

const { AsyncLocalStorage } = require('node:async_hooks');

const PREFIJO = 'corr:';
const ACCIONES = ['OMITIR', 'QUITAR_MARCADOR', 'CAMBIAR_MARCADOR'];
const SIN_CORRECCIONES = Object.freeze({ activas: new Map(), huerfanas: [], tabla: false });

// Vista previa: "¿qué pasaría si...?". El cálculo de siempre corre dentro de
// este contexto y leer() suma o saca las correcciones simuladas. No se
// escribe nada, y solo afecta a la cadena de llamadas de esa vista previa.
const simulacion = new AsyncLocalStorage();
function conSimulacion(sim, fn) {
  return simulacion.run(sim, fn);
}

const esInterno = (employeeId) => typeof employeeId === 'string' && employeeId.startsWith(PREFIJO);

// Cómo se reconoce un fichaje en las listas que arman los lectores: por su
// número crudo de reloj y su hora exacta, que en Checkins son únicos por
// empresa (clave uq_checkin). NO se agrega Checkins.id a las consultas de los
// lectores a propósito: cambiar las columnas de una consulta puede cambiar el
// orden en que la base devuelve dos fichajes del MISMO segundo, y con eso a
// quién le toca un marcador (medido el 2026-10-30: pasaba en Campaña). La
// corrección guarda el id y lo valida en leer(); el resto se identifica así.
const clave = (userid, hora) => `${Number(userid)}|${hora}`;
const horaDe = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function desdeFila(r) {
  return {
    id: r.id,
    checkinId: Number(r.checkin_id),
    userid: Number(r.checkin_userid),
    time: String(r.checkin_time),
    machineIp: r.checkin_machine_ip,
    employeeId: r.employee_id != null ? String(r.employee_id) : null,
    accion: r.accion,
    marcadorUserId: r.marcador_user_id != null ? Number(r.marcador_user_id) : null,
    motivo: r.motivo,
    por: r.creado_por_email ?? null,
    en: r.created_at != null ? String(r.created_at) : null,
  };
}

// Correcciones activas cuyo fichaje cae en [desde, hasta). Una consulta.
// Solo se aplican si el fichaje sigue siendo el mismo que vio quien corrigió
// (mismo número de reloj, hora y reloj): si se borró o se reimportó, la
// corrección queda "huérfana" y no se aplica a otro fichaje.
async function leer(db, tenantId, desde, hasta) {
  const sim = simulacion.getStore();
  if (tenantId === undefined || tenantId === null) return SIN_CORRECCIONES;
  let filas;
  try {
    [filas] = await db.query(
      `SELECT fc.*, c.id AS c_id, c.USERID AS c_userid, c.CHECKTIME AS c_time, c.MACHINE_IP AS c_ip,
              au.email AS creado_por_email
         FROM fichajes_correcciones fc
         LEFT JOIN Checkins c ON c.id = fc.checkin_id AND c.tenant_id = fc.tenant_id
         LEFT JOIN app_users au ON au.id = fc.created_by
        WHERE fc.tenant_id = ? AND fc.deshecha_at IS NULL
          AND fc.checkin_time >= ? AND fc.checkin_time < ?`,
      [tenantId, desde, hasta]);
  } catch (err) {
    // Migración 20261027 sin correr: sin correcciones, todo como antes.
    if (err.code === 'ER_NO_SUCH_TABLE') filas = null;
    else throw err;
  }
  const activas = new Map();
  const huerfanas = [];
  for (const r of filas || []) {
    const valida = r.c_id != null && Number(r.c_userid) === Number(r.checkin_userid)
      && String(r.c_time) === String(r.checkin_time) && (r.c_ip ?? null) === (r.checkin_machine_ip ?? null);
    if (valida) { const c = desdeFila(r); activas.set(clave(c.userid, c.time), c); }
    else huerfanas.push(desdeFila(r));
  }
  if (sim && Number(sim.tenantId) === Number(tenantId)) {
    for (const id of sim.quitar || []) for (const [k, c] of activas) if (c.id === id) activas.delete(k);
    for (const c of sim.agregar || []) if (c.time >= desde && c.time < hasta) activas.set(clave(c.userid, c.time), c);
  }
  if (!activas.size && !huerfanas.length && filas === null) return SIN_CORRECCIONES;
  return { activas, huerfanas, tabla: filas !== null };
}

// Para el motor de marcadores (detectMovements). `filas`: { checktime (Date),
// userId, employeeId, machineIp[, rawUserId] } en orden cronológico; el
// número crudo del reloj es `rawUserId` si viene, si no `userId`. Devuelve la
// misma lista si no hay nada que corregir.
function paraDeteccion(filas, correcciones) {
  if (!correcciones || !correcciones.activas.size) return filas;
  let tocada = false;
  const out = [];
  for (const f of filas) {
    const c = f.employeeId ? correcciones.activas.get(clave(f.rawUserId ?? f.userId, horaDe(f.checktime))) : undefined;
    if (!c) { out.push(f); continue; }
    tocada = true;
    // En su reloj, a nombre de nadie: se lleva lo mismo que antes.
    out.push({ ...f, employeeId: `${PREFIJO}${c.id}`, corrDe: f.employeeId, correccionId: c.id });
    if (c.accion === 'OMITIR') continue;
    const carril = `${PREFIJO}${c.id}@${f.machineIp}`;
    if (c.accion === 'CAMBIAR_MARCADOR') {
      out.push({ checktime: f.checktime, userId: c.marcadorUserId, employeeId: null, machineIp: carril, relojOriginal: f.machineIp, correccionId: c.id, sintetico: true });
    }
    out.push({ ...f, machineIp: carril, relojOriginal: f.machineIp, correccionId: c.id });
  }
  return tocada ? out : filas;
}

// Para las horas: saca los fichajes omitidos. Por defecto la fila trae el
// número crudo en USERID y la hora en CHECKTIME (texto), como la consulta de
// /attendance-range.
function paraHoras(filas, correcciones, claveDe = (f) => clave(f.USERID, String(f.CHECKTIME))) {
  if (!correcciones || !correcciones.activas.size) return filas;
  const omitida = (f) => {
    const c = correcciones.activas.get(claveDe(f));
    return !!c && c.accion === 'OMITIR';
  };
  return filas.some(omitida) ? filas.filter((f) => !omitida(f)) : filas;
}

// Ids de Checkins omitidos (para consultas SQL que solo cuentan o buscan el
// último fichaje). Vacío si no hay.
function idsOmitidos(correcciones) {
  if (!correcciones || !correcciones.activas.size) return [];
  return [...correcciones.activas.values()].filter((c) => c.accion === 'OMITIR').map((c) => c.checkinId);
}

// Ids omitidos de toda la empresa en un período (por defecto, todo), para
// las consultas que solo cuentan días o buscan el último fichaje.
async function idsOmitidosEn(db, tenantId, desde = '1000-01-01', hasta = '9999-12-31') {
  return idsOmitidos(await leer(db, tenantId, desde, hasta));
}

// Fragmento SQL " AND <columna> NOT IN (...)" con los ids omitidos, o ''
// si no hay. Los ids son enteros de la base (se fuerzan con Number).
function sinOmitidos(columna, ids) {
  const limpios = (ids || []).map(Number).filter(Number.isInteger);
  return limpios.length ? ` AND ${columna} NOT IN (${limpios.join(',')})` : '';
}

// Campaña "solo empleados afectados": la lectura a nombre de nadie hereda el
// permiso de la persona original, para llevarse el mismo marcador que antes.
function soloPuedenConsumirCon(set, filas) {
  if (!set) return set;
  let extra = null;
  for (const f of filas) {
    if (f.corrDe && set.has(f.corrDe)) (extra ||= new Set(set)).add(f.employeeId);
  }
  return extra || set;
}

// Las correcciones de una persona (para mostrarlas en pantalla).
function dePersona(correcciones, legajo) {
  if (!correcciones || !correcciones.activas.size) return [];
  return [...correcciones.activas.values()].filter((c) => c.employeeId === String(legajo));
}

module.exports = {
  PREFIJO, ACCIONES, SIN_CORRECCIONES, clave,
  leer, paraDeteccion, paraHoras, idsOmitidos, idsOmitidosEn, sinOmitidos, soloPuedenConsumirCon, dePersona, esInterno,
  conSimulacion,
};
