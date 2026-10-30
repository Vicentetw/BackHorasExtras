-- ============================================================================
-- Correcciones de fichajes (etapa G, 2026-10-30)
-- ============================================================================
--
-- POR QUE: el administrador tiene que poder decir "este fichaje no vale"
-- (omitir), "este fichaje no lleva marcador" (quitar) o "este fichaje lleva
-- otro marcador" (cambiar), con motivo, quién y cuándo, y poder deshacerlo.
-- Diseño completo: CORRECCIONES_FICHAJES.md.
--
-- QUE AGREGA (nada se borra ni se renombra; Checkins NO se toca):
--   tabla fichajes_correcciones   una fila por corrección. Nunca se borra:
--                                 deshacer completa deshecha_por/_at.
--                                 Una sola corrección ACTIVA por fichaje
--                                 (columna calculada activa_checkin_id).
--   permisos fichajes:read y fichajes:update, SOLO para el rol de sistema
--   "Administrador de Empresa". Ningún otro rol los recibe.
--
-- ORDEN DE PUBLICACION: da igual. Sin la migración no hay correcciones y
-- todo se calcula exactamente como antes; las rutas nuevas responden
-- "falta la migración".
-- Se puede correr más de una vez.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS fichajes_correcciones (
  id                 INT NOT NULL AUTO_INCREMENT,
  tenant_id          INT NOT NULL,
  -- El fichaje corregido: su clave primaria en Checkins...
  checkin_id         INT NOT NULL,
  -- ...y una copia de control. Si el fichaje se borra o se reimporta y estas
  -- no coinciden, la corrección no se aplica (queda "huérfana").
  checkin_userid     INT NOT NULL,
  checkin_time       DATETIME NOT NULL,
  checkin_machine_ip VARCHAR(64) NOT NULL,
  employee_id        INT NULL,
  accion             ENUM('OMITIR', 'QUITAR_MARCADOR', 'CAMBIAR_MARCADOR') NOT NULL,
  marcador_user_id   INT NULL,
  motivo             VARCHAR(500) NOT NULL,
  -- Resumen de la vista previa que se confirmó (quién cambia y cuánto).
  impacto            JSON NULL,
  afecta_a_otros     TINYINT(1) NOT NULL DEFAULT 0,
  created_by         INT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deshecha_por       INT NULL,
  deshecha_at        DATETIME NULL,
  motivo_deshacer    VARCHAR(500) NULL,
  impacto_deshacer   JSON NULL,
  activa_checkin_id  INT GENERATED ALWAYS AS (IF(deshecha_at IS NULL, checkin_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fichajes_correcciones_activa (tenant_id, activa_checkin_id),
  KEY idx_fichajes_correcciones_hora (tenant_id, checkin_time),
  KEY idx_fichajes_correcciones_empleado (tenant_id, employee_id),
  CONSTRAINT fk_fichajes_correcciones_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT fk_fichajes_correcciones_created_by FOREIGN KEY (created_by) REFERENCES app_users (id),
  CONSTRAINT fk_fichajes_correcciones_deshecha_por FOREIGN KEY (deshecha_por) REFERENCES app_users (id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (SELECT 'fichajes:read' AS permission UNION SELECT 'fichajes:update') p
WHERE r.name = 'Administrador de Empresa' AND r.is_system = 1;
