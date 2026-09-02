-- Categoría de puesto del empleado (ej: Administrativo, Sereno) para poder
-- asignar plantillas de horario en bloque en vez de empleado por empleado.
ALTER TABLE employees
  ADD COLUMN categoria VARCHAR(50) NULL AFTER activo;
