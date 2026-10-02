// Fase 18 (continuacion) -- "hasta cuando esta actualizado cada reloj".
// Se actualiza en cada subida exitosa de fichajes via el agente
// (routes/agent.js), agrupado por reloj de origen (machine_ip/machine_sn) --
// asi Presentismo puede avisar si un reloj puntual dejo de sincronizar
// (ej. se desconecto de la red) aunque los demas de la misma empresa
// sigan andando bien.
async function upsertSyncStatus(tenantId, registros, db) {
  // Agrupa el lote por reloj de origen -- un POST puede traer fichajes de
  // varios relojes mezclados (el agente sube todo lo pendiente junto).
  const porReloj = new Map();
  for (const r of registros) {
    const ip = r.MACHINE_IP || null;
    const sn = r.MACHINE_SN || null;
    const key = `${ip}|${sn}`;
    if (!porReloj.has(key)) porReloj.set(key, { ip, sn, count: 0, maxCheck: null });
    const entry = porReloj.get(key);
    entry.count++;
    if (r.CHECKTIME && (!entry.maxCheck || r.CHECKTIME > entry.maxCheck)) {
      entry.maxCheck = r.CHECKTIME;
    }
  }

  for (const { ip, sn, count, maxCheck } of porReloj.values()) {
    await db.query(
      `INSERT INTO agent_sync_status (tenant_id, machine_ip, machine_sn, last_synced_at, last_checktime, fichajes_ultima_subida)
       VALUES (?, ?, ?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
         last_synced_at = NOW(), last_checktime = VALUES(last_checktime), fichajes_ultima_subida = VALUES(fichajes_ultima_subida)`,
      [tenantId, ip, sn, maxCheck, count]
    );
  }
}

// `nombre` (migracion 20261013) es como la empresa llama al reloj. Si la
// columna todavia no existe (backend publicado antes que la migracion), se
// lee NULL y la pantalla sigue mostrando la IP, como hasta ahora.
async function leer(db, columnas, resto, params) {
  const sql = (conNombre) => `SELECT id, ${columnas}, ${conNombre ? 'nombre' : 'NULL AS nombre'} FROM agent_sync_status ${resto}`;
  try {
    return (await db.query(sql(true), params))[0];
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    return (await db.query(sql(false), params))[0];
  }
}

async function getSyncStatusForTenant(tenantId, db) {
  return leer(db, 'machine_ip, machine_sn, last_synced_at, last_checktime, fichajes_ultima_subida',
    'WHERE tenant_id = ? ORDER BY last_synced_at DESC', [tenantId]);
}

async function getAllSyncStatus(db) {
  return leer(db, 'tenant_id, machine_ip, machine_sn, last_synced_at, last_checktime, fichajes_ultima_subida',
    'ORDER BY last_synced_at DESC', []);
}

// Cambia el nombre de UN reloj. `tenantId` null = superadmin (cualquiera).
// Devuelve false si ese reloj no existe o no es de esa empresa.
async function renombrar(db, { id, tenantId, nombre }) {
  const [r] = await db.query(
    `UPDATE agent_sync_status SET nombre = ? WHERE id = ? ${tenantId == null ? '' : 'AND tenant_id = ?'}`,
    tenantId == null ? [nombre, id] : [nombre, id, tenantId]);
  return r.affectedRows > 0 || (await db.query(
    `SELECT id FROM agent_sync_status WHERE id = ? ${tenantId == null ? '' : 'AND tenant_id = ?'}`,
    tenantId == null ? [id] : [id, tenantId]))[0].length > 0;
}

module.exports = { upsertSyncStatus, getSyncStatusForTenant, getAllSyncStatus, renombrar };
