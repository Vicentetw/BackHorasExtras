-- Fase 18: agente de sincronizacion de relojes biometricos (descarga-fichaje-py).
-- Pedido real: automatizar la descarga de fichajes desde muchos relojes ZK
-- (con o sin clave) corriendo desatendido en la PC de cada sitio (pensado
-- para un gobierno con muchas escuelas/entidades, cada una un tenant), con
-- cola local y reintento cuando el servidor no esta disponible.
--
-- El agente no puede usar login de Firebase (proceso desatendido, sin
-- sesion humana) -- necesita una credencial de maquina propia, por tenant,
-- generable/pausable/revocable desde Facturacion (superadmin). Solo se
-- guarda el HASH de la clave -- el valor real se muestra UNA sola vez al
-- generarla, igual que un token de GitHub/Stripe.
CREATE TABLE IF NOT EXISTS tenant_agent_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  label VARCHAR(150) NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  status ENUM('active','paused','revoked') NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL,
  CONSTRAINT fk_tenant_agent_keys_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_tenant_agent_keys_user FOREIGN KEY (created_by) REFERENCES app_users(id),
  UNIQUE KEY uq_tenant_agent_keys_prefix (key_prefix)
);

SELECT 'tenant_agent_keys aplicada correctamente' AS resultado;
