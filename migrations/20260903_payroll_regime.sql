-- Fase 7: regimen de pago (semanal/quincenal/mensual) para el filtro de la
-- nueva pantalla "Horas Extra por Regimen".
--
-- Config a nivel empresa (tenant_id NULL = default global, igual patron que
-- vacation_scale y holidays): que regimen usa esa empresa por defecto, en
-- que dia empieza la semana (para el regimen semanal) y en que dias del mes
-- cortan las quincenas (para el regimen quincenal, configurable porque cada
-- empresa puede usar fechas de corte distintas -- no siempre 1/16).
--
-- No hay UNIQUE KEY sobre tenant_id a proposito: MySQL trata cada NULL como
-- distinto para efectos de unicidad, asi que una UNIQUE(tenant_id) no evita
-- duplicar la fila global. En su lugar, el POST del endpoint hace
-- DELETE + INSERT dentro de una transaccion para garantizar una sola fila
-- por tenant (o una sola fila global).
CREATE TABLE IF NOT EXISTS payroll_regime_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NULL,
  regime VARCHAR(20) NOT NULL DEFAULT 'monthly', -- 'weekly' | 'biweekly' | 'monthly'
  week_start_day TINYINT NOT NULL DEFAULT 1,     -- 0=domingo .. 6=sabado (ISO-like, 1=lunes)
  biweekly_cut_day1 TINYINT NOT NULL DEFAULT 1,  -- dia del mes donde arranca la 1ra quincena
  biweekly_cut_day2 TINYINT NOT NULL DEFAULT 16, -- dia del mes donde arranca la 2da quincena
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_payroll_regime_tenant (tenant_id)
);

INSERT INTO payroll_regime_settings (tenant_id, regime, week_start_day, biweekly_cut_day1, biweekly_cut_day2)
SELECT NULL, 'monthly', 1, 1, 16
WHERE NOT EXISTS (SELECT 1 FROM payroll_regime_settings WHERE tenant_id IS NULL);

-- Anulacion por empleado (NULL = hereda el regimen de su empresa/el global).
ALTER TABLE employees ADD COLUMN payroll_regime VARCHAR(20) NULL;
