-- Fase 15: tope de empleados por plan ("como una telefonia" -- pedido real
-- del superadmin al encontrar que un tenant pudo cargar mas empleados de
-- los que su plan de prueba permitia, sin ningun aviso ni bloqueo).
--
-- NULL = sin limite (comportamiento actual, nadie se bloquea de golpe con
-- esta migracion salvo el plan que se ajusta a mano abajo).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plans' AND COLUMN_NAME = 'max_employees'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE plans ADD COLUMN max_employees INT NULL AFTER min_billed_employees',
  'SELECT "plans.max_employees ya existe"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Tope sugerido para el unico plan que existe hoy ("Plan estandar"): el
-- doble de min_billed_employees (5 -> 10). Es un punto de partida, se
-- edita en un click desde Planes en cualquier momento.
UPDATE plans SET max_employees = 10 WHERE id = 1 AND max_employees IS NULL;

SELECT 'Fase 15 (tope de empleados por plan) aplicada correctamente' AS resultado;
