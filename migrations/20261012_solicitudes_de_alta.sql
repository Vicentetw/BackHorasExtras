-- ============================================================================
-- Solicitudes de alta: el superadmin aprueba o rechaza
-- ============================================================================
--
-- Decision del dueño del producto (2026-10-01): cualquiera se puede registrar
-- en la pagina, pero NADA se activa hasta que el superadmin lo apruebe,
-- despues de hablar con la persona. Hasta ahora el formulario creaba la
-- empresa, el mes de prueba y el usuario al instante.
--
-- signup_leads pasa a ser la bandeja de SOLICITUDES:
--   status 'pending'      esperando que el superadmin la revise
--          'provisioned'  aprobada: ya tiene empresa (tenant_id)
--          'rejected'     rechazada (nuevo), con su motivo
--          'failed'       la de siempre (ej. el mail ya tenia cuenta)
--   reviewed_by / reviewed_at / review_note   quien la resolvio, cuando y por que
--
-- Aditivo. Idempotente.
-- ============================================================================

ALTER TABLE signup_leads
  MODIFY COLUMN status ENUM('pending', 'provisioned', 'failed', 'rejected') NOT NULL DEFAULT 'pending';

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads' AND COLUMN_NAME = 'reviewed_by');
SET @sql = IF(@c = 0,
  'ALTER TABLE signup_leads ADD COLUMN reviewed_by INT NULL, ADD COLUMN reviewed_at DATETIME NULL, ADD COLUMN review_note VARCHAR(500) NULL',
  'SELECT "signup_leads.reviewed_* ya existen"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT status, COUNT(*) AS solicitudes FROM signup_leads GROUP BY status;
