async function findByDate(date, tenantId, db) {
  const [rows] = await db.query(
    `SELECT * FROM holidays WHERE date = ? OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') = DATE_FORMAT(?, '%m-%d'))`,
    [date, date]
  );
  return rows;
}

module.exports = {
  findByDate
};
