-- Etapa 8 del plan "Motor de reglas de asistencia configurable" (ver
-- fases para impletentar avance.txt). Tabla nueva: reemplaza cualquier
-- "if holiday => 100" hardcodeado por una fila de datos. Sin ninguna fila
-- cargada, el comportamiento es identico a hoy (ningun feriado/franco/fin
-- de semana obtiene una tasa especial de forma automatica -- la relacion
-- tiene que venir de la configuracion, nunca del codigo).
--
-- tenant_id/convention_id/template_id NULL = regla mas general posible
-- (global). Cuando hay varias reglas candidatas para el mismo dia+trigger,
-- gana la mas especifica (template > convenio > tenant > global) --
-- resuelto en motor-laboral/services/dayTypeRuleResolver.js, no en SQL.
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'day_type_overtime_rules'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE day_type_overtime_rules (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NULL,
    convention_id INT NULL,
    template_id INT NULL,
    day_type ENUM('WORKDAY','SATURDAY','SUNDAY','REST_DAY','HOLIDAY','SPECIAL') NOT NULL,
    trigger_type ENUM('BEFORE_SCHEDULE','AFTER_SCHEDULE','ALL_DAY') NOT NULL,
    classification_type VARCHAR(30) NOT NULL DEFAULT 'OVERTIME',
    rate DECIMAL(5,2) NULL,
    requires_authorization TINYINT(1) NOT NULL DEFAULT 1,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_day_type_rules_tenant (tenant_id),
    KEY idx_day_type_rules_convention (convention_id),
    KEY idx_day_type_rules_template (template_id),
    KEY idx_day_type_rules_lookup (day_type, trigger_type, active),
    CONSTRAINT fk_day_type_rules_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_day_type_rules_convention FOREIGN KEY (convention_id) REFERENCES labor_conventions(id),
    CONSTRAINT fk_day_type_rules_template FOREIGN KEY (template_id) REFERENCES work_schedule_templates(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "day_type_overtime_rules ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'day_type_overtime_rules (Etapa 8) aplicada correctamente' AS resultado;
