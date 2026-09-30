-- ============================================================================
-- Portal del empleado (etapa 1: cada persona ve lo suyo, solo lectura)
-- ============================================================================
--
-- Hasta aca, toda cuenta que entraba al sistema era de un administrador.
-- Con el portal entran tambien los EMPLEADOS, y cada uno tiene que ver
-- unicamente su propia informacion.
--
--   employees.email          el mail al que se le manda la invitacion
--                            (hasta ahora el sistema no guardaba el mail
--                            de cada empleado).
--   app_users.employee_id    si esta cargado, la cuenta ES de ese empleado.
--                            Una cuenta de empleado solo puede usar su perfil
--                            y /api/mi/... : lo bloquea appUserMiddleware.js
--                            por LISTA BLANCA, asi que una ruta de
--                            administracion mal protegida igual le queda
--                            cerrada. UNIQUE: una cuenta por empleado.
--
-- Aditivo: columnas NULL. Sin cuentas de empleado, nada cambia. Idempotente.
-- ============================================================================

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'email');
SET @sql = IF(@c = 0,
  'ALTER TABLE employees ADD COLUMN email VARCHAR(255) NULL, ADD KEY idx_employees_tenant_email (tenant_id, email)',
  'SELECT "employees.email ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_users' AND COLUMN_NAME = 'employee_id');
SET @sql = IF(@c = 0,
  'ALTER TABLE app_users ADD COLUMN employee_id INT NULL AFTER tenant_id,
     ADD UNIQUE KEY uq_app_users_employee (employee_id),
     ADD CONSTRAINT fk_app_users_employee FOREIGN KEY (employee_id) REFERENCES employees(id)',
  'SELECT "app_users.employee_id ya existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'portal del empleado: listo' AS resultado;
