async function findByDate(date, tenantId, db) {
  const [rows] = await db.query(
    `SELECT x.*
     FROM userexclusions x
     JOIN users u ON u.USERID = x.userId
     JOIN user_employee_map ue ON ue.USERID = u.USERID
     JOIN employees e ON e.id = ue.employee_id
     WHERE x.excDate = ?`,
    [date]
  );
  return rows;
}

module.exports = {
  findByDate
};
