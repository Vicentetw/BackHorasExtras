-- ============================================================================
-- Registro dentro del sistema + aceptaciones legales + bloqueos (2026-10-14)
-- ============================================================================
--
-- Decisión del dueño: cualquiera puede crear una cuenta en el login del
-- sistema (email o Google), completar los datos de su empresa y aceptar los
-- términos; NO puede usar nada hasta que el superadmin la apruebe. Las
-- solicitudes sin aprobar se borran a los 30 días; el spam se borra en el
-- momento y se puede bloquear.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   signup_leads + firebase_uid      la cuenta de login que pidió el alta
--                + origen            'landing' (formulario viejo) o 'sistema'
--                + email_verificado  si el email estaba verificado al pedir
--                + ip                desde dónde se pidió (para bloquear spam)
--                status + 'blocked'  solicitud bloqueada por spam
--   tabla registro_bloqueos          emails o dominios que no pueden registrarse
--   tabla aceptaciones_legales       prueba de que se aceptaron los términos:
--                                    quién, cuándo, versión y huella del texto.
--                                    SOLO DE AGREGAR: nunca se edita ni borra
--                                    (salvo al borrar spam o una empresa).
--
-- ORDEN DE PUBLICACION: da igual. Sin esta migración, el formulario de la
-- landing y todo el sistema siguen como siempre; el registro nuevo responde
-- "falta la migración". Se puede correr más de una vez.
-- ============================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads' AND COLUMN_NAME = 'firebase_uid');
SET @s := IF(@c = 0,
  "ALTER TABLE signup_leads ADD COLUMN firebase_uid VARCHAR(128) NULL, ADD COLUMN origen VARCHAR(10) NOT NULL DEFAULT 'landing', ADD COLUMN email_verificado TINYINT(1) NULL, ADD COLUMN ip VARCHAR(64) NULL, ADD KEY idx_signup_uid (firebase_uid)",
  'SELECT "signup_leads.firebase_uid ya existe"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE signup_leads
  MODIFY COLUMN status ENUM('pending', 'provisioned', 'failed', 'rejected', 'blocked') NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS registro_bloqueos (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tipo        ENUM('email', 'dominio') NOT NULL,
  valor       VARCHAR(255) NOT NULL,
  motivo      VARCHAR(255) NULL,
  creado_por  INT NULL,
  creado_en   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bloqueo (tipo, valor)
);

CREATE TABLE IF NOT EXISTS aceptaciones_legales (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  creado_en       DATETIME NOT NULL,          -- UTC
  firebase_uid    VARCHAR(128) NOT NULL,
  email           VARCHAR(255) NOT NULL,
  signup_lead_id  INT NULL,
  tenant_id       INT NULL,                   -- se completa al aprobar
  documento       VARCHAR(40) NOT NULL,       -- terminos | acuerdo_datos | privacidad
  version         VARCHAR(20) NOT NULL,
  hash_texto      CHAR(64) NOT NULL,          -- SHA-256 del texto aceptado
  ip              VARCHAR(64) NULL,
  navegador       VARCHAR(255) NULL,
  KEY idx_acept_uid (firebase_uid),
  KEY idx_acept_tenant (tenant_id)
);

-- Control: 3 columnas nuevas + 2 tablas.
SELECT
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads'
     AND COLUMN_NAME IN ('firebase_uid', 'origen', 'email_verificado', 'ip')) AS columnas_nuevas,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME IN ('registro_bloqueos', 'aceptaciones_legales')) AS tablas_nuevas;
