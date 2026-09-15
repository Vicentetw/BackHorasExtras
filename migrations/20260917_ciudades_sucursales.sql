-- Pedido real: "todo empleado debe tener plantilla asignada, ciudad y
-- sucursal" -- surgio investigando por que el motor de asistencia no puede
-- detectar turnos que cruzan medianoche (serenos) para una empresa que
-- nunca configuro Plantillas (ver attendanceCalculations.js/
-- shift_blocks.crosses_midnight). Ciudad/sucursal tambien sientan la base
-- para un pedido anterior (feriados que aplican solo a ciertas
-- ciudades/sucursales) -- ESE filtro no se construye todavia, ver el plan
-- completo.
--
-- Mismo patron que ya usa employee_categories: catalogo por empresa,
-- CREATE TABLE IF NOT EXISTS (idempotente). sucursales pertenece a una
-- ciudad (FK ciudad_id) -- no es independiente, asi el picker de sucursal
-- se puede filtrar por la ciudad ya elegida.
CREATE TABLE IF NOT EXISTS ciudades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ciudades_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE KEY uq_ciudad_tenant_nombre (tenant_id, nombre)
);

CREATE TABLE IF NOT EXISTS sucursales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  ciudad_id INT NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sucursales_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_sucursales_ciudad FOREIGN KEY (ciudad_id) REFERENCES ciudades(id),
  UNIQUE KEY uq_sucursal_ciudad_nombre (ciudad_id, nombre)
);

-- employees.ciudad_id/sucursal_id: NULL a nivel de base a proposito -- no
-- se puede exigir NOT NULL sin antes inventarle un valor a los empleados
-- reales que ya existen (480 en AVP). La obligatoriedad se aplica en la
-- app (routes/employees.js, employee-dialog.ts), no en el esquema -- un
-- empleado viejo sin estos datos queda visible en el indicador "Sin
-- Ciudad/Sucursal" hasta que alguien lo edite y los complete.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'ciudad_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE employees ADD COLUMN ciudad_id INT NULL AFTER zona_real_id',
  'SELECT "employees.ciudad_id ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'sucursal_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE employees ADD COLUMN sucursal_id INT NULL AFTER ciudad_id',
  'SELECT "employees.sucursal_id ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND CONSTRAINT_NAME = 'fk_employees_ciudad'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE employees ADD CONSTRAINT fk_employees_ciudad FOREIGN KEY (ciudad_id) REFERENCES ciudades(id)',
  'SELECT "fk_employees_ciudad ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND CONSTRAINT_NAME = 'fk_employees_sucursal'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE employees ADD CONSTRAINT fk_employees_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)',
  'SELECT "fk_employees_sucursal ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'ciudades/sucursales aplicada correctamente' AS resultado;
