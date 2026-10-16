-- ============================================================================
-- Archivar plantillas de horario (F, 2026-10-16)
-- ============================================================================
--
-- POR QUÉ: borrar o desactivar una plantilla que alguien tuvo asignada cambia
-- el horario de esas personas TAMBIÉN EN DÍAS PASADOS (el cálculo solo usa
-- plantillas que existen y están activas). Auditoría sobre el backup del
-- 15/10: AUDITORIA_FICHAJES_REPETIDOS.md / ESTADO_PROYECTO.md.
--
-- "Archivar" es otra cosa: la plantilla sigue existiendo y activa para el
-- cálculo (lo pasado no cambia), pero ya no se ofrece para asignar. Sirve
-- para sacar de la vista una plantilla vieja que ya nadie usa HOY.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   work_schedule_templates.archived_at   NULL = no archivada
--   work_schedule_templates.archived_by   app_users.id de quien la archivó
--
-- El cálculo NO lee estas columnas. ORDEN DE PUBLICACION: da igual. Sin la
-- migración, "Archivar" responde que falta y todo lo demás funciona igual.
-- Se puede correr más de una vez.
-- ============================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'archived_at');
SET @s := IF(@c = 0,
  "ALTER TABLE work_schedule_templates ADD COLUMN archived_at DATETIME NULL, ADD COLUMN archived_by INT NULL",
  "SELECT 'work_schedule_templates ya tenía archived_at' AS aviso");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Control.
SELECT COUNT(*) AS columnas_nuevas FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME IN ('archived_at', 'archived_by');
