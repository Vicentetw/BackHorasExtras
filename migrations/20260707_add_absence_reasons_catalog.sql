-- Catálogo de motivos de ausencia (reusa event_types, ya existía pero sin uso)
ALTER TABLE event_types
  ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER requiere_aprobacion;

-- Vínculo opcional entre una exclusión y su motivo catalogado.
-- Nullable para no romper los registros existentes con reason en texto libre.
ALTER TABLE userexclusions
  ADD COLUMN event_type_id INT NULL AFTER type,
  ADD KEY idx_userexclusions_event_type (event_type_id),
  ADD CONSTRAINT fk_userexclusions_event_type FOREIGN KEY (event_type_id) REFERENCES event_types(id);

-- Seed de motivos base (a partir de los reason en texto libre ya usados + categorías comunes)
INSERT INTO event_types (code, descripcion, descuenta_vacaciones, requiere_aprobacion, active) VALUES
  ('VACACIONES', 'Vacaciones', 1, 1, 1),
  ('ENFERMEDAD', 'Enfermedad / Certificado médico', 0, 1, 1),
  ('ART', 'Accidente de trabajo (ART)', 0, 1, 1),
  ('ARTICULO_55', 'Artículo 55', 0, 1, 1),
  ('PERMISO', 'Permiso particular', 0, 1, 1),
  ('ESTUDIO', 'Licencia por estudio', 0, 1, 1),
  ('DUPLICADO', 'Registro duplicado', 0, 0, 1),
  ('OTRO', 'Otro motivo', 0, 0, 1);
