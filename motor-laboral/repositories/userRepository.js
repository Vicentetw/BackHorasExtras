async function findAll({ tenantId }, db) {
  const params = [];
  let query = `SELECT
       e.employee_id AS employeeId,
       -- Etapa 12 del plan "Motor de reglas de asistencia configurable" --
       -- e.employee_id (arriba) es el LEGAJO, no el PK. rule_engine_shadow_diffs.employee_id
       -- (como employee_convention_assignments/employee_work_calendars) referencia
       -- employees.id de verdad, por eso hace falta exponerlo tambien aca.
       e.id AS internalEmployeeId,
       COALESCE(u.USERID, NULL) AS USERID,
       COALESCE(u.Badgenumber, e.employee_id) AS Badgenumber,
       COALESCE(e.nombre, u.Name) AS Name,
       e.tenant_id AS tenantId,
       e.ciudad_id AS ciudadId,
       COALESCE(e.overtime_authorized, 1) AS overtimeAuthorized,
       COALESCE(e.activo, 1) AS activo
     FROM employees e
     LEFT JOIN user_employee_map ue ON ue.employee_id = e.id
     LEFT JOIN users u ON u.USERID = ue.USERID AND u.tenant_id = ue.tenant_id
     WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)`;

  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND e.tenant_id = ?`;
    params.push(tenantId);
  }

  query += ` ORDER BY e.nombre ASC`;

  const [rows] = await db.query(query, params);
  return rows.map(row => ({
    ...row,
    tenantId: row.tenantId !== undefined ? row.tenantId : null
  }));
}

module.exports = {
  findAll
};
