-- Fase 12: pedido de link de pago desde el panel del cliente (/pagos).
-- Hueco real encontrado probando con un usuario de verdad: el link de
-- MercadoPago SOLO aparece si el superadmin ya lo genero desde
-- Facturacion -- el cliente no tenia forma de avisar que lo necesita, ni
-- de entender por que no ve boton de pago. Mismo patron ya usado para
-- cancellation_requested_at: se guarda CUANDO se pide, y se limpia solo
-- cuando el superadmin efectivamente genera el link (ver
-- billingRepository.recordCheckoutLink).
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_subscriptions' AND COLUMN_NAME='payment_requested_at');
SET @sql := IF(@falta, 'ALTER TABLE tenant_subscriptions ADD COLUMN payment_requested_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Migracion 20260909_payment_requested aplicada correctamente' AS resultado;
