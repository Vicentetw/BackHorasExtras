async function findByDate(date, tenantId, db) {
  const [rows] = await db.query(
    `SELECT c.*, u.USERID, u.Badgenumber, u.Name, e.employee_id AS employeeId
     FROM Checkins c
     LEFT JOIN users u
       ON u.USERID = c.USERID
       OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR)
     LEFT JOIN user_employee_map ue ON ue.USERID = u.USERID
     LEFT JOIN employees e ON e.id = ue.employee_id
     WHERE DATE(c.CHECKTIME) = ?
       AND e.employee_id IS NOT NULL
     ORDER BY c.CHECKTIME ASC`,
    [date]
  );
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
