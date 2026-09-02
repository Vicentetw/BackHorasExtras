-- Migración: Agregar columna exclude_from_report a la tabla employees
-- Ejecutar este script contra la base de datos cuando esté lista

ALTER TABLE employees ADD COLUMN exclude_from_report TINYINT(1) NOT NULL DEFAULT 0;

-- Verificar que la columna fue agregada correctamente
DESCRIBE employees;
