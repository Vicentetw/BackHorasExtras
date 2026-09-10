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

async function getSyncStatusForTenant(tenantId, db) {
  const [rows] = await db.query(
    `SELECT machine_ip, machine_sn, last_synced_at, last_checktime, fichajes_ultima_subida
     FROM agent_sync_status WHERE tenant_id = ? ORDER BY last_synced_at DESC`,
    [tenantId]
  );
  return rows;
}

// El superadmin no pertenece a ninguna empresa (tenant_id NULL) -- sin
// esto, no veia NUNCA el estado de sincronizacion de ningun reloj. Como
// operador de la plataforma tiene sentido que vea el de todas (hoy, una).
async function getAllSyncStatus(db) {
  const [rows] = await db.query(
    `SELECT tenant_id, machine_ip, machine_sn, last_synced_at, last_checktime, fichajes_ultima_subida
     FROM agent_sync_status ORDER BY last_synced_at DESC`
  );
  return rows;
}

module.exports = { upsertSyncStatus, getSyncStatusForTenant, getAllSyncStatus };
