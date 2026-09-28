// Licencias multi-día (vacaciones, enfermedad, etc.) cargadas en employee_events.
// Se exponen ya resueltas contra `employees.employee_id` (legajo) para poder
// cruzarlas fácilmente con badge/legajo en los distintos reportes de asistencia.

const SELECT_FIELDS = `
  ee.id, ee.employee_id, ee.fecha_desde, ee.fecha_hasta, ee.dias, ee.observaciones,
  e.employee_id AS legajo,
  et.code AS eventTypeCode, et.descripcion AS eventTypeDescripcion
`;

// tenantId: filtra por la empresa del empleado. Sin esto, una licencia de
// OTRA empresa se colaba en los reportes: los llamadores cruzan por legajo, y
// desde la Fase 20 el legajo ya no es unico entre empresas (el "1000" de una
// y el "1000" de otra son personas distintas). null = vista de superadmin,
// sin filtro -- mismo criterio que checkinRepository/exclusionRepository.
function tenantClause(tenantId) {
  return tenantId != null ? { sql: ' AND e.tenant_id = ?', params: [tenantId] } : { sql: '', params: [] };
}

async function findByDate(date, db, tenantId = null) {
  const t = tenantClause(tenantId);
  const [rows] = await db.query(
    `SELECT ${SELECT_FIELDS}
     FROM employee_events ee
     JOIN employees e ON e.id = ee.employee_id
     LEFT JOIN event_types et ON et.id = ee.event_type_id
     WHERE ee.fecha_desde <= ? AND ee.fecha_hasta >= ?${t.sql}`,
    [date, date, ...t.params]
  );
  return rows;
}

async function findByRange(from, to, db, tenantId = null) {
  const t = tenantClause(tenantId);
  const [rows] = await db.query(
    `SELECT ${SELECT_FIELDS}
     FROM employee_events ee
     JOIN employees e ON e.id = ee.employee_id
     LEFT JOIN event_types et ON et.id = ee.event_type_id
     WHERE ee.fecha_desde <= ? AND ee.fecha_hasta >= ?${t.sql}`,
    [to, from, ...t.params]
  );
  return rows;
}

module.exports = {
  findByDate,
  findByRange
};
