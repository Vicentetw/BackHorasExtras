-- ============================================================================
-- Registro de actividad: quién hizo qué, en qué empresa (pedido del dueño, 2026-10-09)
-- ============================================================================
--
-- QUE AGREGA (nada se borra ni se renombra):
--   tabla registro_actividad   una fila por cada cambio que alguien hace en el
--                              sistema (crear, modificar, borrar): quién, cuándo,
--                              en qué empresa, qué pantalla/acción, si salió bien,
--                              y si lo hizo el superadmin "como soporte".
--
-- PARA QUE SIRVE: si un empleado o un cliente dice "esto lo cargó el
-- superadmin" (un feriado, una licencia, un horario), queda la prueba de quién
-- fue realmente. El administrador de cada empresa ve el registro de SU
-- empresa, incluidas las acciones que hizo el soporte en ella.
--
-- Es SOLO DE AGREGAR: el sistema inserta filas y nunca las modifica ni las
-- borra. Un registro que se puede editar no prueba nada.
--
-- Lo que se guarda del pedido pasa por un filtro: se sacan contraseñas,
-- tokens, claves y firmas, y se corta a 4000 caracteres.
--
-- ORDEN DE PUBLICACION: da igual. Sin esta migración el sistema funciona
-- igual que siempre, solo que no registra (y la pantalla "Registro de
-- actividad" avisa que falta correrla). Se puede correr más de una vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS registro_actividad (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  creado_en     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- se guarda en UTC
  tenant_id     INT NULL,              -- empresa afectada (NULL = plataforma)
  app_user_id   INT NULL,              -- cuenta que lo hizo
  email         VARCHAR(255) NULL,     -- copia del email (la cuenta puede borrarse después)
  como_soporte  TINYINT(1) NOT NULL DEFAULT 0, -- 1 = superadmin trabajando en la empresa
  metodo        VARCHAR(10) NOT NULL,  -- POST / PUT / PATCH / DELETE
  ruta          VARCHAR(255) NOT NULL,
  descripcion   VARCHAR(255) NULL,     -- texto para personas: "Creó un feriado"
  estado        SMALLINT NULL,         -- respuesta HTTP (2xx = se hizo, 4xx/5xx = se intentó)
  detalle       TEXT NULL,             -- datos enviados, filtrados y recortados
  ip            VARCHAR(64) NULL,
  KEY idx_reg_tenant_fecha (tenant_id, creado_en),
  KEY idx_reg_usuario_fecha (app_user_id, creado_en)
);

-- Control: la tabla existe.
SELECT COUNT(*) AS tabla_registro_actividad FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'registro_actividad';
