-- ============================================================================
-- Justificar una salida particular con un motivo (etapa E2, 2026-10-15)
-- ============================================================================
--
-- POR QUÉ (pedido del dueño): hay dos cosas distintas.
--   1. Algunos convenios dan horas para trámites particulares sin devolverlas
--      (una "bolsa", etapa E3).
--   2. Algunas empresas JUSTIFICAN la salida si la persona trae un comprobante
--      (fue al médico, a donar sangre...): esas horas NO se descuentan de la
--      bolsa y aparecen como "justificadas". En otras empresas sí se
--      descuentan. Por eso lo decide cada empresa, MOTIVO POR MOTIVO.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   tabla salidas_justificaciones   el motivo con que se justificó una salida
--                                   particular (misma identidad que la
--                                   autorización: legajo + fecha + tipo + hora).
--   event_types.consume_bolsa_particular   1 = una salida justificada con este
--                                   motivo igual se descuenta de la bolsa (lo
--                                   de siempre); 0 = no se descuenta
--                                   (ej. "Médico con certificado").
--   event_types.pide_comprobante    1 = recordar pedir el comprobante.
--
-- Valores por defecto = comportamiento actual: todo motivo consume (1) y
-- ninguno pide comprobante (0). Nada cambia hasta que el administrador lo
-- configure en Motivos de Ausencia.
--
-- ORDEN DE PUBLICACION: da igual. Sin esta migración el sistema funciona como
-- siempre y "Justificar" una salida avisa que falta. Se puede correr más de
-- una vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS salidas_justificaciones (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id            INT NOT NULL,
  legajo               VARCHAR(32) NOT NULL,
  fecha                DATE NOT NULL,
  tipo                 VARCHAR(12) NOT NULL,   -- 'salida' | 'entrada' | 'sin_regreso'
  hora                 CHAR(5) NOT NULL,       -- HH:MM del fichaje real
  event_type_id        INT NOT NULL,           -- el motivo (sin FK: si se desactiva, la constancia queda)
  nota                 VARCHAR(255) NULL,
  justificada_por      INT NULL,               -- app_users.id (sin FK, igual que la autorización)
  justificada_por_email VARCHAR(255) NULL,
  justificada_en       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- UTC
  UNIQUE KEY uq_salida_just (tenant_id, legajo, fecha, tipo, hora),
  KEY idx_salidas_just_fecha (tenant_id, fecha)
);

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_types' AND COLUMN_NAME = 'consume_bolsa_particular');
SET @s := IF(@c = 0,
  "ALTER TABLE event_types ADD COLUMN consume_bolsa_particular TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN pide_comprobante TINYINT(1) NOT NULL DEFAULT 0",
  "SELECT 'event_types ya tenía las columnas' AS aviso");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Control.
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'salidas_justificaciones') AS tabla_justificaciones,
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_types'
     AND COLUMN_NAME IN ('consume_bolsa_particular', 'pide_comprobante')) AS columnas_en_motivos;
