-- ============================================================================
-- Preferencias de cada usuario (2026-10-27)
-- ============================================================================
--
-- POR QUE: las cajas de ayuda de cada pantalla se pueden plegar. Si alguien
-- las pliega en la PC, al día siguiente en el celular tienen que seguir
-- plegadas: por eso se guarda en el servidor y no solo en el navegador.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   tabla app_user_preferencias  pares clave/valor por usuario, ej.
--                                ('ayuda.usuarios', 'plegada').
--                                Se borra sola si se borra el usuario.
--
-- ORDEN DE PUBLICACION: da igual. Sin la migración, la preferencia se guarda
-- solo en el navegador (como respaldo) y todo funciona igual.
-- Se puede correr más de una vez.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS app_user_preferencias (
  user_id     INT NOT NULL,
  clave       VARCHAR(100) NOT NULL,
  valor       VARCHAR(255) NOT NULL,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, clave),
  CONSTRAINT fk_preferencias_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);
