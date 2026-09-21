-- ============================================================================
-- companyschedule por empresa (bloqueante para vender a un segundo cliente)
-- ============================================================================
--
-- QUE PASABA
-- ----------
-- `companyschedule` guarda el horario por defecto de la empresa para una
-- fecha (entrada, salida, si es dia laborable). NO tenia `tenant_id`, y su
-- clave unica era `scheduleDate` A SECAS. O sea:
--
--   * el horario que cargaba la empresa A lo veia y lo usaba la empresa B;
--   * y peor: como la fecha era unica GLOBALMENTE, si A guardaba el horario
--     del 15/03, B no podia tener uno distinto para ese dia. El
--     `ON DUPLICATE KEY UPDATE` del endpoint le PISABA el horario a A.
--
-- No es cosmetico: `/attendance-range` usa esta tabla como respaldo cuando
-- una empresa no tiene plantilla asignada (ver "companyScheduleByDate" en
-- horasdedica.js). Es decir que alimenta directamente el calculo de
-- asistencia y de horas extra. Con un solo cliente no se notaba; con dos,
-- una empresa le cambia las liquidaciones a la otra.
--
-- QUE HACE ESTA MIGRACION
-- -----------------------
--   1. agrega `tenant_id INT NULL`;
--   2. cambia la clave unica de (scheduleDate) a (tenant_id, scheduleDate);
--   3. deja las filas existentes con `tenant_id = NULL`.
--
-- POR QUE NULL Y NO ASIGNARLAS A UNA EMPRESA
-- ------------------------------------------
-- Esas filas no tienen NINGUN dato que diga de quien son -- la columna nunca
-- existio. Inventarles un dueño seria adivinar. `NULL` significa "valor por
-- defecto global", el mismo criterio que ya usa `app_settings` en este
-- proyecto (ver appSettingsRepository.js): se busca primero la fila de la
-- empresa y, si no hay, se usa la global. Asi el comportamiento de hoy no
-- cambia para nadie, y a partir de ahora cada empresa que guarde un horario
-- se lleva su propia fila.
--
-- Aditiva e idempotente, con las mismas guardas de information_schema que
-- el resto de las migraciones del repo.
-- ============================================================================

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companyschedule' AND COLUMN_NAME = 'tenant_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE companyschedule ADD COLUMN tenant_id INT NULL AFTER id',
  'SELECT "companyschedule.tenant_id ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La clave vieja: unica por fecha, sin empresa. Es LA que impide que dos
-- empresas tengan horario para el mismo dia, asi que hay que sacarla.
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companyschedule' AND INDEX_NAME = 'scheduleDate'
);
SET @sql = IF(@idx_exists > 0,
  'ALTER TABLE companyschedule DROP INDEX scheduleDate',
  'SELECT "la clave unica vieja ya no esta"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La clave nueva. Sigue evitando dos filas para la misma empresa y fecha
-- (que es lo que el ON DUPLICATE KEY UPDATE del endpoint necesita), pero
-- ahora cada empresa tiene su propio espacio.
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companyschedule' AND INDEX_NAME = 'uq_companyschedule_tenant_date'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE companyschedule ADD UNIQUE KEY uq_companyschedule_tenant_date (tenant_id, scheduleDate)',
  'SELECT "uq_companyschedule_tenant_date ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT
  'companyschedule ahora es por empresa' AS resultado,
  (SELECT COUNT(*) FROM companyschedule) AS filas_totales,
  (SELECT COUNT(*) FROM companyschedule WHERE tenant_id IS NULL) AS filas_globales_por_defecto;
