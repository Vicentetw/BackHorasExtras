-- Pedido real: Vialidad tiene sedes en varias ciudades y cada una tiene su
-- propio "Dia de la Ciudad" -- un feriado que aplica SOLO a los empleados de
-- esa ciudad, no a toda la empresa. Hoy `holidays` no tiene forma de acotar
-- un feriado a una ciudad puntual. ciudad_id NULL = toda la empresa (default,
-- cero cambio de comportamiento para los feriados que ya existen).
--
-- Se reemplaza el unique key `uq_holiday_tenant_date (tenant_id, date)` por
-- un indice normal: con `ciudad_id` de por medio puede haber mas de un
-- feriado el mismo dia (uno global + uno de una ciudad puntual, o dos
-- ciudades distintas que coinciden en fecha) -- y NULL no es comparable de
-- forma confiable en un unique key de MySQL para evitar duplicados del caso
-- sin ciudad. La validacion de duplicados (mismo tenant+fecha+ciudad) queda
-- en el propio endpoint (routes/holidays.js), no en el esquema.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND COLUMN_NAME = 'ciudad_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE holidays ADD COLUMN ciudad_id INT NULL AFTER tenant_id',
  'SELECT "holidays.ciudad_id ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND CONSTRAINT_NAME = 'fk_holidays_ciudad'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE holidays ADD CONSTRAINT fk_holidays_ciudad FOREIGN KEY (ciudad_id) REFERENCES ciudades(id)',
  'SELECT "fk_holidays_ciudad ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @old_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND INDEX_NAME = 'uq_holiday_tenant_date'
);
SET @sql = IF(@old_index_exists > 0,
  'DROP INDEX uq_holiday_tenant_date ON holidays',
  'SELECT "uq_holiday_tenant_date ya no existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @new_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND INDEX_NAME = 'idx_holiday_tenant_date'
);
SET @sql = IF(@new_index_exists = 0,
  'CREATE INDEX idx_holiday_tenant_date ON holidays (tenant_id, date)',
  'SELECT "idx_holiday_tenant_date ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'holidays.ciudad_id aplicada correctamente' AS resultado;
