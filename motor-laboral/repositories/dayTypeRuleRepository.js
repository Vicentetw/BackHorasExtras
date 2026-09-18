// Etapa 12 del plan "Motor de reglas de asistencia configurable" -- trae
// TODAS las reglas de day_type_overtime_rules relevantes para un conjunto
// de tenants/plantillas de una sola vez (mismo criterio de "resolver todo
// el rango en memoria" que ya usa scheduleRepository, en vez de una query
// por dia/empleado). dayTypeRuleResolver.js (puro) se encarga de elegir,
// de este mismo conjunto, cual regla aplica a cada dia+disparador puntual.
async function findForScopes({ tenantIds, templateIds }, db) {
  const safeTenantIds = (tenantIds || []).filter((id) => id !== undefined && id !== null);
  const safeTemplateIds = (templateIds || []).filter((id) => id !== undefined && id !== null);

  const conditions = ['tenant_id IS NULL'];
  const params = [];
  if (safeTenantIds.length > 0) {
    conditions.push('tenant_id IN (?)');
    params.push(safeTenantIds);
  }
  if (safeTemplateIds.length > 0) {
    conditions.push('template_id IN (?)');
    params.push(safeTemplateIds);
  }

  const [rows] = await db.query(
    `SELECT * FROM day_type_overtime_rules WHERE active = 1 AND (${conditions.join(' OR ')})`,
    params
  );
  return rows;
}

module.exports = { findForScopes };
