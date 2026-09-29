-- ============================================================================
-- Regimenes DENTRO de un convenio
-- ============================================================================
--
-- Modelo acordado con el dueño del producto (2026-09-29):
--
--   Empresa      -> puede tener VARIOS convenios (ej. camioneros, comercio)
--    └ Convenio  -> el marco comun (en Vialidad hay uno solo)
--      └ Regimen -> la variante dentro del convenio ("con horas extra",
--                   "sin horas extra: solo se registra", "dedicacion"...)
--        └ Persona (autorizacion individual)
--
-- Cada regla (recargo por tipo de dia, topes y politica de excedente) vale en
-- el nivel MAS ESPECIFICO en que este cargada: persona > regimen > convenio >
-- empresa. Lo comun se carga una vez en el convenio y el regimen cambia solo
-- lo distinto.
--
-- No confundir con employee_convention_assignments.category_id: esa es la
-- CATEGORIA laboral (escalafon/puesto), otro concepto.
--
-- Todo aditivo: columnas nuevas NULL (NULL = "a nivel convenio", como hoy).
-- Sin regimenes cargados, nada cambia. Idempotente.
-- ============================================================================

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'labor_convention_regimes'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE labor_convention_regimes (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    convention_id INT NOT NULL,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(500) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_convention_regime_name (convention_id, name),
    KEY idx_convention_regimes_tenant (tenant_id),
    CONSTRAINT fk_convention_regimes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_convention_regimes_convention FOREIGN KEY (convention_id) REFERENCES labor_conventions(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "labor_convention_regimes ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- regime_id en: la asignacion de cada persona, las reglas por tipo de dia y
-- las politicas de topes. NULL = nivel convenio (lo de siempre).
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_convention_assignments' AND COLUMN_NAME = 'regime_id');
SET @sql = IF(@c = 0, 'ALTER TABLE employee_convention_assignments ADD COLUMN regime_id INT NULL AFTER convention_id', 'SELECT "employee_convention_assignments.regime_id ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'day_type_overtime_rules' AND COLUMN_NAME = 'regime_id');
SET @sql = IF(@c = 0, 'ALTER TABLE day_type_overtime_rules ADD COLUMN regime_id INT NULL AFTER convention_id', 'SELECT "day_type_overtime_rules.regime_id ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- En overtime_regime_policies el regime_id entra en la clave unica: una
-- politica por (empresa, convenio, regimen, fecha).
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'overtime_regime_policies' AND COLUMN_NAME = 'regime_id');
SET @sql = IF(@c = 0,
  'ALTER TABLE overtime_regime_policies
     ADD COLUMN regime_id INT NULL AFTER convention_id,
     ADD COLUMN regime_key INT AS (IFNULL(regime_id, 0)) STORED AFTER regime_id,
     DROP INDEX uq_overtime_regime_policies_vigencia,
     ADD UNIQUE KEY uq_overtime_regime_policies_vigencia (tenant_id, convention_key, regime_key, vigente_desde)',
  'SELECT "overtime_regime_policies.regime_id ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'regimenes dentro del convenio: listo' AS resultado;
