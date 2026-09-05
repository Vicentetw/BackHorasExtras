-- ============================================================
-- CONSOLIDADO PARA PRODUCCION -- todo lo nuevo de la sesion
-- 2026-09-03 a 2026-09-06 (regimen de pago, turno partido, seguridad
-- multi-tenant, sistema de facturacion), en el orden correcto, listo
-- para pegar entero en tu cliente de MySQL de Clever Cloud.
--
-- ANTES DE CORRER ESTO: confirmá con PRODUCTION_DB_CHECK.sql que todo lo
-- de ANTES de esta fecha (tenants, app_users, roles, employee_categories,
-- etc.) ya esta aplicado -- este archivo asume que esas tablas base ya
-- existen (varias de las de aca abajo tienen FOREIGN KEY contra
-- `tenants`). Si PRODUCTION_DB_CHECK.sql te marca algo de ANTES en 0,
-- resolvé eso primero (ver PRODUCTION_DB_SYNC.md, Paso 1 y 2).
--
-- Es SEGURO correr este archivo entero de una, incluso si alguna pieza
-- individual ya estuviera aplicada -- cada sentencia se protegio para no
-- fallar si ya existe: tablas con `CREATE TABLE IF NOT EXISTS`, semillas
-- con `WHERE NOT EXISTS`, y cada `ALTER TABLE ADD COLUMN` con un chequeo
-- manual contra information_schema antes de tocar nada (MySQL, a
-- diferencia de MariaDB, no soporta `ADD COLUMN IF NOT EXISTS` -- probado
-- contra MySQL 8.0.45 antes de escribir esto: tira error de sintaxis).
-- Probado de punta a punta corriendo este archivo ENTERO dos veces
-- seguidas contra una base que ya tenia todo -- la segunda corrida no
-- rompe nada, solo confirma que no hay nada para hacer.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Fase 6.4/7 (2026-09-03): tope de salida particular, escala de
--    vacaciones, vencimiento de balances, año de saldo, modo de
--    autorizacion de HE, motivo de baja, regimen de pago.
-- ------------------------------------------------------------

-- Si employees.overtime_authorized NO existe todavia en tu base (existia
-- de antes en la de desarrollo, agregada a mano sin migracion -- puede
-- que en produccion sí haga falta crearla):
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='overtime_authorized');
SET @sql := IF(@falta, 'ALTER TABLE employees ADD COLUMN overtime_authorized TINYINT(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO app_settings (name, value)
SELECT 'particularExitMonthlyLimitMinutes', '0'
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'particularExitMonthlyLimitMinutes');

CREATE TABLE IF NOT EXISTS vacation_scale (
  id INT PRIMARY KEY AUTO_INCREMENT,
  tenant_id INT NULL,
  min_years INT NOT NULL,
  max_years INT NULL,
  days INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vacation_scale_tenant (tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

INSERT INTO vacation_scale (tenant_id, min_years, max_years, days)
SELECT NULL, v.min_years, v.max_years, v.days
FROM (
  SELECT 0 AS min_years, 5 AS max_years, 14 AS days
  UNION ALL SELECT 5, 10, 21
  UNION ALL SELECT 10, 20, 28
  UNION ALL SELECT 20, NULL, 35
) v
WHERE NOT EXISTS (SELECT 1 FROM vacation_scale WHERE tenant_id IS NULL);

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employee_leave_balances' AND COLUMN_NAME='expiration_date');
SET @sql := IF(@falta, 'ALTER TABLE employee_leave_balances ADD COLUMN expiration_date DATE NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employee_leave_balances' AND COLUMN_NAME='is_automatic');
SET @sql := IF(@falta, 'ALTER TABLE employee_leave_balances ADD COLUMN is_automatic TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employee_events' AND COLUMN_NAME='balance_year');
SET @sql := IF(@falta, 'ALTER TABLE employee_events ADD COLUMN balance_year INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO app_settings (name, value)
SELECT 'overtimeAuthorizationMode', 'all'
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'overtimeAuthorizationMode');

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='motivo_baja');
SET @sql := IF(@falta, 'ALTER TABLE employees ADD COLUMN motivo_baja VARCHAR(100) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS payroll_regime_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NULL,
  regime VARCHAR(20) NOT NULL DEFAULT 'monthly',
  week_start_day TINYINT NOT NULL DEFAULT 1,
  biweekly_cut_day1 TINYINT NOT NULL DEFAULT 1,
  biweekly_cut_day2 TINYINT NOT NULL DEFAULT 16,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_payroll_regime_tenant (tenant_id)
);

INSERT INTO payroll_regime_settings (tenant_id, regime, week_start_day, biweekly_cut_day1, biweekly_cut_day2)
SELECT NULL, 'monthly', 1, 1, 16
WHERE NOT EXISTS (SELECT 1 FROM payroll_regime_settings WHERE tenant_id IS NULL);

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='payroll_regime');
SET @sql := IF(@falta, 'ALTER TABLE employees ADD COLUMN payroll_regime VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ------------------------------------------------------------
-- 2) Fase 8 (2026-09-05): app_settings pasa a soportar override por
--    tenant. Los 2 ALTER mas delicados de todo este archivo, porque
--    cambian la PRIMARY KEY -- llevan el mismo chequeo manual de arriba.
-- ------------------------------------------------------------

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='app_settings' AND COLUMN_NAME='id');
SET @sql := IF(@falta,
  'ALTER TABLE app_settings DROP PRIMARY KEY, ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST, ADD COLUMN tenant_id INT NULL AFTER name, ADD INDEX idx_app_settings_name_tenant (name, tenant_id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Dedup (segura de correr aunque no haya nada para borrar) + UNIQUE KEY
-- real, para que el corte de HE (u otra config) de una empresa nunca mas
-- pueda duplicarse en dos filas globales por una condicion de carrera
-- (paso exactamente esto en desarrollo -- ver el comentario en
-- migrations/20260905b_app_settings_unique_key.sql).
DELETE t1 FROM app_settings t1
INNER JOIN app_settings t2
  ON t1.name = t2.name
  AND t1.tenant_id <=> t2.tenant_id
  AND t1.id < t2.id;

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='app_settings' AND COLUMN_NAME='tenant_key');
SET @sql := IF(@falta,
  'ALTER TABLE app_settings ADD COLUMN tenant_key INT GENERATED ALWAYS AS (COALESCE(tenant_id, -1)) STORED, ADD UNIQUE KEY uniq_app_settings_name_tenant (name, tenant_key)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ------------------------------------------------------------
-- 3) Fase 9 (2026-09-06): planes, suscripciones y pagos.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  base_price_usd DECIMAL(10,2) NOT NULL,
  price_per_employee_usd DECIMAL(10,2) NOT NULL,
  min_billed_employees INT NOT NULL DEFAULT 5,
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
  status ENUM('trial','active','grace','readonly','canceled','free') NOT NULL DEFAULT 'trial',
  payment_method ENUM('manual','mercadopago') NOT NULL DEFAULT 'manual',
  mercadopago_subscription_id VARCHAR(100) NULL,
  current_period_start DATE NULL,
  current_period_end DATE NULL,
  grace_period_days INT NULL,
  grace_message TEXT NULL,
  last_payment_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenant_subscription (tenant_id),
  CONSTRAINT fk_tenant_subscriptions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_tenant_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- Por si esta tabla ya existia de una corrida parcial anterior sin
-- 'free' en el ENUM -- MODIFY COLUMN es seguro de repetir.
ALTER TABLE tenant_subscriptions
  MODIFY COLUMN status ENUM('trial','active','grace','readonly','canceled','free') NOT NULL DEFAULT 'trial';

CREATE TABLE IF NOT EXISTS payment_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  amount_usd DECIMAL(10,2) NOT NULL,
  amount_local DECIMAL(12,2) NULL,
  local_currency VARCHAR(10) NULL DEFAULT 'ARS',
  method ENUM('manual','mercadopago') NOT NULL,
  reference VARCHAR(255) NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  recorded_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_records_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_payment_records_app_user FOREIGN KEY (recorded_by) REFERENCES app_users(id)
);

SELECT 'CONSOLIDADO 2026-09-03 a 09-06 aplicado correctamente' AS resultado;
