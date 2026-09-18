-- Etapa 14 del plan "Motor de reglas de asistencia configurable" (ver
-- fases para impletentar avance.txt) -- corrige el HALLAZGO #3 de la
-- auditoria: a diferencia de employee_convention_assignments (que ya
-- versiona con valid_from/valid_to), work_schedule_templates guardaba
-- sus 4 columnas de tolerancia como un valor mutable unico -- cambiar la
-- tolerancia HOY alteraba en silencio el recalculo de CUALQUIER fecha
-- pasada. Dinero/reclamos de por medio: un periodo ya liquidado no puede
-- cambiar de resultado porque alguien ajusto la plantilla meses despues.
--
-- Diseño (mismo patron "changelog" que ya prueba employee_convention_assignments,
-- adaptado para no duplicar la fila completa en cada consulta): cada fila
-- de esta tabla es un SNAPSHOT CERRADO (valid_to siempre seteado) del
-- estado ANTERIOR de la plantilla, justo antes de un cambio. La fila
-- "actual" (desde el ultimo cambio en adelante, sin fecha de fin) sigue
-- viviendo en work_schedule_templates -- no se duplica. Resolver una
-- fecha: buscar un snapshot cuyo rango la cubra; si no hay ninguno, usar
-- las columnas vivas de la plantilla (comportamiento identico al actual
-- para TODA plantilla que nunca cambio su configuracion, que son todas
-- hasta hoy -- cero cambio de comportamiento con esta migracion).
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_template_config_history'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE work_schedule_template_config_history (
    id INT NOT NULL AUTO_INCREMENT,
    template_id INT NOT NULL,
    tolerancia_entrada_minutos INT NULL,
    tolerancia_salida_anticipada_minutos INT NULL,
    politica_llegada_anticipada ENUM('NO_COMPUTAR','TIEMPO_TRABAJADO','EXTRA_SI_AUTORIZADO','REGISTRAR_SIN_EXTRA') NULL,
    politica_salida_posterior ENUM('NO_COMPUTAR','TIEMPO_TRABAJADO','EXTRA_SI_AUTORIZADO','REGISTRAR_SIN_EXTRA') NULL,
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_template_config_history_lookup (template_id, valid_from, valid_to),
    CONSTRAINT fk_template_config_history_template FOREIGN KEY (template_id) REFERENCES work_schedule_templates(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "work_schedule_template_config_history ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'work_schedule_template_config_history (Etapa 14, hallazgo #3) aplicada correctamente' AS resultado;
