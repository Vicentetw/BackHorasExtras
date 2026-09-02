-- Migración: Agregar columna tenant_id a la tabla employees
-- Ejecutar este script contra la base de datos cuando esté lista

ALTER TABLE employees ADD COLUMN tenant_id INT NULL;
ALTER TABLE employees ADD KEY idx_employees_tenant (tenant_id);

-- Verificar que la columna fue agregada correctamente
DESCRIBE employees;
