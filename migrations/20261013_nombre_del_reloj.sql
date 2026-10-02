-- ============================================================================
-- Nombre de cada reloj
-- ============================================================================
--
-- En Presentismo, el aviso "hasta cuando esta actualizado cada reloj" mostraba
-- la direccion IP ("172.155.0.30: actualizado hace 2 h"). A quien usa el
-- sistema una IP no le dice nada, y no queda bien en una pantalla que se le
-- muestra a un cliente.
--
--   agent_sync_status.nombre   como lo llama la empresa ("Reloj recepcion",
--                              "Obra Ruta 3"). Opcional: sin nombre se sigue
--                              mostrando la IP, como hasta ahora.
--
-- Aditivo e idempotente. El agente que sube los fichajes no lo toca.
-- ============================================================================

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sync_status' AND COLUMN_NAME = 'nombre');
SET @sql = IF(@c = 0, 'ALTER TABLE agent_sync_status ADD COLUMN nombre VARCHAR(80) NULL', 'SELECT "agent_sync_status.nombre ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT id, tenant_id, machine_ip, nombre FROM agent_sync_status ORDER BY tenant_id, id;
