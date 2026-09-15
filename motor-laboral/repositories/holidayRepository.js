// Bug real encontrado (re-auditoria del motor diario, Fase 20): tenantId se
// recibia como parametro pero nunca se usaba en el WHERE -- el feriado de
// CUALQUIER empresa contaba para todas, y viceversa (una empresa sin ese
// feriado igual lo heredaba). tenant_id = ? OR tenant_id IS NULL preserva
// el feriado GLOBAL (solo lo carga un superadmin, ver routes/holidays.js)
// sin dejar pasar el de otra empresa puntual.
async function findByDate(date, tenantId, db) {
  const params = [date, date];
  let tenantClause = '';
  if (tenantId !== undefined && tenantId !== null) {
    tenantClause = ' AND (tenant_id = ? OR tenant_id IS NULL)';
    params.push(tenantId);
  }
  const [rows] = await db.query(
    `SELECT * FROM holidays
     WHERE (date = ? OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') = DATE_FORMAT(?, '%m-%d')))${tenantClause}`,
    params
  );
  return rows;
}

module.exports = {
  findByDate
};
