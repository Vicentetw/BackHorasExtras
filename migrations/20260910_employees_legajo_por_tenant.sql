-- Fase 20 -- continuacion del arreglo de aislamiento por empresa
-- (ver AUDITORIA_Y_ROADMAP_VENTA.md, sesion 9-10 sep 2026): la tabla
-- `employees` tenia el legajo (`employee_id`) como UNIQUE KEY GLOBAL
-- (`uq_employee_id`), no por empresa. Con un solo cliente real nunca se
-- nota, pero una segunda empresa real que quiera usar un legajo que la
-- primera ya usa (los numeros bajos como "1000" son habituales) fallaria
-- al dar de alta esa persona con un error de clave duplicada.
--
-- El legajo pasa a ser unico POR EMPRESA: dos empresas distintas pueden
-- tener cada una su empleado con el legajo "1000". Todo el codigo que
-- resolvia un legajo a un empleado (routes/employees.js, import.routes.js,
-- leaveBalances.js, motor-laboral/repositories/scheduleRepository.js) se
-- actualizo en el mismo cambio para filtrar tambien por tenant, sino un
-- legajo compartido podia resolver al empleado de la empresa equivocada.
--
-- Migracion de un solo uso. En produccion ya se hizo antes la limpieza de
-- tenants duplicados/de prueba (todos los empleados quedaron bajo el
-- unico tenant real), asi que este cambio de indice no encuentra ninguna
-- colision de (tenant_id, employee_id).

ALTER TABLE employees
  DROP INDEX uq_employee_id,
  ADD UNIQUE KEY uq_employee_tenant_legajo (tenant_id, employee_id);
