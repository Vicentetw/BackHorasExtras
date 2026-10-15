-- ============================================================================
-- Autorización de salidas particulares (pedido del dueño, 2026-10-15)
-- ============================================================================
--
-- POR QUÉ: una persona no puede salir en horario sin permiso; si sale y le
-- pasa algo, la aseguradora (ART) no se hace responsable. Cada salida
-- particular (salir y volver, entrar tarde con el marcador de permiso, irse
-- antes) tiene que quedar AUTORIZADA o NO AUTORIZADA por alguien, con quién
-- y cuándo. Lo activa cada empresa (opción "Las salidas particulares
-- requieren autorización"); apagado, todo sigue como siempre.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   tabla salidas_autorizaciones   una fila por cada salida decidida. Una
--                                  salida SIN fila está "pendiente".
--
-- Cómo se identifica una salida: persona (legajo) + fecha + tipo + hora REAL
-- del fichaje (la salida, o la llegada si fue una entrada con permiso). Si un
-- marcador se corrige y la salida cambia de hora, vuelve a quedar pendiente:
-- es más seguro que arrastrar una autorización a otra salida.
--
-- Sin FK a app_users a propósito: se guarda el id y una copia del email de
-- quien decidió, así borrar un usuario no queda bloqueado por esto y el dato
-- de quién fue no se pierde.
--
-- ORDEN DE PUBLICACION: da igual. Sin esta migración el sistema funciona como
-- siempre y la opción avisa que falta correrla. Se puede correr más de una vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS salidas_autorizaciones (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id            INT NOT NULL,
  legajo               VARCHAR(32) NOT NULL,   -- employees.employee_id (único por empresa)
  fecha                DATE NOT NULL,
  tipo                 VARCHAR(12) NOT NULL,   -- 'salida' | 'entrada' | 'sin_regreso'
  hora                 CHAR(5) NOT NULL,       -- HH:MM del fichaje real
  estado               VARCHAR(16) NOT NULL,   -- 'autorizada' | 'no_autorizada'
  nota                 VARCHAR(255) NULL,
  decidido_por         INT NULL,               -- app_users.id (sin FK, ver arriba)
  decidido_por_email   VARCHAR(255) NULL,
  decidido_en          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- UTC
  UNIQUE KEY uq_salida (tenant_id, legajo, fecha, tipo, hora),
  KEY idx_salidas_aut_fecha (tenant_id, fecha)
);

-- Control: la tabla existe.
SELECT COUNT(*) AS tabla_salidas_autorizaciones FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'salidas_autorizaciones';
