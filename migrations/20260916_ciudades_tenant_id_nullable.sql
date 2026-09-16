-- Bug real reportado: crear una ciudad como superadmin (sin una empresa
-- puntual seleccionada, ver resolveTenantId en appUserMiddleware.js) tira
-- 500 -- ciudades.tenant_id quedo NOT NULL, pero el resto del sistema
-- (holidays, event_types) ya usa tenant_id NULL = "global, solo lo carga
-- un superadmin" para este mismo caso. Se alinea al mismo criterio.
SET @is_nullable = (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ciudades' AND COLUMN_NAME = 'tenant_id'
);
SET @sql = IF(@is_nullable = 'NO',
  'ALTER TABLE ciudades MODIFY COLUMN tenant_id INT NULL',
  'SELECT "ciudades.tenant_id ya es nullable"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sucursales' AND COLUMN_NAME = 'tenant_id'
);
SET @sql = IF(@is_nullable = 'NO',
  'ALTER TABLE sucursales MODIFY COLUMN tenant_id INT NULL',
  'SELECT "sucursales.tenant_id ya es nullable"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'ciudades/sucursales tenant_id nullable aplicada correctamente' AS resultado;
