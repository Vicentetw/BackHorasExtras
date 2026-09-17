-- Pedido real: fichaje manual (no le tomó la huella, corte de luz, reloj
-- descompuesto) -- se inserta directo en Checkins (misma tabla que leen los
-- 3 motores de asistencia) en vez de una tabla paralela, para que un
-- fichaje manual corrija entrada/salida/tardanza automaticamente sin tocar
-- ninguna logica de calculo. Las columnas nuevas son solo metadata de
-- auditoria -- source/motivo/created_by -- ningun motor las lee hoy, asi
-- que esto es 100% aditivo (cero cambio de comportamiento para los
-- fichajes de reloj que ya existen, que quedan con source='device').
--
-- OJO deliberado: NO se agrega un `deleted_at` (soft delete) en Checkins.
-- Hay ~15 lugares en el codigo que hacen SELECT ... FROM Checkins sin
-- pasar por un repositorio comun -- exigir que todos empiecen a filtrar
-- `deleted_at IS NULL` es el mismo patron de bug que ya paso 3 veces esta
-- sesion (un motor se olvida un filtro que los otros si tienen). En vez de
-- eso, borrar un fichaje manual hace un DELETE real (ver routes nuevas),
-- y `manual_checkin_log` (mas abajo) guarda una copia completa ANTES de
-- borrar -- se pierde la fila de Checkins (como corresponde, ya no debe
-- contar para el calculo) pero nunca el rastro de auditoria.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND COLUMN_NAME = 'source'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE Checkins ADD COLUMN source ENUM('device','manual') NOT NULL DEFAULT 'device' AFTER MACHINE_SN",
  'SELECT "Checkins.source ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND COLUMN_NAME = 'motivo_categoria'
);
SET @sql = IF(@col_exists = 0,
  "ALTER TABLE Checkins ADD COLUMN motivo_categoria ENUM('corte_luz','reloj_descompuesto','no_tomo_huella','otro') NULL AFTER source",
  'SELECT "Checkins.motivo_categoria ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND COLUMN_NAME = 'motivo_detalle'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE Checkins ADD COLUMN motivo_detalle VARCHAR(255) NULL AFTER motivo_categoria',
  'SELECT "Checkins.motivo_detalle ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND COLUMN_NAME = 'created_by'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE Checkins ADD COLUMN created_by INT NULL AFTER motivo_detalle',
  'SELECT "Checkins.created_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND COLUMN_NAME = 'created_at'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE Checkins ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP AFTER created_by',
  'SELECT "Checkins.created_at ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND CONSTRAINT_NAME = 'fk_checkins_created_by'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE Checkins ADD CONSTRAINT fk_checkins_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)',
  'SELECT "fk_checkins_created_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND INDEX_NAME = 'idx_checkins_source'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_checkins_source ON Checkins (tenant_id, source)',
  'SELECT "idx_checkins_source ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Log de auditoria append-only: una fila por alta y por baja de un fichaje
-- manual, con una copia completa de los datos (sobrevive al DELETE real de
-- Checkins). employee_id es el legajo (employees.employee_id), no el id
-- interno, para que el registro siga siendo legible aunque el empleado se
-- borre despues.
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manual_checkin_log'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE manual_checkin_log (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    employee_id INT NOT NULL,
    checkin_userid INT NOT NULL,
    checktime DATETIME NOT NULL,
    motivo_categoria ENUM('corte_luz','reloj_descompuesto','no_tomo_huella','otro') NULL,
    motivo_detalle VARCHAR(255) NULL,
    action ENUM('created','deleted') NOT NULL,
    performed_by INT NULL,
    performed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_manual_checkin_log_tenant (tenant_id),
    KEY idx_manual_checkin_log_employee (employee_id),
    CONSTRAINT fk_manual_checkin_log_performed_by FOREIGN KEY (performed_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "manual_checkin_log ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Checkins: columnas de auditoria + manual_checkin_log aplicadas correctamente' AS resultado;
