-- Etapa 6 del plan "Motor de reglas de asistencia configurable" (ver
-- fases para impletentar avance.txt). Columnas nuevas, TODAS nullable --
-- NULL = comportamiento actual sin cambios (ninguna plantilla existente
-- ve un cambio de comportamiento con esta migracion). Todavia no las lee
-- ningun endpoint -- ver motor-laboral/services/toleranceResolver.js,
-- que por ahora es un modulo puro sin conectar a /attendance-range.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'tolerancia_entrada_minutos'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE work_schedule_templates ADD COLUMN tolerancia_entrada_minutos INT NULL AFTER overtime_cap_minutes',
  'SELECT "work_schedule_templates.tolerancia_entrada_minutos ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'tolerancia_salida_anticipada_minutos'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE work_schedule_templates ADD COLUMN tolerancia_salida_anticipada_minutos INT NULL AFTER tolerancia_entrada_minutos',
  'SELECT "work_schedule_templates.tolerancia_salida_anticipada_minutos ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'politica_llegada_anticipada'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE work_schedule_templates ADD COLUMN politica_llegada_anticipada ENUM('NO_COMPUTAR','TIEMPO_TRABAJADO','EXTRA_SI_AUTORIZADO','REGISTRAR_SIN_EXTRA') NULL AFTER tolerancia_salida_anticipada_minutos",
  'SELECT "work_schedule_templates.politica_llegada_anticipada ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'politica_salida_posterior'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE work_schedule_templates ADD COLUMN politica_salida_posterior ENUM('NO_COMPUTAR','TIEMPO_TRABAJADO','EXTRA_SI_AUTORIZADO','REGISTRAR_SIN_EXTRA') NULL AFTER politica_llegada_anticipada",
  'SELECT "work_schedule_templates.politica_salida_posterior ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'work_schedule_templates: columnas de tolerancia (Etapa 6) aplicadas correctamente' AS resultado;
