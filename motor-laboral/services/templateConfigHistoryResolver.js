// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #3 de la auditoria (la configuracion de plantilla
// no tenia vigencia historica). Modulo PURO (sin DB): dado un conjunto de
// snapshots ya traidos (work_schedule_template_config_history) + la
// plantilla EN VIVO, resuelve que 4 columnas de tolerancia regian para
// una plantilla en una fecha puntual.
//
// historyRows: filas de work_schedule_template_config_history de
// CUALQUIER plantilla (el llamador trae todas las de un lote de una
// sola vez, ver templateConfigHistoryRepository.findForTemplates) --
// esta funcion filtra por templateId. Sin ninguna fila para esa
// plantilla (el caso de TODAS las plantillas que nunca cambiaron su
// configuracion), devuelve liveTemplate tal cual -- cero cambio de
// comportamiento respecto de antes de esta migracion.
const TOLERANCE_FIELDS = [
  'tolerancia_entrada_minutos',
  'tolerancia_salida_anticipada_minutos',
  'politica_llegada_anticipada',
  'politica_salida_posterior'
];

function resolveHistoricalToleranceFields(historyRows, templateId, date, liveTemplate) {
  const snapshot = (historyRows || []).find(
    (row) => row.template_id === templateId && row.valid_from <= date && row.valid_to >= date
  );
  if (!snapshot) return liveTemplate;

  const resolved = { ...liveTemplate };
  for (const field of TOLERANCE_FIELDS) {
    resolved[field] = snapshot[field];
  }
  return resolved;
}

module.exports = { resolveHistoricalToleranceFields, TOLERANCE_FIELDS };
