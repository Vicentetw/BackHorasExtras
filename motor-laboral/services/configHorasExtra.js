// ============================================================================
// Cómo se cuentan las horas extra: configuración por empresa y por plantilla
// (2026-10-17)
// ============================================================================
//
// POR QUE
// -------
// Cada empresa cuenta las horas extra a su manera y lo configura su propio
// administrador (no el superadmin):
//   - MARCAS_O_ESTIMADO (por defecto, lo de siempre): las teclas del reloj
//     (inicio/fin de horas extra); si ese día no hay marcas, el estimado desde
//     el corte (queda "a revisar").
//   - MARCAS_O_EXCESO: las marcas si las hay; si no, lo que supera el horario.
//   - EXCESO: solo lo que supera el horario de la plantilla. Sirve para
//     cualquier reloj, incluidos los de rostro (sin teclas).
//   - MARCAS: solo las marcas del reloj; sin marca, no hay horas extra
//     automáticas (lo que antes era la "fuente: solo marcadores" de un
//     régimen, que ahora se elige acá: una sola verdad para todas las pantallas).
// Además: si llegar antes de horario cuenta (por defecto no) y un mínimo de
// minutos por plantilla.
//
// DÓNDE SE GUARDA
// ---------------
// Empresa: app_settings ('overtimeMethod', 'overtimeCountEarlyArrival').
// Plantilla (excepción): tabla plantilla_horas_extra (migración 20261023).
// Sin la migración, las excepciones no se pueden guardar y todo usa lo de la
// empresa. Sin nada cargado = exactamente como siempre.
//
// Gana lo más específico: plantilla > empresa. El mínimo: plantilla > convenio
// o régimen > empresa.
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');

const METODOS = ['MARCAS_O_ESTIMADO', 'MARCAS_O_EXCESO', 'EXCESO', 'MARCAS'];
const POR_DEFECTO = 'MARCAS_O_ESTIMADO';
const MAXIMO_MINIMO = 240;

const metodoValido = (m) => (METODOS.includes(m) ? m : null);
const boolONull = (v) => (v === null || v === undefined || v === '' ? null : (v === true || v === 1 || v === '1' || v === 'true'));
function minimoValido(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= MAXIMO_MINIMO ? n : undefined; // undefined = inválido
}

async function leerEmpresa(db, tenantId) {
  if (tenantId === null || tenantId === undefined) return { metodo: POR_DEFECTO, contarLlegadaAnticipada: false };
  const [metodo, llegada] = await Promise.all([
    getAppSetting('overtimeMethod', tenantId, db),
    getAppSetting('overtimeCountEarlyArrival', tenantId, db),
  ]);
  return { metodo: metodoValido(metodo) || POR_DEFECTO, contarLlegadaAnticipada: llegada === '1' };
}

async function guardarEmpresa(db, tenantId, { metodo, contarLlegadaAnticipada }) {
  await setAppSetting('overtimeMethod', tenantId, metodoValido(metodo) || POR_DEFECTO, db);
  await setAppSetting('overtimeCountEarlyArrival', tenantId, contarLlegadaAnticipada ? '1' : '', db);
}

const faltaTabla = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

/** Excepciones de las plantillas de la empresa: Map(templateId -> {metodo, contarLlegadaAnticipada, minimo}). */
async function leerPlantillas(db, tenantId) {
  const mapa = new Map();
  if (tenantId === null || tenantId === undefined) return { mapa, tablaExiste: false };
  try {
    const [rows] = await db.query(
      'SELECT template_id, metodo, contar_llegada, minimo, actualizado_por_email, actualizado_en FROM plantilla_horas_extra WHERE tenant_id = ?',
      [tenantId]);
    for (const r of rows) {
      mapa.set(Number(r.template_id), {
        metodo: metodoValido(r.metodo),
        contarLlegadaAnticipada: r.contar_llegada === null ? null : !!Number(r.contar_llegada),
        minimo: minimoValido(r.minimo) || null,
        actualizadoPor: r.actualizado_por_email || null,
        actualizadoEn: r.actualizado_en || null,
      });
    }
    return { mapa, tablaExiste: true };
  } catch (err) {
    if (faltaTabla(err)) return { mapa, tablaExiste: false };
    throw err;
  }
}

/** Guarda (o borra, si todo viene vacío) la excepción de una plantilla. */
async function guardarPlantilla(db, tenantId, templateId, { metodo, contarLlegadaAnticipada, minimo }, email) {
  const m = metodoValido(metodo);
  const l = boolONull(contarLlegadaAnticipada);
  const min = minimoValido(minimo) || null;
  if (m === null && l === null && min === null) {
    await db.query('DELETE FROM plantilla_horas_extra WHERE tenant_id = ? AND template_id = ?', [tenantId, templateId]);
    return null;
  }
  await db.query(
    `INSERT INTO plantilla_horas_extra (template_id, tenant_id, metodo, contar_llegada, minimo, actualizado_por_email)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE metodo = VALUES(metodo), contar_llegada = VALUES(contar_llegada),
       minimo = VALUES(minimo), actualizado_por_email = VALUES(actualizado_por_email), actualizado_en = CURRENT_TIMESTAMP`,
    [templateId, tenantId, m, l === null ? null : (l ? 1 : 0), min, email || null]);
  return { metodo: m, contarLlegadaAnticipada: l, minimo: min };
}

/**
 * Pura. Lo que vale para un día: la excepción de la plantilla gana; lo que la
 * plantilla deja vacío sale de la empresa.
 */
function resolver(empresa, excepcion) {
  const e = excepcion || {};
  return {
    metodo: e.metodo || (empresa && empresa.metodo) || POR_DEFECTO,
    contarLlegadaAnticipada: e.contarLlegadaAnticipada != null ? e.contarLlegadaAnticipada : !!(empresa && empresa.contarLlegadaAnticipada),
    minimoPlantilla: e.minimo || null,
  };
}

module.exports = {
  METODOS, POR_DEFECTO, MAXIMO_MINIMO,
  metodoValido, boolONull, minimoValido,
  leerEmpresa, guardarEmpresa, leerPlantillas, guardarPlantilla, resolver, faltaTabla,
};
