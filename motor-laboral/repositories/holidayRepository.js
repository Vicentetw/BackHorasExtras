// Bug real encontrado (re-auditoria del motor diario, Fase 20): tenantId se
// recibia como parametro pero nunca se usaba en el WHERE -- el feriado de
// CUALQUIER empresa contaba para todas, y viceversa (una empresa sin ese
// feriado igual lo heredaba).
// Aislamiento por empresa (2026-10-06, AISLAMIENTO_POR_EMPRESA.md letra B):
// solo los feriados de la empresa. Antes tambien entraban los "globales"
// (tenant_id NULL), que en la practica eran feriados de AVP cargados sin
// empresa (ej. "Dia de Rawson"): se aplicaban a CUALQUIER empresa y la
// pantalla de Feriados ni siquiera los mostraba.
async function findByDate(date, tenantId, db) {
  const params = [date, date];
  let tenantClause = '';
  if (tenantId !== undefined && tenantId !== null) {
    tenantClause = ' AND tenant_id = ?';
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
