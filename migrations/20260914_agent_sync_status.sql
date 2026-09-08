-- Fase 18 (continuacion) -- pedido real del superadmin: saber desde el
-- sistema (no solo mirando "ultimo uso" de la clave) cuando sincronizo
-- CADA reloj puntual la ultima vez, para que en Presentismo/Asistencia
-- se sepa hasta que momento estan actualizados los datos de cada uno.
--
-- No puede vivir en Checkins (esa tabla no tiene tenant_id, ver el
-- comentario historico en horasdedica2.js) -- esta tabla si lo tiene,
-- tomado directamente de la clave de agente usada (routes/agent.js), que
-- es la unica fuente confiable de "a que empresa pertenece este reloj".
CREATE TABLE IF NOT EXISTS agent_sync_status (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  machine_ip VARCHAR(45) NULL,
  machine_sn VARCHAR(45) NULL,
  last_synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checktime DATETIME NULL,
  fichajes_ultima_subida INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_agent_sync_status_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE KEY uq_agent_sync_status_machine (tenant_id, machine_ip, machine_sn)
);

SELECT 'agent_sync_status aplicada correctamente' AS resultado;
