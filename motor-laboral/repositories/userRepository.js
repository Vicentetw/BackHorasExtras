async function findAll({ tenantId }, db) {
  const [rows] = await db.query(
    `SELECT 
       e.employee_id AS employeeId,
       COALESCE(u.USERID, NULL) AS USERID,
       COALESCE(u.Badgenumber, e.employee_id) AS Badgenumber,
       COALESCE(u.Name, e.nombre) AS Name
     FROM employees e
     LEFT JOIN user_employee_map ue ON ue.employee_id = e.id
     LEFT JOIN users u ON u.USERID = ue.USERID
     WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)
     ORDER BY e.nombre ASC`
  );
  return rows;
}

module.exports = {
  findAll
};
