-- Fase A paso 2 del plan de venta: feriados, motivos de ausencia y
-- categorias de empleado eran catalogos GLOBALES (compartidos entre
-- todas las empresas) -- con una segunda empresa real cargada, un
-- feriado o motivo que cargue una se veria en la otra.
--
-- tenant_id NULL = catalogo global (visible para todas las empresas,
-- solo lo puede crear un superadmin -- ej: feriados nacionales). Un
-- tenant normal ve sus propias filas MAS las globales.
-- Se migran las filas existentes al tenant real (id 6, "Empresa
-- Principal") ya que hoy son datos de esa empresa, no globales de
-- verdad.

ALTER TABLE holidays ADD COLUMN tenant_id INT NULL AFTER id;
ALTER TABLE holidays ADD KEY idx_holidays_tenant (tenant_id);
ALTER TABLE holidays ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id);
UPDATE holidays SET tenant_id = 6 WHERE tenant_id IS NULL;

ALTER TABLE event_types ADD COLUMN tenant_id INT NULL AFTER id;
ALTER TABLE event_types ADD KEY idx_event_types_tenant (tenant_id);
ALTER TABLE event_types ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id);
UPDATE event_types SET tenant_id = 6 WHERE tenant_id IS NULL;

ALTER TABLE employee_categories ADD COLUMN tenant_id INT NULL AFTER id;
ALTER TABLE employee_categories ADD KEY idx_employee_categories_tenant (tenant_id);
ALTER TABLE employee_categories ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id);
UPDATE employee_categories SET tenant_id = 6 WHERE tenant_id IS NULL;

-- El nombre de categoria era UNICO a nivel global -- con una segunda
-- empresa, ninguna podria llamar a una categoria igual que otra ya
-- existente. Se reemplaza por unico POR EMPRESA.
ALTER TABLE employee_categories DROP INDEX uq_employee_category_name;
ALTER TABLE employee_categories ADD UNIQUE KEY uq_employee_category_tenant_name (tenant_id, name);
