// ============================================================================
// Autorización de salidas particulares (etapa E1, 2026-10-15)
// ============================================================================
//
// POR QUÉ: una persona no puede salir en horario sin permiso; si sale y le
// pasa algo, la aseguradora (ART) no se hace responsable. Cada salida
// particular tiene que quedar AUTORIZADA o NO AUTORIZADA por alguien, con
// quién y cuándo. Pedido del dueño, para cualquier empresa: es una OPCIÓN
// que activa cada una ("Las salidas particulares requieren autorización").
// Apagada (por defecto), todo sigue exactamente como antes.
//
// QUÉ ES UNA "SALIDA" ACÁ: lo mismo que muestra la pantalla Salidas →
// Particulares (una sola fuente de verdad, MARCADORES_Y_SALIDAS.md):
//   'salida'       salió con el marcador y volvió ese día;
//   'entrada'      llegó con el marcador de regreso sin haber salido: entró
//                  tarde con permiso (se cuenta desde su hora de entrada);
//   'sin_regreso'  salió con el marcador y no volvió (se va antes).
// Se identifica por persona + fecha + tipo + hora REAL del fichaje (la salida,
// o la llegada si es una entrada). Sin decisión guardada = "pendiente".
//
// Tabla: migrations/20261019_autorizacion_salidas.sql. Sin ella, todo
// funciona como siempre y la opción avisa que falta la migración.
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');

const SETTING = 'salidasRequierenAutorizacion';
const ESTADOS = ['autorizada', 'no_autorizada', 'pendiente'];
const TIPOS = ['salida', 'entrada', 'sin_regreso'];
const MAX_POR_PEDIDO = 500;
const faltaTabla = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

class ErrorDeAutorizacion extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

async function requiereAutorizacion(db, tenantId) {
  if (tenantId == null) return false;
  return String(await getAppSetting(SETTING, tenantId, db)) === '1';
}

async function setRequiereAutorizacion(db, tenantId, valor) {
  if (tenantId == null) throw new ErrorDeAutorizacion(400, 'Elegí la empresa.');
  await setAppSetting(SETTING, tenantId, valor ? '1' : '0', db);
}

async function tablaDisponible(db) {
  try { await db.query('SELECT 1 FROM salidas_autorizaciones LIMIT 0'); return true; } catch (err) { if (faltaTabla(err)) return false; throw err; }
}

const hhmm = (d) => (d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null);

/**
 * Tipo y hora real de un evento de detectMovements (ya cerrado o sintetizado).
 * @returns {{tipo: string, hora: string|null}}
 */
function identidad(e) {
  if (!e.hasReturn) return { tipo: 'sin_regreso', hora: hhmm(e.timeOut) };
  // Una "entrada particular" no tiene marcador de salida: la salida se
  // sintetizó con su horario de entrada (openOrphanReturnsAtScheduleEntrance).
  if (e.salidaMarkerUserId == null && !e.salidaCorregida) return { tipo: 'entrada', hora: hhmm(e.timeIn) };
  return { tipo: 'salida', hora: hhmm(e.timeOut) };
}

const clave = (legajo, fecha, tipo, hora) => `${legajo}|${fecha}|${tipo}|${hora}`;

/** Decisiones guardadas en el rango: Map clave → {estado, nota, por, en}. */
async function leerDecisiones(db, tenantId, desde, hasta) {
  const mapa = new Map();
  if (tenantId == null) return mapa;
  try {
    const [rows] = await db.query(
      `SELECT legajo, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, tipo, hora, estado, nota, decidido_por_email,
              DATE_FORMAT(decidido_en, '%Y-%m-%dT%H:%i:%sZ') AS decidido_en
         FROM salidas_autorizaciones WHERE tenant_id = ? AND fecha BETWEEN ? AND ?`, [tenantId, desde, hasta]);
    for (const r of rows) {
      mapa.set(clave(r.legajo, r.fecha, r.tipo, r.hora), { estado: r.estado, nota: r.nota || null, por: r.decidido_por_email || null, en: r.decidido_en });
    }
  } catch (err) {
    if (!faltaTabla(err)) throw err;
  }
  return mapa;
}

/**
 * Autoriza / no autoriza / vuelve a pendiente varias salidas a la vez.
 * @param items  [{legajo, fecha:'AAAA-MM-DD', tipo, hora:'HH:MM'}]
 * @param usuario {id, email}
 */
async function decidir(db, tenantId, { items, estado, nota }, usuario) {
  if (tenantId == null) throw new ErrorDeAutorizacion(400, 'Elegí la empresa.');
  if (!ESTADOS.includes(estado)) throw new ErrorDeAutorizacion(400, 'Estado inválido.');
  if (!Array.isArray(items) || !items.length) throw new ErrorDeAutorizacion(400, 'No hay salidas elegidas.');
  if (items.length > MAX_POR_PEDIDO) throw new ErrorDeAutorizacion(400, `Como máximo ${MAX_POR_PEDIDO} salidas por vez.`);
  const limpios = items.map((it) => ({
    legajo: String(it && it.legajo ? it.legajo : '').trim().slice(0, 32),
    fecha: String(it && it.fecha ? it.fecha : ''),
    tipo: String(it && it.tipo ? it.tipo : ''),
    hora: String(it && it.hora ? it.hora : ''),
  }));
  for (const it of limpios) {
    if (!it.legajo || !/^\d{4}-\d{2}-\d{2}$/.test(it.fecha) || !TIPOS.includes(it.tipo) || !/^\d{2}:\d{2}$/.test(it.hora)) {
      throw new ErrorDeAutorizacion(400, 'Una de las salidas elegidas tiene datos inválidos. Recargá la pantalla.');
    }
  }
  // Solo personas de ESTA empresa.
  const legajos = [...new Set(limpios.map((i) => i.legajo))];
  const [deLaEmpresa] = await db.query('SELECT employee_id FROM employees WHERE tenant_id = ? AND employee_id IN (?)', [tenantId, legajos]);
  const validos = new Set(deLaEmpresa.map((r) => String(r.employee_id)));
  if (legajos.some((l) => !validos.has(l))) throw new ErrorDeAutorizacion(404, 'Una de las personas elegidas no es de esta empresa.');

  const notaLimpia = String(nota ?? '').trim().slice(0, 255) || null;
  try {
    for (const it of limpios) {
      if (estado === 'pendiente') {
        await db.query('DELETE FROM salidas_autorizaciones WHERE tenant_id = ? AND legajo = ? AND fecha = ? AND tipo = ? AND hora = ?',
          [tenantId, it.legajo, it.fecha, it.tipo, it.hora]);
      } else {
        await db.query(
          `INSERT INTO salidas_autorizaciones (tenant_id, legajo, fecha, tipo, hora, estado, nota, decidido_por, decidido_por_email, decidido_en)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE estado = VALUES(estado), nota = VALUES(nota), decidido_por = VALUES(decidido_por),
             decidido_por_email = VALUES(decidido_por_email), decidido_en = VALUES(decidido_en)`,
          [tenantId, it.legajo, it.fecha, it.tipo, it.hora, estado, notaLimpia, usuario && usuario.id || null, usuario && usuario.email || null]);
      }
    }
  } catch (err) {
    if (faltaTabla(err)) throw new ErrorDeAutorizacion(503, 'Falta correr la migración 20261019 (autorización de salidas).');
    throw err;
  }
  return { ok: true, cantidad: limpios.length, estado };
}

/**
 * Para la vista DIARIA de Presentismo: las entradas con permiso del día y su
 * decisión. Misma detección que Salidas y que /attendance-range (todos los
 * fichajes de la empresa del día: un marcador se lo lleva el siguiente
 * fichaje de cualquiera, MARCADORES_Y_SALIDAS.md).
 * @returns {Map<legajo, {estado, hora, por, en, nota}> | null}  null = la empresa no exige autorización
 */
async function entradasDelDia(db, tenantId, fecha) {
  if (!(await requiereAutorizacion(db, tenantId))) return null;
  // require acá adentro: campanaService y movementsCalculations son pesados
  // y solo hacen falta si la empresa usa la autorización.
  const campana = require('./campanaService');
  const movementsCalc = require('./movementsCalculations');
  const markerMap = await campana.fetchMarkerMap(db, 'PARTICULAR', tenantId);
  const resultado = new Map();
  if (!Object.keys(markerMap).length) return resultado;
  const [a, m, d] = fecha.split('-').map(Number);
  const siguiente = new Date(a, m - 1, d + 1);
  const hasta = `${siguiente.getFullYear()}-${String(siguiente.getMonth() + 1).padStart(2, '0')}-${String(siguiente.getDate()).padStart(2, '0')}`;
  const checkins = await campana.fetchMovementCheckins(db, fecha, hasta, tenantId);
  const { orphanReturns } = movementsCalc.detectMovements(checkins, markerMap, {
    maxMarkerGapMs: await campana.fetchMarkerMaxGapMs(db, tenantId),
    todosLosMarcadores: await campana.fetchMarkerMap(db, null, tenantId),
    correccionesMarcadores: await campana.fetchCorreccionesMarcadores(db, fecha, hasta, tenantId),
    ownCheckinBounceMs: await campana.fetchVentanaReboteMs(db, tenantId),
  });
  const decisiones = await leerDecisiones(db, tenantId, fecha, fecha);
  for (const r of orphanReturns.filter((x) => x.category === 'PARTICULAR')) {
    const hora = hhmm(r.timeIn);
    const dec = decisiones.get(clave(r.employeeId, fecha, 'entrada', hora));
    resultado.set(String(r.employeeId), dec ? { ...dec, hora } : { estado: 'pendiente', hora });
  }
  return resultado;
}

module.exports = {
  entradasDelDia,
  SETTING, requiereAutorizacion, setRequiereAutorizacion, tablaDisponible,
  identidad, clave, leerDecisiones, decidir, ErrorDeAutorizacion,
};
