-- ============================================================================
-- Regimen de horas extra: topes, politica de excedente, autorizacion
-- individual y aprobaciones (bloque B1)
-- ============================================================================
--
-- Diseño completo: HORAS_EXTRA_REGIMENES.md. El calculo que usa estas tablas
-- es motor-laboral/services/horasExtraRegimen.js (puro, con tests).
--
-- QUE YA EXISTIA Y SE REUTILIZA (no se toca)
--   labor_conventions                -> el REGIMEN ("Horas extra", "Administrativo")
--   employee_convention_assignments  -> que regimen tiene cada persona, con vigencia
--   day_type_overtime_rules          -> por tipo de dia: EXTRA (con recargo) /
--                                       EXTRA_SI_AUTORIZADO / REGISTRAR / NO_COMPUTAR
--                                       (classification_type es texto: no hace
--                                       falta migrarlo)
--
-- QUE AGREGA ESTA MIGRACION
--   overtime_regime_policies         -> topes dia/mes/año + politica de excedente
--                                       + fuente + minimo + redondeo, por regimen
--                                       (o por empresa: convention_id NULL), con
--                                       vigencia (un convenio cambia los topes)
--   employee_overtime_authorizations -> "esta persona puede hasta N h/mes desde
--                                       tal fecha": REEMPLAZA el tope del regimen
--                                       para esa persona (una autorizacion existe
--                                       justamente para dar mas o menos horas)
--   overtime_excess_approvals        -> minutos de excedente aprobados a mano en
--                                       un mes (politica AUTORIZAR), con motivo
--
-- Nombre: overtime_regime_policies y no overtime_policies, porque esa ya
-- existe (esquema inicial del motor laboral), vacia y sin uso: no se toca.
--
-- Sin filas en estas tablas NO CAMBIA NADA: el calculo sigue siendo el de hoy.
-- Todos los minutos son minutos (un tope de 40 h = 2400).
--
-- ES SEGURA DE CORRER: solo crea tablas nuevas. Idempotente.
-- ============================================================================

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'overtime_regime_policies'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE overtime_regime_policies (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    convention_id INT NULL,
    convention_key INT AS (IFNULL(convention_id, 0)) STORED,
    vigente_desde DATE NOT NULL,
    tope_dia_minutos INT NULL,
    tope_mes_minutos INT NULL,
    tope_anio_minutos INT NULL,
    politica_excedente ENUM('TAL_CUAL','AVISAR','NO_COMPUTAR','AUTORIZAR') NOT NULL DEFAULT 'AVISAR',
    fuente ENUM('MARCADORES','FICHAJES','MARCADORES_O_ESTIMADO') NOT NULL DEFAULT 'MARCADORES_O_ESTIMADO',
    minimo_minutos INT NULL,
    redondeo_minutos INT NULL,
    redondeo_modo ENUM('ABAJO','CERCANO','ARRIBA') NOT NULL DEFAULT 'ABAJO',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_overtime_regime_policies_vigencia (tenant_id, convention_key, vigente_desde),
    KEY idx_overtime_regime_policies_convention (convention_id),
    CONSTRAINT fk_overtime_regime_policies_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_overtime_regime_policies_convention FOREIGN KEY (convention_id) REFERENCES labor_conventions(id),
    CONSTRAINT fk_overtime_regime_policies_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "overtime_regime_policies ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_overtime_authorizations'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE employee_overtime_authorizations (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    employee_id INT NOT NULL,
    tope_dia_minutos INT NULL,
    tope_mes_minutos INT NULL,
    tope_anio_minutos INT NULL,
    vigente_desde DATE NOT NULL,
    vigente_hasta DATE NULL,
    motivo VARCHAR(255) NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_overtime_auth_employee (tenant_id, employee_id, vigente_desde),
    CONSTRAINT fk_overtime_auth_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_overtime_auth_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_overtime_auth_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "employee_overtime_authorizations ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'overtime_excess_approvals'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE overtime_excess_approvals (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    employee_id INT NOT NULL,
    periodo CHAR(7) NOT NULL,
    minutos INT NOT NULL,
    motivo VARCHAR(255) NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_overtime_approvals_periodo (tenant_id, employee_id, periodo),
    CONSTRAINT fk_overtime_approvals_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_overtime_approvals_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_overtime_approvals_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "overtime_excess_approvals ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'overtime_regime_policies, employee_overtime_authorizations y overtime_excess_approvals creadas' AS resultado;
