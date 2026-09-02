-- ============================================================
-- Migración consolidada para actualizar la base de Clever Cloud
-- Junta todas las migraciones aplicadas en la sesión local:
--   20260706_add_is_default_to_templates.sql
--   20260707_add_absence_reasons_catalog.sql
--   20260707_add_employee_leave_balances.sql
--   20260708_add_employee_categories_catalog.sql
--     (reemplaza directamente por el catálogo final; no pasa por el
--      paso intermedio de la columna de texto libre "categoria")
--
-- Pensada para correr UNA SOLA VEZ sobre una base que todavía no
-- tiene ninguno de estos cambios. Si alguna parte ya existe en tu
-- base de Clever Cloud, esa sentencia puntual va a fallar con un
-- error de "columna/tabla ya existe" — en ese caso comentá esa
-- sentencia y volvé a correr el resto.
-- ============================================================

-- 1) Plantilla de turno por defecto (work_schedule_templates)
ALTER TABLE work_schedule_templates
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE work_schedule_templates
  ADD INDEX idx_templates_tenant_default (tenant_id, is_default);

-- 2) Catálogo de motivos de ausencia (reusa event_types, ya existía sin uso)
ALTER TABLE event_types
  ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER requiere_aprobacion;

-- Vínculo opcional entre una exclusión y su motivo catalogado.
ALTER TABLE userexclusions
  ADD COLUMN event_type_id INT NULL AFTER type,
  ADD KEY idx_userexclusions_event_type (event_type_id),
  ADD CONSTRAINT fk_userexclusions_event_type FOREIGN KEY (event_type_id) REFERENCES event_types(id);

-- Seed de motivos base
INSERT INTO event_types (code, descripcion, descuenta_vacaciones, requiere_aprobacion, active) VALUES
  ('VACACIONES', 'Vacaciones', 1, 1, 1),
  ('ENFERMEDAD', 'Enfermedad / Certificado médico', 0, 1, 1),
  ('ART', 'Accidente de trabajo (ART)', 0, 1, 1),
  ('ARTICULO_55', 'Artículo 55', 0, 1, 1),
  ('PERMISO', 'Permiso particular', 0, 1, 1),
  ('ESTUDIO', 'Licencia por estudio', 0, 1, 1),
  ('DUPLICADO', 'Registro duplicado', 0, 0, 1),
  ('OTRO', 'Otro motivo', 0, 0, 1);

-- 3) Saldo de vacaciones por empleado y año (carga manual por admin)
CREATE TABLE IF NOT EXISTS employee_leave_balances (
  id INT NOT NULL AUTO_INCREMENT,
  employee_id INT NOT NULL,
  year INT NOT NULL,
  allotted_days DECIMAL(5,2) NOT NULL DEFAULT 0,
  notes VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_leave_balance (employee_id, year),
  KEY idx_employee_leave_balances_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Catálogo de categorías de puesto (Administrativo, Sereno, etc.)
CREATE TABLE IF NOT EXISTS employee_categories (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_category_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE employees
  ADD COLUMN category_id INT NULL AFTER activo,
  ADD KEY idx_employees_category (category_id);
