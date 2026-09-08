-- Bug real de seguridad (auditoria general): staging_employees (donde
-- queda "flotando" un import de Excel antes de confirmarlo) no tenia
-- ninguna columna que dijera de que empresa era cada lote -- el
-- batchId es solo Date.now().toString() (milisegundos), sin dueño
-- registrado en ningun lado. GET /employees/preview/:batchId y
-- POST /employees/confirm/:batchId no podian verificar "¿este lote es
-- tuyo?" porque ese dato no existia. Ver routes/import.routes.js.
--
-- NULL = lotes viejos, de antes de esta migracion (quedan visibles solo
-- para superadmin, igual que el resto del sistema trata tenant_id NULL).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staging_employees' AND COLUMN_NAME = 'tenant_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE staging_employees ADD COLUMN tenant_id INT NULL AFTER import_batch_id',
  'SELECT "staging_employees.tenant_id ya existe"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migracion staging_employees.tenant_id aplicada correctamente' AS resultado;
