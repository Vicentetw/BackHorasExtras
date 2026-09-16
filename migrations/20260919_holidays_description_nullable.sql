-- Bug real encontrado al probar el feature de feriados por ciudad: crear un
-- feriado sin descripcion (el dialogo de Angular la trata como opcional,
-- "Descripcion opcional", sin required) tira 500 -- holidays.description es
-- VARCHAR(200) NOT NULL, unica columna "description" de todo el esquema con
-- esa restriccion (companyschedule, ManualEntries, employee_categories,
-- roles, work_schedule_templates: todas nullable). routes/holidays.js ya
-- convierte '' a null (`description || null`) antes de insertar, por eso
-- rompia con NOT NULL en vez de guardar vacio.
SET @is_nullable = (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND COLUMN_NAME = 'description'
);
SET @sql = IF(@is_nullable = 'NO',
  'ALTER TABLE holidays MODIFY COLUMN description VARCHAR(200) NULL',
  'SELECT "holidays.description ya es nullable"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'holidays.description nullable aplicada correctamente' AS resultado;
