-- ============================================================================
-- Horarios rotativos, etapa 1 (DISENO_HORARIOS_ROTATIVOS.md)
-- ============================================================================
--
-- QUE AGREGA (nada se borra ni se renombra):
--   shift_definitions        Turnos de cada empresa ("Mañana", "Noche", "Comercio partido").
--   shift_definition_tramos  Los tramos de cada turno (uno, o varios si es partido:
--                            07:00-12:00 y 16:00-20:00).
--   work_schedule_templates  + modo ('SEMANAL' lo de siempre / 'ROTATIVO')
--                            + cycle_length (dias del ciclo, solo rotativas).
--   template_cycle_days      Dia 1..N del ciclo -> un turno, o NULL (sin turno).
--   employee_work_calendars  + cycle_start_date: que fecha es el "dia 1" para
--                            esa persona (NULL = la fecha de inicio de la asignacion).
--
-- AISLAMIENTO: turnos y ciclos son de cada empresa (tenant_id), como todo.
--
-- ORDEN DE PUBLICACION: da igual. El codigo funciona con o sin esta migracion
-- (sin ella, no se pueden crear turnos ni rotativas, y todo se calcula como
-- siempre). Se puede correr mas de una vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shift_definitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  nombre VARCHAR(60) NOT NULL,
  color VARCHAR(7) NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_turno_empresa_nombre (tenant_id, nombre),
  CONSTRAINT fk_turno_empresa FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS shift_definition_tramos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT NOT NULL,
  orden TINYINT NOT NULL,
  inicio TIME NOT NULL,
  fin TIME NOT NULL,
  -- 1 si el tramo termina al dia siguiente (fin <= inicio): lo calcula el
  -- sistema al guardar.
  cruza_medianoche TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_tramo (shift_id, orden),
  CONSTRAINT fk_tramo_turno FOREIGN KEY (shift_id) REFERENCES shift_definitions(id) ON DELETE CASCADE
);

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_schedule_templates' AND COLUMN_NAME = 'modo');
SET @s := IF(@c = 0,
  "ALTER TABLE work_schedule_templates ADD COLUMN modo ENUM('SEMANAL','ROTATIVO') NOT NULL DEFAULT 'SEMANAL', ADD COLUMN cycle_length SMALLINT NULL",
  'SELECT "work_schedule_templates.modo ya existe"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS template_cycle_days (
  template_id INT NOT NULL,
  day_number SMALLINT NOT NULL,
  shift_id INT NULL,
  PRIMARY KEY (template_id, day_number),
  CONSTRAINT fk_ciclo_plantilla FOREIGN KEY (template_id) REFERENCES work_schedule_templates(id) ON DELETE CASCADE,
  CONSTRAINT fk_ciclo_turno FOREIGN KEY (shift_id) REFERENCES shift_definitions(id)
);

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_work_calendars' AND COLUMN_NAME = 'cycle_start_date');
SET @s := IF(@c = 0,
  'ALTER TABLE employee_work_calendars ADD COLUMN cycle_start_date DATE NULL',
  'SELECT "employee_work_calendars.cycle_start_date ya existe"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Control: las 4 tablas/columnas nuevas.
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shift_definitions') AS turnos,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shift_definition_tramos') AS tramos,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'template_cycle_days') AS dias_del_ciclo,
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_work_calendars' AND COLUMN_NAME = 'cycle_start_date') AS dia_1_en_asignacion;
