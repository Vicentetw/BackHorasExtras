-- Etapa 12 del plan "Motor de reglas de asistencia configurable" (ver
-- fases para impletentar avance.txt). Modo de comparacion/sombra: correr
-- Legacy y el motor nuevo en paralelo SIN cambiar el resultado oficial.
--
-- rules_engine_mode: NOT NULL DEFAULT 'legacy' -- TODA plantilla existente
-- queda en 'legacy' sin ningun cambio de comportamiento. Es a la vez el
-- feature flag y el mecanismo de rollback instantaneo (ver Etapa 4 del
-- plan): volver una plantilla a 'legacy' apaga el motor nuevo para ella
-- sin migracion ni deploy. 'active' se deja definido en el ENUM para no
-- tener que migrar de nuevo en la Etapa 14, pero todavia NINGUN endpoint
-- lo interpreta -- por ahora solo 'legacy'/'shadow' tienen efecto.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'rules_engine_mode'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE work_schedule_templates ADD COLUMN rules_engine_mode ENUM('legacy','shadow','active') NOT NULL DEFAULT 'legacy' AFTER politica_salida_posterior",
  'SELECT "work_schedule_templates.rules_engine_mode ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Diferencias encontradas entre Legacy y el motor nuevo para un
-- empleado+fecha+campo puntual, solo para plantillas en modo 'shadow' --
-- se pueden revisar sin tener que reproducir el calculo a mano. No se
-- inserta una fila cuando no hubo diferencia (evita ruido). legacy_value/
-- new_value en JSON porque algunos campos comparados (incidents) son
-- listas, no un numero solo.
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rule_engine_shadow_diffs'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE rule_engine_shadow_diffs (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NULL,
    employee_id INT NOT NULL,
    date DATE NOT NULL,
    template_id INT NULL,
    field VARCHAR(30) NOT NULL,
    legacy_value JSON NULL,
    new_value JSON NULL,
    diff_type ENUM('EXPECTED','NEW_FEATURE','UNEXPECTED','POSSIBLE_REGRESSION') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_shadow_diffs_tenant_date (tenant_id, date),
    KEY idx_shadow_diffs_employee_date (employee_id, date),
    KEY idx_shadow_diffs_type (diff_type),
    CONSTRAINT fk_shadow_diffs_employee FOREIGN KEY (employee_id) REFERENCES employees(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "rule_engine_shadow_diffs ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'rules_engine_mode + rule_engine_shadow_diffs (Etapa 12) aplicadas correctamente' AS resultado;
