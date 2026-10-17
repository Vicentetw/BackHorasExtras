-- ============================================================================
-- Revisiones de "Días a revisar" de horas extra (2026-10-17)
-- ============================================================================
--
-- POR QUE: en Horas Extra por Régimen → "Días a revisar", cada día se puede
-- resolver con un clic. "No corresponde" usa lo que ya existe (Omitir, en
-- ManualEntries). "Está bien" no cambia ningún número, pero hay que dejar
-- constancia de QUIÉN lo revisó y CUÁNDO, y con cuántos minutos (si después
-- llegan fichajes nuevos y el día cambia, vuelve a "a revisar").
--
-- QUE AGREGA (nada se borra ni se renombra): la tabla horas_extra_revisiones.
-- El cálculo NO la lee: solo la lista de días a revisar.
--
-- ORDEN DE PUBLICACION: da igual. Sin la migración, "Está bien" avisa que
-- falta; el resto funciona. Se puede correr más de una vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS horas_extra_revisiones (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id           INT NOT NULL,
  legajo              VARCHAR(32) NOT NULL,
  fecha               DATE NOT NULL,
  decision            VARCHAR(16) NOT NULL,        -- 'aceptado'
  minutos_al_revisar  INT NOT NULL,                -- horas extra del día cuando se revisó
  nota                VARCHAR(255) NULL,
  revisado_por        INT NULL,                    -- app_users.id (sin FK, igual que otras constancias)
  revisado_por_email  VARCHAR(255) NULL,
  revisado_en         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_revision_he (tenant_id, legajo, fecha),
  KEY idx_revision_he_fecha (tenant_id, fecha)
);

-- Control.
SELECT COUNT(*) AS tabla_revisiones FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'horas_extra_revisiones';
