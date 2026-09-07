-- Fase 10: panel de Pagos del cliente + baja autogestionada con aprobacion
-- del superadmin.
--
-- cancellation_requested_at/by: el cliente pide la baja desde su propio
-- panel, pero NO se cancela solo -- queda pendiente hasta que el
-- superadmin la apruebe (POST .../approve-cancellation, que recien ahi
-- pone status='canceled'). Se guarda a proposito SIN limpiar
-- cancellation_requested_at al aprobar -- queda como marca historica para
-- que el panel del cliente sepa si el bloqueo es "vos pediste la baja" o
-- "el administrador te pauso por otro motivo" (ej. falta de pago), y
-- mostrar el mensaje correcto en cada caso sin una columna aparte.
--
-- last_checkout_url/generated_at: el link de MercadoPago que genera el
-- superadmin (payment-dialog.ts) nunca se guardaba en la base, solo se
-- mostraba una vez en el dialogo -- no habia forma de que el cliente lo
-- volviera a ver despues desde su panel. Se persiste aca.
--
-- MySQL 8.0.45 no soporta ADD COLUMN IF NOT EXISTS (si es MariaDB) -- se
-- usa el mismo patron de guard dinamico que el resto de las migraciones
-- de esta fase (ver 20260906c_PRODUCCION_consolidado.sql).

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_subscriptions' AND COLUMN_NAME='cancellation_requested_at');
SET @sql := IF(@falta, 'ALTER TABLE tenant_subscriptions ADD COLUMN cancellation_requested_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_subscriptions' AND COLUMN_NAME='cancellation_requested_by');
SET @sql := IF(@falta, 'ALTER TABLE tenant_subscriptions ADD COLUMN cancellation_requested_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_subscriptions' AND COLUMN_NAME='last_checkout_url');
SET @sql := IF(@falta, 'ALTER TABLE tenant_subscriptions ADD COLUMN last_checkout_url TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_subscriptions' AND COLUMN_NAME='last_checkout_generated_at');
SET @sql := IF(@falta, 'ALTER TABLE tenant_subscriptions ADD COLUMN last_checkout_generated_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Migracion 20260907_billing_client_panel aplicada correctamente' AS resultado;
