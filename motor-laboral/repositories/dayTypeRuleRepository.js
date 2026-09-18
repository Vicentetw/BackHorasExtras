// Etapa 12 del plan "Motor de reglas de asistencia configurable" -- trae
// TODAS las reglas de day_type_overtime_rules relevantes para un conjunto
// de tenants/plantillas de una sola vez (mismo criterio de "resolver todo
// el rango en memoria" que ya usa scheduleRepository, en vez de una query
// por dia/empleado). dayTypeRuleResolver.js (puro) se encarga de elegir,
// de este mismo conjunto, cual regla aplica a cada dia+disparador puntual.
// Etapa 14 (hallazgo #1 de la auditoria): se suma conventionIds -- antes
// solo se traian reglas globales/por tenant/por plantilla, nunca las
// reglas propias de un CONVENIO (day_type_overtime_rules.convention_id,
// columna que ya existia desde la Etapa 8 pero ningun llamador la usaba
// para filtrar). Sin esto, asignarle un convenio a un empleado no tenia
// ningun efecto en el calculo -- ver dayTypeRuleResolver.resolveOvertimeRate,
// que ya sabe desempatar por especificidad (convenio > tenant > global)
// pero nunca recibia una regla de convenio en su lista de candidatas.
async function findForScopes({ tenantIds, templateIds, conventionIds }, db) {
  const safeTenantIds = (tenantIds || []).filter((id) => id !== undefined && id !== null);
  const safeTemplateIds = (templateIds || []).filter((id) => id !== undefined && id !== null);
  const safeConventionIds = (conventionIds || []).filter((id) => id !== undefined && id !== null);

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
  if (safeConventionIds.length > 0) {
    conditions.push('convention_id IN (?)');
    params.push(safeConventionIds);
  }

  const [rows] = await db.query(
    `SELECT * FROM day_type_overtime_rules WHERE active = 1 AND (${conditions.join(' OR ')})`,
    params
  );
  return rows;
}

module.exports = { findForScopes };
