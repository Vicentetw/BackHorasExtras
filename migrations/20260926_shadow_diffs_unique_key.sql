-- Etapa 14 del plan "Motor de reglas de asistencia configurable" --
-- corrige el HALLAZGO #6 de la auditoria: cada corrida de
-- /attendance-range en modo sombra insertaba una fila NUEVA aunque la
-- misma diferencia ya estuviera registrada -- la tabla se llenaba de
-- duplicados con cada refresco de Presentismo. Se agrega una clave
-- unica (empleado+fecha+campo+plantilla) y el INSERT pasa a ser un
-- upsert (ver horasdedica.js).
--
-- Primero se eliminan duplicados existentes (se conserva la fila mas
-- reciente de cada grupo) para poder crear la clave unica sin romper --
-- inofensivo hoy porque esta tabla es nueva (Etapa 12, este mismo dia)
-- y solo tiene datos de prueba, pero se hace de forma segura por si un
-- ambiente ya tiene filas cargadas.
DELETE t1 FROM rule_engine_shadow_diffs t1
INNER JOIN rule_engine_shadow_diffs t2
  ON t1.employee_id = t2.employee_id
 AND t1.date = t2.date
 AND t1.field = t2.field
 AND (t1.template_id <=> t2.template_id)
 AND t1.id < t2.id;

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rule_engine_shadow_diffs' AND INDEX_NAME = 'uq_shadow_diffs_employee_date_field'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE rule_engine_shadow_diffs ADD UNIQUE KEY uq_shadow_diffs_employee_date_field (employee_id, date, field, template_id)',
  'SELECT "uq_shadow_diffs_employee_date_field ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'rule_engine_shadow_diffs: clave unica (Etapa 14, hallazgo #6) aplicada correctamente' AS resultado;
