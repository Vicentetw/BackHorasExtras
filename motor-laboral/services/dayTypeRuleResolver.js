// Etapa 8 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt). Modulo PURO (sin acceso a DB) que
// resuelve si un tipo de dia + disparador tiene una tasa de HE
// configurada -- reemplaza cualquier "if holiday => 100" por una consulta
// a datos. Sin ninguna regla cargada, devuelve null (= comportamiento de
// hoy, ningun dia obtiene una tasa especial de forma automatica).
const DAY_TYPES = ['WORKDAY', 'SATURDAY', 'SUNDAY', 'REST_DAY', 'HOLIDAY', 'SPECIAL'];
const TRIGGER_TYPES = ['BEFORE_SCHEDULE', 'AFTER_SCHEDULE', 'ALL_DAY'];

// Cuando varias reglas candidatas matchean el mismo dia+trigger, gana la
// mas especifica: template > convenio > tenant > global. No es una regla
// de negocio hardcodeada -- es solo el criterio de desempate entre datos
// que el propio usuario cargo a distintos niveles.
function specificityScore(rule) {
  let score = 0;
  if (rule.template_id != null) score += 4;
  if (rule.convention_id != null) score += 2;
  if (rule.tenant_id != null) score += 1;
  return score;
}

// rules: filas de day_type_overtime_rules ya filtradas por tenant (y
// opcionalmente convenio/plantilla) por el llamador -- este modulo no
// hace ninguna consulta, solo elige entre las que se le pasan.
// { dayType, trigger }: el trigger 'ALL_DAY' matchea ademas de
// BEFORE_SCHEDULE/AFTER_SCHEDULE puntuales (una regla de "todo el dia"
// cubre cualquier disparador).
function resolveOvertimeRate(rules, { dayType, trigger }) {
  if (!DAY_TYPES.includes(dayType) || !TRIGGER_TYPES.includes(trigger)) return null;

  const candidates = (rules || []).filter((r) => {
    const isActive = r.active === undefined || r.active === null || Number(r.active) === 1;
    return isActive && r.day_type === dayType && (r.trigger_type === trigger || r.trigger_type === 'ALL_DAY');
  });
  if (candidates.length === 0) return null;

  // Si hay match puntual (BEFORE/AFTER) Y un ALL_DAY, el puntual gana --
  // es mas especifico sobre CUANDO se aplica, no solo sobre a quien.
  const exactTriggerMatches = candidates.filter((r) => r.trigger_type === trigger);
  const pool = exactTriggerMatches.length > 0 ? exactTriggerMatches : candidates;

  const rule = pool.slice().sort((a, b) => specificityScore(b) - specificityScore(a))[0];
  return {
    rate: rule.rate != null ? Number(rule.rate) : null,
    requiresAuthorization: rule.requires_authorization === undefined || rule.requires_authorization === null
      ? true
      : !!Number(rule.requires_authorization),
    classificationType: rule.classification_type || 'OVERTIME'
  };
}

// true si existe alguna regla ALL_DAY activa para ese dia -- se usa para
// decidir si TODO el tiempo trabajado del dia (no solo el exceso) debe
// reevaluarse bajo esa tasa (ej. "trabajar el franco es HE al 100%").
function resolveAllDayRule(rules, dayType) {
  return resolveOvertimeRate(rules, { dayType, trigger: 'ALL_DAY' });
}

module.exports = {
  DAY_TYPES,
  TRIGGER_TYPES,
  resolveOvertimeRate,
  resolveAllDayRule
};
