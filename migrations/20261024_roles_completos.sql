-- ============================================================================
-- Roles completos (2026-10-26, puntos O, P y R de REVISION_PROFUNDA_2026-10-26.md)
-- ============================================================================
--
-- POR QUE: los roles se armaron el 02/09 y no acompañaron las pantallas
-- nuevas (el rol RRHH no podía cargar feriados ni autorizar salidas, nadie
-- salvo el administrador podía cerrar el mes) y solo el superadmin podía
-- crear roles. Ver la sección 8 de REVISION_PROFUNDA_2026-10-26.md.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   roles.tenant_id   NULL = rol de la plataforma (los de sistema); un número
--                     = rol propio de esa empresa, que crea su administrador.
--   roles.ofrecido    1 = se ofrece al invitar; 0 = rol viejo que se sigue
--                     respetando para quien lo tiene, pero ya no se ofrece
--                     (RRHH y Feriados, reemplazados por los nuevos).
--   El nombre pasa a ser único POR EMPRESA (dos empresas pueden tener un
--   rol "Portería" cada una).
--   Permiso nuevo horas_extra:update ("Horas extra: Editar"): cargar u
--   omitir horas extra a mano, aceptar días a revisar, autorizar excedentes y
--   cerrar o reabrir el mes. Antes eso dependía de los permisos de
--   Presentismo, así que quien cargaba fichajes también podía cerrar el mes.
--   NADIE PIERDE NADA: la primera vez que corre, se le da horas_extra:update
--   a todo rol y usuario que ya podía hacer eso (Presentismo: Crear o Editar).
--   Roles de sistema nuevos: Encargado de presentismo, Liquidación de horas
--   extra y Supervisor de sector. El administrador suma los permisos nuevos.
--
-- ORDEN DE PUBLICACION: da igual. Sin la migración, el servidor trata
-- "Horas extra: Editar" como antes (lo tiene quien tiene Presentismo: Crear
-- o Editar) y las empresas no pueden crear roles propios (la pantalla
-- avisa). Se puede correr más de una vez.
-- ============================================================================

-- Textos con tildes: sin esto, la consola de MySQL los guarda mal ("LiquidaciÃ³n").
SET NAMES utf8mb4;

-- ¿Primera vez? (antes de sembrar los roles nuevos). El reparto de
-- horas_extra:update se hace solo esa vez: si se repitiera, le daría cerrar
-- el mes al Encargado de presentismo, que justamente no lo tiene.
SET @primera := (SELECT COUNT(*) = 0 FROM roles WHERE name = 'Encargado de presentismo' AND is_system = 1);

-- 1. Columnas nuevas de roles.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'tenant_id');
SET @s := IF(@c = 0,
  "ALTER TABLE roles ADD COLUMN tenant_id INT NULL AFTER is_system, ADD COLUMN ofrecido TINYINT(1) NOT NULL DEFAULT 1 AFTER tenant_id, ADD KEY idx_roles_tenant (tenant_id), ADD CONSTRAINT fk_roles_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
  "SELECT 'roles ya tenía tenant_id' AS aviso");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. Nombre único por empresa (antes, único en toda la plataforma).
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND INDEX_NAME = 'uq_roles_name');
SET @s := IF(@c > 0, "ALTER TABLE roles DROP INDEX uq_roles_name", "SELECT 'sin uq_roles_name' AS aviso");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND INDEX_NAME = 'uq_roles_tenant_name');
SET @s := IF(@c = 0, "ALTER TABLE roles ADD UNIQUE KEY uq_roles_tenant_name (tenant_id, name)", "SELECT 'ya tenía uq_roles_tenant_name' AS aviso");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. "Horas extra: Editar" para quien ya podía (solo la primera vez).
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT DISTINCT role_id, 'horas_extra:update' FROM role_permissions
 WHERE @primera AND permission IN ('attendance:create', 'attendance:update');
INSERT IGNORE INTO user_permissions (user_id, permission)
SELECT DISTINCT user_id, 'horas_extra:update' FROM user_permissions
 WHERE @primera AND permission IN ('attendance:create', 'attendance:update');

-- 4. El administrador suma los módulos nuevos (salidas y horas extra).
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (
  SELECT CONCAT(m.module, ':', a.action) AS permission
  FROM (SELECT 'salidas' AS module UNION SELECT 'horas_extra') m
  CROSS JOIN (SELECT 'read' AS action UNION SELECT 'create' UNION SELECT 'update' UNION SELECT 'delete') a
) p
WHERE r.name = 'Administrador de Empresa' AND r.is_system = 1;

-- 5. Roles de sistema nuevos (idempotente por nombre).
INSERT INTO roles (name, description, is_system, ofrecido)
SELECT 'Encargado de presentismo',
       'Lleva el presentismo del día: justifica faltas, carga licencias, fichajes a mano y feriados, y autoriza salidas. No cierra el mes ni cambia la configuración.', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Encargado de presentismo' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
CROSS JOIN (
  SELECT 'attendance:read' AS permission UNION SELECT 'attendance:create' UNION SELECT 'attendance:delete'
  UNION SELECT 'employees:read' UNION SELECT 'schedules:read'
  UNION SELECT 'exclusions:read' UNION SELECT 'exclusions:create' UNION SELECT 'exclusions:update' UNION SELECT 'exclusions:delete'
  UNION SELECT 'leaves:read' UNION SELECT 'leaves:create' UNION SELECT 'leaves:update' UNION SELECT 'leaves:delete'
  UNION SELECT 'holidays:read' UNION SELECT 'holidays:create' UNION SELECT 'holidays:update' UNION SELECT 'holidays:delete'
  UNION SELECT 'salidas:update'
) p
WHERE r.name = 'Encargado de presentismo' AND r.is_system = 1;

INSERT INTO roles (name, description, is_system, ofrecido)
SELECT 'Liquidación de horas extra',
       'Revisa y decide las horas extra: las carga u omite a mano, acepta los días a revisar, autoriza excedentes y cierra el mes. Ve el presentismo sin modificarlo.', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Liquidación de horas extra' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
CROSS JOIN (
  SELECT 'attendance:read' AS permission UNION SELECT 'employees:read' UNION SELECT 'schedules:read'
  UNION SELECT 'exclusions:read' UNION SELECT 'leaves:read' UNION SELECT 'holidays:read'
  UNION SELECT 'horas_extra:update'
) p
WHERE r.name = 'Liquidación de horas extra' AND r.is_system = 1;

INSERT INTO roles (name, description, is_system, ofrecido)
SELECT 'Supervisor de sector',
       'Como el encargado de presentismo, pero sin cargar feriados ni borrar. Pensado para limitarlo a las áreas de su gente.', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Supervisor de sector' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
CROSS JOIN (
  SELECT 'attendance:read' AS permission UNION SELECT 'attendance:create'
  UNION SELECT 'employees:read' UNION SELECT 'schedules:read'
  UNION SELECT 'exclusions:read' UNION SELECT 'exclusions:create' UNION SELECT 'exclusions:update'
  UNION SELECT 'leaves:read' UNION SELECT 'leaves:create' UNION SELECT 'leaves:update'
  UNION SELECT 'holidays:read' UNION SELECT 'salidas:update'
) p
WHERE r.name = 'Supervisor de sector' AND r.is_system = 1;

-- 6. RRHH y Feriados ya no se ofrecen (quien los tiene, los conserva).
UPDATE roles SET ofrecido = 0
 WHERE is_system = 1 AND name IN ('RRHH - Ausencias y Licencias', 'Feriados');

-- Control.
SELECT r.name, r.tenant_id, r.ofrecido, COUNT(rp.permission) AS permisos
  FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
 WHERE r.is_system = 1 GROUP BY r.id ORDER BY r.id;
