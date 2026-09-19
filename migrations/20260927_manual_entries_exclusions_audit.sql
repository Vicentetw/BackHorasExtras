-- ============================================================================
-- Auditoria de ManualEntries y userexclusions (+ tenant_id en ManualEntries)
-- ============================================================================
--
-- QUE RESUELVE ESTO (dos cosas que resultaron ser una sola):
--
-- 1) AUDITORIA. Hoy, si alguien carga 8 horas extra a mano para un empleado,
--    o marca un dia como Vacaciones, en la base queda el DATO pero no queda
--    QUIEN lo hizo ni CUANDO. Si manana hay un reclamo ("yo no pedi esa
--    licencia", "estas horas no las autorice nadie"), no hay forma de
--    responderlo: la fila existe y punto. Los fichajes manuales SI tienen
--    esto desde la migracion 20260920 (tabla `manual_checkin_log`), y esta
--    migracion le da el mismo tratamiento a las otras dos cosas que se
--    cargan a mano y que impactan directamente en la plata:
--      - ManualEntries  -> horas extra manuales, licencias, dias omitidos
--      - userexclusions -> exclusiones/licencias por dia o por rango
--
-- 2) AISLAMIENTO ENTRE EMPRESAS. Al escribir el punto 1 aparecio un agujero
--    real: `ManualEntries` NO TIENE `tenant_id`. Ninguno de sus 4 endpoints
--    (GET/POST/PUT/DELETE en horasdedica.js) filtra ni valida por empresa.
--    Eso significa que hoy un administrador de la empresa A, con permiso
--    `attendance`, puede cargar horas extra a un empleado de la empresa B, o
--    borrar las de B adivinando un id. Es exactamente el mismo tipo de hueco
--    que ya se tapo antes en las tablas crudas del reloj (Checkins/users, ver
--    migracion 20260909) -- esta tabla se paso por alto en aquel momento.
--
--    Los dos puntos van juntos en una sola migracion porque el punto 1
--    NECESITA el punto 2: una fila de auditoria sin empresa no sirve (no se
--    puede mostrar "el historial de MI empresa" ni aislarlo). Corregir el
--    tenant no es un extra que se colo, es el requisito previo.
--
-- ES SEGURA DE CORRER: todo aditivo (columnas nuevas nullable + tablas
-- nuevas), nada se borra, nada cambia de tipo. Cada paso esta envuelto en la
-- guarda de `information_schema` + PREPARE/EXECUTE que usa el resto de las
-- migraciones de este repo, asi que se puede correr dos veces sin romper
-- nada (idempotente).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- PARTE 1 -- ManualEntries: tenant_id + quien la creo/modifico
-- ---------------------------------------------------------------------------

-- tenant_id queda NULLABLE a proposito, no NOT NULL. Motivo concreto: en la
-- base local hay 1 fila de ManualEntries cuyo userId ya no existe en `users`
-- (un usuario borrado despues). Con NOT NULL la migracion fallaria justo por
-- esa fila historica y no se podria aplicar. Nullable deja pasar la
-- migracion, y el codigo se encarga de que TODA fila nueva traiga tenant.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND COLUMN_NAME = 'tenant_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE ManualEntries ADD COLUMN tenant_id INT NULL AFTER id',
  'SELECT "ManualEntries.tenant_id ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill del tenant de las filas que ya estaban.
--
-- OJO con el detalle que hace que esto sea correcto: `users.USERID` NO es
-- unico entre empresas (ver migracion 20260909) -- dos empresas distintas
-- pueden tener el USERID 5. Un JOIN directo contra `users` elegiria una
-- empresa al azar en ese caso y asignaria la fila a la empresa equivocada.
-- Por eso el JOIN va contra un subquery que solo devuelve los USERID que
-- pertenecen a UNA SOLA empresa (`HAVING COUNT(DISTINCT tenant_id) = 1`).
-- Las filas ambiguas quedan con tenant_id NULL a proposito: mejor un dato
-- faltante y visible que un dato inventado que parece correcto.
-- (Verificado antes de escribir esto: hoy hay 0 filas ambiguas.)
UPDATE ManualEntries me
JOIN (
  SELECT USERID, MIN(tenant_id) AS tenant_id
  FROM users
  GROUP BY USERID
  HAVING COUNT(DISTINCT tenant_id) = 1
) t ON t.USERID = me.userId
SET me.tenant_id = t.tenant_id
WHERE me.tenant_id IS NULL;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND INDEX_NAME = 'idx_manual_entries_tenant'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_manual_entries_tenant ON ManualEntries (tenant_id, userId)',
  'SELECT "idx_manual_entries_tenant ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND COLUMN_NAME = 'created_by'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE ManualEntries ADD COLUMN created_by INT NULL AFTER note',
  'SELECT "ManualEntries.created_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND COLUMN_NAME = 'updated_by'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE ManualEntries ADD COLUMN updated_by INT NULL AFTER created_by',
  'SELECT "ManualEntries.updated_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND COLUMN_NAME = 'updatedAt'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE ManualEntries ADD COLUMN updatedAt DATETIME NULL AFTER createdAt',
  'SELECT "ManualEntries.updatedAt ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- FK de created_by/updated_by contra app_users, igual que Checkins.created_by
-- (migracion 20260920). Sirve para que no se pueda guardar el id de un
-- usuario que no existe.
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND CONSTRAINT_NAME = 'fk_manual_entries_created_by'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE ManualEntries ADD CONSTRAINT fk_manual_entries_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)',
  'SELECT "fk_manual_entries_created_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND CONSTRAINT_NAME = 'fk_manual_entries_updated_by'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE ManualEntries ADD CONSTRAINT fk_manual_entries_updated_by FOREIGN KEY (updated_by) REFERENCES app_users(id)',
  'SELECT "fk_manual_entries_updated_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ---------------------------------------------------------------------------
-- PARTE 2 -- userexclusions: quien la creo/modifico
-- ---------------------------------------------------------------------------
-- Esta tabla ya tiene tenant_id NOT NULL (migracion 20260909) y sus endpoints
-- ya validan la empresa (`userBelongsToCallerTenant` /
-- `exclusionBelongsToCallerTenant`), asi que aca solo falta la autoria.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userexclusions' AND COLUMN_NAME = 'created_by'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE userexclusions ADD COLUMN created_by INT NULL AFTER excTo',
  'SELECT "userexclusions.created_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userexclusions' AND COLUMN_NAME = 'updated_by'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE userexclusions ADD COLUMN updated_by INT NULL AFTER created_by',
  'SELECT "userexclusions.updated_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userexclusions' AND COLUMN_NAME = 'updatedAt'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE userexclusions ADD COLUMN updatedAt DATETIME NULL AFTER createdAt',
  'SELECT "userexclusions.updatedAt ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userexclusions' AND CONSTRAINT_NAME = 'fk_userexclusions_created_by'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE userexclusions ADD CONSTRAINT fk_userexclusions_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)',
  'SELECT "fk_userexclusions_created_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userexclusions' AND CONSTRAINT_NAME = 'fk_userexclusions_updated_by'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE userexclusions ADD CONSTRAINT fk_userexclusions_updated_by FOREIGN KEY (updated_by) REFERENCES app_users(id)',
  'SELECT "fk_userexclusions_updated_by ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ---------------------------------------------------------------------------
-- PARTE 3 -- Los dos logs (append-only)
-- ---------------------------------------------------------------------------
--
-- POR QUE UNA TABLA APARTE SI YA GUARDAMOS created_by EN LA FILA:
-- `created_by` en la fila responde "quien la creo". El log responde
-- "que paso con esto a lo largo del tiempo", que es distinto y es lo que
-- hace falta ante un reclamo:
--   - un UPDATE pisa el valor anterior; sin log, el valor viejo se pierde
--     para siempre y nadie puede ver que antes decia otra cosa.
--   - un DELETE borra la fila entera; sin log, no queda NI RASTRO de que
--     alguna vez existieron esas horas extra.
-- Es el mismo razonamiento que ya esta escrito en la migracion 20260920 para
-- `manual_checkin_log`.
--
-- APPEND-ONLY quiere decir: aca solo se INSERTA. Nunca se actualiza ni se
-- borra una fila de log. Si eso no se respeta, el log deja de servir como
-- prueba.
--
-- `previous_data` (tipo JSON, disponible desde MySQL 5.7; el servidor corre
-- 8.0) guarda la foto COMPLETA de como estaba la fila ANTES del cambio, en
-- los `updated` y en los `deleted`. Se eligio JSON en vez de una columna por
-- campo para que, si manana ManualEntries suma una columna, el log historico
-- siga siendo valido sin migrar nada.

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manual_entry_log'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE manual_entry_log (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NULL,
    entry_id INT NOT NULL,
    user_id INT NOT NULL,
    action ENUM('created','updated','deleted') NOT NULL,
    start_datetime DATETIME NULL,
    end_datetime DATETIME NULL,
    duration_minutes INT NULL,
    type VARCHAR(50) NULL,
    note TEXT NULL,
    previous_data JSON NULL,
    performed_by INT NULL,
    performed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_manual_entry_log_tenant (tenant_id, performed_at),
    KEY idx_manual_entry_log_entry (entry_id),
    KEY idx_manual_entry_log_user (user_id),
    CONSTRAINT fk_manual_entry_log_performed_by FOREIGN KEY (performed_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "manual_entry_log ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- NOTA sobre `entry_id` y `exclusion_id`: NO llevan foreign key contra la
-- tabla original, a proposito. Una FK impediria conservar la fila de log
-- despues de borrar el registro original -- que es justamente el caso que
-- mas importa auditar. Es el mismo criterio de `manual_checkin_log`.
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_exclusion_log'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE user_exclusion_log (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    exclusion_id INT NULL,
    user_id INT NOT NULL,
    action ENUM('created','updated','deleted') NOT NULL,
    exc_date DATE NULL,
    reason VARCHAR(255) NULL,
    type VARCHAR(50) NULL,
    event_type_id INT NULL,
    exc_from TIME NULL,
    exc_to TIME NULL,
    previous_data JSON NULL,
    performed_by INT NULL,
    performed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_user_exclusion_log_tenant (tenant_id, performed_at),
    KEY idx_user_exclusion_log_exclusion (exclusion_id),
    KEY idx_user_exclusion_log_user (user_id),
    CONSTRAINT fk_user_exclusion_log_performed_by FOREIGN KEY (performed_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "user_exclusion_log ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Reporte final. MIRAR `manual_entries_sin_empresa`: son las filas que el
-- backfill no pudo resolver (su userId no existe en `users`, o pertenece a
-- mas de una empresa). Esas filas NO se van a ver mas desde la aplicacion,
-- porque los endpoints ahora filtran por empresa. Si el numero es 0, no hay
-- nada que hacer. Si no es 0, son registros historicos de un empleado que ya
-- no existe y hay que decidir a mano que hacer con ellos (en la base de
-- desarrollo dio 1, de un usuario borrado hace tiempo).
SELECT
  'ManualEntries (tenant_id + autoria), userexclusions (autoria), manual_entry_log y user_exclusion_log aplicados correctamente' AS resultado,
  (SELECT COUNT(*) FROM ManualEntries) AS manual_entries_total,
  (SELECT COUNT(*) FROM ManualEntries WHERE tenant_id IS NULL) AS manual_entries_sin_empresa;
