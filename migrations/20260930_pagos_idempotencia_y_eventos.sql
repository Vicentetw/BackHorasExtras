-- ============================================================================
-- Etapa 1 del panel de facturación: que un pago no se registre dos veces
-- ============================================================================
--
-- EL PROBLEMA
-- -----------
-- MercadoPago REINTENTA los webhooks: si el servidor no contesta rápido, o
-- contesta con error, manda la misma notificación otra vez. Hoy nada impide
-- que el mismo pago se registre dos veces, y cada registro EXTIENDE EL
-- PERÍODO -- o sea que un cliente podría quedar pago hasta dentro de dos
-- meses habiendo pagado uno.
--
-- Reportado en la práctica: "probando, un cliente puede pagar varias veces y
-- el botón para pagar sigue activo, no hay registro de pagado tampoco".
--
-- Verificado antes de escribir esto: hay 0 pagos en producción y 0
-- referencias duplicadas, así que la clave única de abajo no puede fallar
-- por datos preexistentes.
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Un pago de MercadoPago, una sola vez
-- ---------------------------------------------------------------------------
-- La clave va sobre (method, reference) y no sobre reference solo: los pagos
-- manuales usan `reference` como texto libre (un número de transferencia, una
-- nota) y dos empresas podrían escribir lo mismo sin que sea un duplicado.
-- Solo los de MercadoPago tienen una referencia que identifica la operación
-- de forma única.
--
-- reference es NULL en los pagos manuales sin referencia, y MySQL trata cada
-- NULL como distinto: esos no se ven afectados por la clave.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_records'
    AND INDEX_NAME = 'uq_payment_method_reference'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE payment_records ADD UNIQUE KEY uq_payment_method_reference (method, reference)',
  'SELECT "uq_payment_method_reference ya existe" AS resultado');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. Registro de TODO lo que manda MercadoPago
-- ---------------------------------------------------------------------------
-- Sin esto no hay forma de diagnosticar nada: si un pago no aparece, no se
-- puede saber si MercadoPago no avisó, si avisó y falló el procesamiento, o
-- si avisó de algo que no se reconoció. Es exactamente lo que está pasando
-- ahora mismo -- se pagó y no quedó registro, y no hay dónde mirar.
--
-- Se guarda el payload crudo a propósito (punto 13 de la especificación):
-- cuando algo no cierra, el JSON original es la única fuente de verdad.
CREATE TABLE IF NOT EXISTS mercadopago_events (
  id INT PRIMARY KEY AUTO_INCREMENT,

  -- Identificación del evento según MercadoPago
  event_id VARCHAR(100) NULL,        -- id de la notificación (puede faltar)
  event_type VARCHAR(60) NULL,       -- payment, subscription_preapproval...
  action VARCHAR(60) NULL,           -- payment.created, payment.updated...
  resource_id VARCHAR(100) NULL,     -- el id del pago o de la suscripción

  -- A quién corresponde (se resuelve al procesar; puede quedar NULL si el
  -- evento no se pudo relacionar con ninguna empresa)
  tenant_id INT NULL,
  payment_record_id INT NULL,

  -- Cómo salió
  processing_status ENUM('recibido','procesado','duplicado','ignorado','error')
    NOT NULL DEFAULT 'recibido',
  attempts INT NOT NULL DEFAULT 1,   -- cuántas veces llegó el mismo evento
  http_status INT NULL,              -- qué se le respondió a MercadoPago
  error_message TEXT NULL,
  signature_valid TINYINT(1) NULL,   -- NULL = no se pudo validar (sin secret)

  payload JSON NULL,                 -- el cuerpo original, para auditoría

  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP NULL,

  KEY idx_mp_events_resource (event_type, resource_id),
  KEY idx_mp_events_tenant (tenant_id),
  KEY idx_mp_events_recibido (received_at),
  CONSTRAINT fk_mp_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_mp_events_payment FOREIGN KEY (payment_record_id) REFERENCES payment_records(id)
);

-- La clave que hace idempotente el procesamiento: el MISMO tipo de evento
-- sobre el MISMO recurso se procesa una vez sola. No se usa event_id porque
-- MercadoPago no siempre lo manda, y porque un reintento del mismo hecho
-- puede traer un id de notificación distinto.
SET @existe2 := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mercadopago_events'
    AND INDEX_NAME = 'uq_mp_event_recurso'
);
SET @sql2 := IF(@existe2 = 0,
  'ALTER TABLE mercadopago_events ADD UNIQUE KEY uq_mp_event_recurso (event_type, resource_id)',
  'SELECT "uq_mp_event_recurso ya existe" AS resultado');
PREPARE stmt FROM @sql2; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migracion 20260930 aplicada' AS resultado;
