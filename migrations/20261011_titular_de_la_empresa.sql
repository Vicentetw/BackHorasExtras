-- ============================================================================
-- Titular de la empresa: el unico que puede pedir la baja
-- ============================================================================
--
-- Pedido del dueño del producto (2026-09-30): "el unico que puede pedir la
-- baja es el administrador de la empresa con el email registrado".
--
-- Antes, cualquier usuario de la empresa podia pedir la baja del servicio
-- (routes/billing.js solo chequeaba que fuera de la misma empresa).
--
--   tenants.titular_email   el mail de la cuenta titular. Solo esa cuenta
--                           (y el superadmin) puede pedir la baja o retirar
--                           el pedido. NULL = sin titular registrado: nadie
--                           de la empresa puede pedirla hasta que el
--                           superadmin lo cargue (en Empresas).
--
-- Se completa solo para las empresas dadas de alta por el formulario publico
-- (el mail con que se registraron, signup_leads). Las creadas a mano (AVP)
-- quedan en NULL: el superadmin carga el mail desde Empresas.
-- Idempotente.
-- ============================================================================

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'titular_email');
SET @sql = IF(@c = 0, 'ALTER TABLE tenants ADD COLUMN titular_email VARCHAR(255) NULL', 'SELECT "tenants.titular_email ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- El mail con que se registro cada empresa (el primer alta que la creo).
UPDATE tenants t
JOIN (
  SELECT l.tenant_id, l.email
  FROM signup_leads l
  JOIN (SELECT tenant_id, MIN(id) AS primero FROM signup_leads WHERE status = 'provisioned' AND tenant_id IS NOT NULL GROUP BY tenant_id) p
    ON p.primero = l.id
) r ON r.tenant_id = t.id
SET t.titular_email = LOWER(r.email)
WHERE t.titular_email IS NULL;

SELECT id, name, titular_email FROM tenants ORDER BY id;
