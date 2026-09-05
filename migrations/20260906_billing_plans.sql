-- Fase 9 (venta): plan configurable (base + precio por empleado, con piso
-- minimo de empleados facturados) + suscripcion por empresa + historial de
-- pagos. Diseñado para arrancar con pago MANUAL (transferencia/efectivo,
-- un admin marca "pago recibido") y sumar MercadoPago despues sin cambiar
-- el esquema -- payment_records.method distingue el origen de cada pago.
--
-- El conteo de empleados para facturar SIEMPRE sale de `employees`
-- (tenant_id + activos), nunca de `users` (fichajes crudos del reloj, con
-- ruido/duplicados/gente sin matchear) -- ver billingCalculations.js.

CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  base_price_usd DECIMAL(10,2) NOT NULL,
  price_per_employee_usd DECIMAL(10,2) NOT NULL,
  -- Piso: aunque la empresa tenga menos empleados que esto, se factura
  -- como si tuviera esta cantidad -- evita que una cuenta de 2-3 empleados
  -- de perdida.
  min_billed_employees INT NOT NULL DEFAULT 5,
  -- Descuentos por plazo de pago, en porcentaje (0-100) sobre el precio
  -- mensual de lista. Mensual (pago manual mes a mes) = 0, sin descuento.
  discount_quarterly_pct DECIMAL(5,2) NOT NULL DEFAULT 5,
  discount_semiannual_pct DECIMAL(5,2) NOT NULL DEFAULT 10,
  discount_annual_pct DECIMAL(5,2) NOT NULL DEFAULT 17,
  active TINYINT(1) NOT NULL DEFAULT 1,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO plans (name, base_price_usd, price_per_employee_usd, min_billed_employees, is_default)
SELECT 'Plan estándar', 18.00, 2.20, 5, 1
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE is_default = 1);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  plan_id INT NOT NULL,
  billing_period ENUM('monthly','quarterly','semiannual','annual') NOT NULL DEFAULT 'monthly',
  -- trial: recien creada, sin cobrar todavia. active: al dia. grace:
  -- vencio pero sigue funcionando full con el cartel de aviso. readonly:
  -- se venció el período de gracia, solo lectura. canceled: dada de baja.
  status ENUM('trial','active','grace','readonly','canceled') NOT NULL DEFAULT 'trial',
  payment_method ENUM('manual','mercadopago') NOT NULL DEFAULT 'manual',
  mercadopago_subscription_id VARCHAR(100) NULL,
  current_period_start DATE NULL,
  current_period_end DATE NULL,
  -- Configurable por empresa (o se hereda el default global si es NULL).
  grace_period_days INT NULL,
  grace_message TEXT NULL,
  last_payment_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_subscription (tenant_id),
  CONSTRAINT fk_tenant_subscriptions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_tenant_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE TABLE IF NOT EXISTS payment_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  amount_usd DECIMAL(10,2) NOT NULL,
  -- Monto real cobrado en ARS (o lo que sea) -- puede diferir del USD de
  -- referencia por tipo de cambio del momento. NULL en pagos que todavia
  -- no se registraron con un monto real (ej. altas de prueba).
  amount_local DECIMAL(12,2) NULL,
  local_currency VARCHAR(10) NULL DEFAULT 'ARS',
  method ENUM('manual','mercadopago') NOT NULL,
  -- Referencia libre: id de pago de MercadoPago, o una nota del admin
  -- ("transferencia recibida, comprobante #123") para un pago manual.
  reference VARCHAR(255) NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  recorded_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_records_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_payment_records_app_user FOREIGN KEY (recorded_by) REFERENCES app_users(id)
);
