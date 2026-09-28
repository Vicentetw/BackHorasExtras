-- ============================================================================
-- Correccion manual de a quien pertenece un marcador (con auditoria)
-- ============================================================================
--
-- EL PROBLEMA
-- -----------
-- Un marcador (el "usuario ficticio" 5, 6, 7, 8, 9, 10 del reloj) no dice de
-- quien es: nadie se identifica al apretarlo. El sistema lo ADIVINA: se lo
-- da al proximo fichaje real del mismo reloj dentro de unos segundos (ver
-- detectMovements en motor-laboral/services/movementsCalculations.js).
--
-- Casi siempre acierta, pero no siempre: si justo entre el marcador y el
-- dedo de la persona se mete otra, la salida (o la hora extra, o la campaña)
-- se la lleva la otra. Pedido real del 2026-09-28: "poder corregir a mano a
-- quien se atribuyo un marcador, y que quede registrado quien lo corrigio y
-- cuando".
--
-- LAS DOS TABLAS (mismo criterio que manual_entry_log, ver auditLog.js)
-- ---------------------------------------------------------------------
-- 1. `marker_corrections`: el ESTADO ACTUAL. Una fila por marcador corregido.
--    Es lo que lee el motor. Si se deshace la correccion, la fila se borra y
--    el marcador vuelve a atribuirse solo, como siempre.
-- 2. `marker_correction_log`: el HISTORIAL. Solo se inserta, nunca se
--    modifica ni se borra. Guarda cada alta, cambio y deshacer, con quien lo
--    hizo, cuando, el motivo y como estaba antes. Sin esto, deshacer una
--    correccion borraria todo rastro de que existio.
--
-- COMO SE IDENTIFICA UN MARCADOR
-- ------------------------------
-- Por (empresa, USERID del marcador, hora exacta del fichaje), no por
-- Checkins.id. El id es un detalle interno de la base: si algun dia los
-- fichajes se vuelven a importar, cambia. La hora exacta y el USERID son el
-- dato del reloj, y dos marcadores iguales en el mismo segundo no existen.
--
-- `assigned_employee_id` es el LEGAJO (employees.employee_id), el mismo dato
-- con el que trabaja el motor. NULL significa "no era de nadie": se apreto
-- por error y hay que ignorarlo.
--
-- ES SEGURA DE CORRER: solo crea dos tablas nuevas, no toca nada existente.
-- Idempotente (se puede correr dos veces).
-- ============================================================================

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marker_corrections'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE marker_corrections (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    marker_user_id INT NOT NULL,
    marker_time DATETIME NOT NULL,
    machine_ip VARCHAR(64) NULL,
    assigned_employee_id INT NULL,
    previous_employee_id INT NULL,
    reason VARCHAR(255) NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT NULL,
    updated_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_marker_corrections_marker (tenant_id, marker_user_id, marker_time),
    KEY idx_marker_corrections_time (tenant_id, marker_time),
    CONSTRAINT fk_marker_corrections_created_by FOREIGN KEY (created_by) REFERENCES app_users(id),
    CONSTRAINT fk_marker_corrections_updated_by FOREIGN KEY (updated_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "marker_corrections ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- `correction_id` sin foreign key a proposito: al deshacer una correccion su
-- fila se borra, y el log tiene que sobrevivir (es justamente lo que mas
-- importa auditar). Mismo criterio que manual_entry_log.entry_id.
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marker_correction_log'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE marker_correction_log (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    correction_id INT NOT NULL,
    action ENUM('created','updated','deleted') NOT NULL,
    marker_user_id INT NOT NULL,
    marker_time DATETIME NOT NULL,
    assigned_employee_id INT NULL,
    previous_employee_id INT NULL,
    reason VARCHAR(255) NULL,
    previous_data JSON NULL,
    performed_by INT NULL,
    performed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_marker_correction_log_tenant (tenant_id, performed_at),
    KEY idx_marker_correction_log_correction (correction_id),
    CONSTRAINT fk_marker_correction_log_performed_by FOREIGN KEY (performed_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "marker_correction_log ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'marker_corrections y marker_correction_log creadas correctamente' AS resultado;
