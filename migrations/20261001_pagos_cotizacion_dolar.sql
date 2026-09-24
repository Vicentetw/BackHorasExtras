-- ============================================================================
-- Guardar a qué cotización del dólar se cobró cada pago
-- ============================================================================
--
-- EL PROBLEMA
-- -----------
-- Los precios de los planes están en dólares (plans.base_price_usd,
-- price_per_employee_usd) pero se cobran en pesos. Hasta ahora se guardaban
-- los dos montos, y nunca la cotización que los relaciona.
--
-- Sin ese número no se puede reconstruir después por qué un pago de US$ 100
-- fueron 150.000 pesos, ni comparar dos pagos de meses distintos. Se podría
-- derivar dividiendo, pero se guarda explícito a propósito: si mañana cambia
-- cómo se calcula el precio, el histórico tiene que quedar como fue, no
-- recalcularse solo.
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. La cotización usada en cada pago
-- ---------------------------------------------------------------------------
-- DECIMAL(14,4): 4 decimales porque una cotización no siempre es un entero, y
-- 14 dígitos de margen para que la inflación no lo haga chico en unos años.
--
-- Nullable a propósito. NULL significa "no se sabe a qué cotización se cobró",
-- que es la verdad para todos los pagos ya registrados y para cualquier pago
-- que entre por MercadoPago sin que nadie cargue el dato. Un 0 o un 1 serían
-- una mentira que después nadie puede distinguir de un valor cargado.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_records'
    AND COLUMN_NAME = 'exchange_rate'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE payment_records ADD COLUMN exchange_rate DECIMAL(14,4) NULL COMMENT "Pesos por dolar al momento del cobro. NULL = no se sabe."',
  'SELECT "exchange_rate ya existe" AS resultado');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. amount_usd pasa a poder ser NULL
-- ---------------------------------------------------------------------------
-- Era NOT NULL, y eso obligaba a inventar un número cuando no se sabe cuántos
-- dólares eran. Es exactamente lo que estaba pasando: la sincronización y el
-- webhook guardaban el monto EN PESOS dentro de amount_usd, porque no tenían
-- otra cosa que poner. Un pago de 50.000 ARS quedaba registrado como 50.000
-- dólares.
--
-- Con la columna nullable, un pago que llega de MercadoPago sin cotización
-- cargada dice "no sé cuántos dólares eran" en vez de mentir. El dato se puede
-- completar después; un número inventado, en cambio, no se distingue de uno
-- real.
--
-- MODIFY COLUMN es seguro de repetir: deja la columna igual si ya está así.
ALTER TABLE payment_records MODIFY COLUMN amount_usd DECIMAL(10,2) NULL;

-- ---------------------------------------------------------------------------
-- 3. Limpiar los amount_usd que en realidad son pesos
-- ---------------------------------------------------------------------------
-- Los pagos de MercadoPago ya registrados tienen el monto en pesos metido en
-- amount_usd (el bug de arriba). Se pasan a NULL: no se puede recuperar el
-- valor real en dólares sin saber la cotización de ese día, y dejarlo como
-- está es peor que no tenerlo -- cualquier reporte en dólares da un número
-- absurdo, sin ninguna señal de que está mal.
--
-- Solo toca las filas donde amount_usd es IGUAL a amount_local, que es la
-- firma exacta del bug (las dos columnas recibieron transaction_amount). Un
-- pago manual bien cargado tiene valores distintos y no se toca.
UPDATE payment_records
SET amount_usd = NULL
WHERE method = 'mercadopago'
  AND amount_usd IS NOT NULL
  AND amount_local IS NOT NULL
  AND amount_usd = amount_local;

SELECT 'listo' AS paso,
       COUNT(*) AS pagos_sin_valor_en_dolares
FROM payment_records WHERE amount_usd IS NULL;
