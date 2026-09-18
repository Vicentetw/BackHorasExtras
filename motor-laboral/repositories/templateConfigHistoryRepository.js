// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #3 de la auditoria. Acceso a DB para
// work_schedule_template_config_history -- la logica de A CUAL fecha
// corresponde cada snapshot vive en templateConfigHistoryResolver.js
// (puro), esta capa solo trae/guarda filas.
const { TOLERANCE_FIELDS } = require('../services/templateConfigHistoryResolver');

// Trae TODOS los snapshots de un lote de plantillas de una sola vez
// (mismo criterio de "resolver el rango completo en memoria" que ya usa
// scheduleRepository/dayTypeRuleRepository, para no consultar por
// dia/empleado). En la enorme mayoria de los casos esto devuelve un
// array vacio (ninguna plantilla cambio nunca su configuracion todavia).
async function findForTemplates(templateIds, db) {
  const safeIds = (templateIds || []).filter((id) => id !== undefined && id !== null);
  if (safeIds.length === 0) return [];

  const [rows] = await db.query(
    `SELECT * FROM work_schedule_template_config_history WHERE template_id IN (?)`,
    [safeIds]
  );
  return rows;
}

// Si alguna de las 4 columnas de tolerancia cambio, archiva el estado
// ANTERIOR como un snapshot cerrado (valid_to = el dia antes de que el
// cambio entre en vigencia) antes de que el UPDATE de la plantilla lo
// pise. Sin esto, recalcular una fecha pasada usaria la config NUEVA en
// vez de la que realmente regia en su momento (HALLAZGO #3).
//
// oldRow: fila COMPLETA de work_schedule_templates antes del UPDATE
// (incluye created_at, usado como limite inferior si es el primer
// cambio). newValues: los mismos 4 campos, ya normalizados (null si no
// vinieron). effectiveDate: 'YYYY-MM-DD', normalmente "hoy" -- el nuevo
// valor rige desde ese dia en adelante.
async function archiveCurrentConfigIfChanged(oldRow, newValues, effectiveDate, db) {
  const changed = TOLERANCE_FIELDS.some((field) => (oldRow[field] ?? null) !== (newValues[field] ?? null));
  if (!changed) return;

  const [[lastSnapshot]] = await db.query(
    `SELECT valid_to FROM work_schedule_template_config_history WHERE template_id = ? ORDER BY valid_to DESC LIMIT 1`,
    [oldRow.id]
  );
  // Si ya hay snapshots previos, este arranca justo donde termino el
  // ultimo. Si es el PRIMER cambio de esta plantilla, arranca el dia que
  // se creo (antes de eso la plantilla no existia, no hace falta cubrir
  // fechas anteriores a su creacion).
  const validFrom = lastSnapshot
    ? addDays(lastSnapshot.valid_to, 1)
    : toDateOnly(oldRow.created_at);
  const validTo = addDays(effectiveDate, -1);

  // Si el calculo de fechas da un rango invertido (ej. dos ediciones el
  // mismo dia -- validFrom terminaria despues de validTo), no tiene
  // sentido archivar un rango vacio: la edicion anterior de HOY ya
  // reflejaba el cambio de HOY, no hace falta un snapshot de un solo
  // instante. Se deja que el ultimo estado antes de esta edicion sea el
  // que prevalezca para "hoy" (comportamiento razonable: varias
  // ediciones el mismo dia no generan historial fragmentado por minuto).
  if (validFrom > validTo) return;

  await db.query(
    `INSERT INTO work_schedule_template_config_history
       (template_id, tolerancia_entrada_minutos, tolerancia_salida_anticipada_minutos, politica_llegada_anticipada, politica_salida_posterior, valid_from, valid_to)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      oldRow.id,
      oldRow.tolerancia_entrada_minutos ?? null,
      oldRow.tolerancia_salida_anticipada_minutos ?? null,
      oldRow.politica_llegada_anticipada ?? null,
      oldRow.politica_salida_posterior ?? null,
      validFrom,
      validTo
    ]
  );
}

// Acepta tanto un string 'YYYY-MM-DD[ HH:MM:SS]' (conexiones con
// dateStrings:true, como el pool compartido db.js) como un objeto Date
// nativo (conexiones sin esa opcion, ej. mysql.createConnection directo
// en un test) -- usar componentes LOCALES en el caso Date, nunca
// toISOString() (UTC, puede correr la fecha un dia en Argentina UTC-3).
function toDateOnly(datetimeOrDate) {
  if (datetimeOrDate instanceof Date) {
    const yyyy = datetimeOrDate.getFullYear();
    const mm = String(datetimeOrDate.getMonth() + 1).padStart(2, '0');
    const dd = String(datetimeOrDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(datetimeOrDate).slice(0, 10);
}

function addDays(dateStr, days) {
  const [y, m, d] = toDateOnly(dateStr).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = { findForTemplates, archiveCurrentConfigIfChanged };
