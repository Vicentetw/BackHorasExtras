-- Etapa 9 del plan "Motor de reglas de asistencia configurable" (ver
-- fases para impletentar avance.txt). "Empresa -> Convenios ->
-- Encuadramiento del empleado -> Categoria -> RuleSet" -- NO se modela
-- Empresa->Convenio unico. Mismo patron que employee_work_calendars
-- (asignacion de plantilla con vigencia), aplicado a convenios.
--
-- category_id queda SIN tabla ni FK propia por ahora (nullable, sin
-- restriccion) -- no hay todavia un caso real que pida modelar categorias
-- distintas POR convenio (cada empresa hoy usa la misma `employee_categories`
-- generica para otra cosa). Se agrega la columna como lugar reservado para
-- cuando haga falta, en vez de construir una tabla nueva sin uso real
-- (regla explicita del archivo de fases: "no crear complejidad innecesaria").
--
-- Un empleado SIN fila aca sigue usando su plantilla directamente
-- (convenios multiples es opt-in, no obligatorio) -- cero cambio para
-- todos los empleados existentes.
SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_convention_assignments'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE employee_convention_assignments (
    id INT NOT NULL AUTO_INCREMENT,
    employee_id INT NOT NULL,
    tenant_id INT NOT NULL,
    convention_id INT NOT NULL,
    category_id INT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_employee_convention_employee (employee_id),
    KEY idx_employee_convention_tenant (tenant_id),
    KEY idx_employee_convention_convention (convention_id),
    CONSTRAINT fk_employee_convention_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_employee_convention_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_employee_convention_convention FOREIGN KEY (convention_id) REFERENCES labor_conventions(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
  'SELECT "employee_convention_assignments ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'employee_convention_assignments (Etapa 9) aplicada correctamente' AS resultado;
