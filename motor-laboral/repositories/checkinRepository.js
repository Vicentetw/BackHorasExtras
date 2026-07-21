function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

async function findByDate(date, tenantId, db) {
  // Rango sargable en vez de DATE(c.CHECKTIME) = ?: envolver la columna en
  // DATE() invalida el indice y fuerza un full table scan en cada consulta.
  const params = [date, nextDayStr(date)];
  let query = `SELECT c.*, u.USERID, u.Badgenumber, u.Name, e.employee_id AS employeeId
     FROM Checkins c
     LEFT JOIN users u
       ON u.USERID = c.USERID
       OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR)
     LEFT JOIN user_employee_map ue ON ue.USERID = u.USERID
     LEFT JOIN employees e ON e.id = ue.employee_id
     WHERE c.CHECKTIME >= ? AND c.CHECKTIME < ?
       AND e.employee_id IS NOT NULL`;

  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND e.tenant_id = ?`;
    params.push(tenantId);
  }

  query += ` ORDER BY c.CHECKTIME ASC`;

  const [rows] = await db.query(query, params);
  return rows.map(r => ({
    USERID: r.USERID,
    employeeId: r.employeeId,
    CHECKTIME: r.CHECKTIME instanceof Date
      ? r.CHECKTIME.toISOString().slice(0, 19).replace('T', ' ')
      : r.CHECKTIME,
    Badgenumber: r.Badgenumber,
    Name: r.Name
  }));
}

module.exports = {
  findByDate
};
