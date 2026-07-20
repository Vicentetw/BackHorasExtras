async function findAll({ tenantId }, db) {
  const params = [];
  let query = `SELECT 
       e.employee_id AS employeeId,
       COALESCE(u.USERID, NULL) AS USERID,
       COALESCE(u.Badgenumber, e.employee_id) AS Badgenumber,
       COALESCE(e.nombre, u.Name) AS Name,
       e.tenant_id AS tenantId
     FROM employees e
     LEFT JOIN user_employee_map ue ON ue.employee_id = e.id
     LEFT JOIN users u ON u.USERID = ue.USERID
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
