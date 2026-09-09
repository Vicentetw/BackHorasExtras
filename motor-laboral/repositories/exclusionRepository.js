// Bug real encontrado en la re-auditoria de venta (Fase 19): el parametro
// tenantId llegaba hasta aca pero NUNCA se usaba en la consulta -- esto
// devolvia las exclusiones/justificaciones de TODAS las empresas mezcladas
// a quien pidiera el motor diario de asistencia, sin importar el tenant
// real de quien pregunta. Se le suma ademas x.tenant_id (userexclusions ya
// tiene su propia columna, migracion 20260909) en cada JOIN -- USERID ya
// no es unico solo por si mismo entre empresas.
async function findByDate(date, tenantId, db) {
  const params = [date];
  let query = `SELECT x.*
     FROM userexclusions x
     JOIN users u ON u.USERID = x.userId AND u.tenant_id = x.tenant_id
     JOIN user_employee_map ue ON ue.USERID = u.USERID AND ue.tenant_id = u.tenant_id
     JOIN employees e ON e.id = ue.employee_id
     WHERE x.excDate = ?`;

  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND x.tenant_id = ?`;
    params.push(tenantId);
  }

  const [rows] = await db.query(query, params);
  return rows;
}

module.exports = {
  findByDate
};
