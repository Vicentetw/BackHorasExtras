-- Fase 6.4: 4 piezas nuevas que el usuario confirmo que nunca existieron
-- en el sistema viejo (no es migracion, es funcionalidad nueva):
--   1) employees.overtime_authorized: la columna YA EXISTIA en esta base
--      (agregada a mano en algun momento, sin migracion) pero nunca se
--      aplicaba en ningun motor de calculo. No se repite el ALTER aca
--      (ya existe localmente) -- si en otra base no existe, correr:
--        ALTER TABLE employees ADD COLUMN overtime_authorized TINYINT(1) NOT NULL DEFAULT 1;
--      Lo nuevo es el enforcement real en el codigo (ver horasdedica2.js).
--   2) Tope mensual de horas de "Salidas particulares" (/movements-range,
--      categoria PARTICULAR) -- el limite que ya existia
--      (personalLeaveMonthlyLimitMinutes) en realidad solo cubre llegadas
--      tarde justificadas, pese a estar mal etiquetado "salida particular"
--      en la UI vieja. Este es un tope aparte, nuevo.
--   3) Escala de vacaciones por antiguedad, configurable por empresa
--      (editable, no fija a la ley) -- para sugerir dias automaticamente
--      sin obligar a nadie a usarla.
--   4) employee_leave_balances: fecha de vencimiento opcional (alerta) y
--      flag de si el valor es automatico (por escala) o manual.
--   5) employee_events: a que ANIO de saldo de vacaciones descuenta una
--      licencia -- explicito, para poder repartir dias entre 2 anios
--      (ej. 10 dias del saldo 2024 + 15 del saldo 2025) sin ambiguedad.

-- 2) Tope de salidas particulares -- mismo patron que ya usa app_settings
-- para el resto de la configuracion (una fila por clave, valor texto).
INSERT INTO app_settings (name, value)
SELECT 'particularExitMonthlyLimitMinutes', '0'
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'particularExitMonthlyLimitMinutes');
-- 0 = sin tope configurado (comportamiento actual, no cambia nada hasta
-- que alguien lo configure explicitamente desde la pantalla nueva).

-- 3) Escala de vacaciones por antiguedad, por empresa (tenant_id NULL =
-- escala global default, editable). Sembrada con la escala legal argentina
-- (LCT Art. 150) como punto de partida editable, no como un valor fijo.
CREATE TABLE IF NOT EXISTS vacation_scale (
  id INT PRIMARY KEY AUTO_INCREMENT,
  tenant_id INT NULL,
  min_years INT NOT NULL,
  max_years INT NULL, -- NULL = sin tope superior (el ultimo escalon)
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

-- 4) employee_leave_balances: vencimiento opcional + si el valor viene de
-- la escala automatica o fue puesto a mano.
ALTER TABLE employee_leave_balances
  ADD COLUMN expiration_date DATE NULL,
  ADD COLUMN is_automatic TINYINT(1) NOT NULL DEFAULT 0;

-- 5) employee_events: anio de saldo al que descuenta (para el caso de
-- arrastre entre anios). NULL = se infiere de fecha_desde (comportamiento
-- actual, compatible con lo que ya hay cargado).
ALTER TABLE employee_events
  ADD COLUMN balance_year INT NULL;

-- 6) Modo de autorizacion de horas extra, configurable por empresa: 'all'
-- (todos computan HE, el flag por empleado se ignora -- default, no
-- cambia nada para quien no lo configure) o 'custom' (respeta
-- employees.overtime_authorized por empleado). Confirmado con el usuario:
-- el dato actual (466 sin autorizar de 476) es real (ej. Vialidad: sin
-- autorizacion no se paga HE), no basura -- se activa 'custom' en produccion
-- una vez que el enforcement este probado, no automaticamente con esta
-- migracion.
INSERT INTO app_settings (name, value)
SELECT 'overtimeAuthorizationMode', 'all'
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE name = 'overtimeAuthorizationMode');

-- 7) Motivo de baja (jubilado, renuncia, despido, etc.) -- antes solo
-- existia employees.activo (booleano) y fecha_baja, sin poder decir POR QUE.
ALTER TABLE employees
  ADD COLUMN motivo_baja VARCHAR(100) NULL;
