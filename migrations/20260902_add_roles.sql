-- Fase 4.1 del plan de migracion a Angular: RBAC como capa de "roles" (presets
-- con nombre) por encima del modelo de permisos granular que ya existe
-- (user_permissions). No se reemplaza nada: un usuario con role_id = NULL
-- sigue funcionando exactamente igual que hoy (permisos 100% manuales via
-- user_permissions). Permisos efectivos = permisos del rol UNION
-- user_permissions -- ver appUserRepository.findByFirebaseUid.

CREATE TABLE IF NOT EXISTS roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0, -- roles de sistema: no se pueden borrar ni editar sus permisos base
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roles_name (name)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT NOT NULL,
  permission VARCHAR(50) NOT NULL, -- mismo formato "modulo:accion" que user_permissions
  PRIMARY KEY (role_id, permission),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

ALTER TABLE app_users
  ADD COLUMN role_id INT NULL AFTER tenant_id,
  ADD KEY idx_app_users_role (role_id),
  ADD CONSTRAINT fk_app_users_role FOREIGN KEY (role_id) REFERENCES roles(id);

-- ============================================================
-- Roles de sistema (sembrados una sola vez, idempotente por nombre)
-- ============================================================

-- 1. Administrador de Empresa: CRUD completo dentro de su propio tenant,
-- incluyendo alta/gestion de otros usuarios de SU empresa (el backend ya
-- tenant-scopea /api/app-users para usuarios no-superadmin).
INSERT INTO roles (name, description, is_system)
SELECT 'Administrador de Empresa', 'Acceso completo a todos los modulos dentro de su propia empresa, incluyendo gestion de usuarios.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Administrador de Empresa');

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (
  SELECT CONCAT(m.module, ':', a.action) AS permission
  FROM (SELECT 'employees' AS module UNION SELECT 'attendance' UNION SELECT 'schedules'
        UNION SELECT 'leaves' UNION SELECT 'exclusions' UNION SELECT 'holidays'
        UNION SELECT 'matching' UNION SELECT 'settings' UNION SELECT 'users') m
  CROSS JOIN (SELECT 'read' AS action UNION SELECT 'create' UNION SELECT 'update' UNION SELECT 'delete') a
) p
WHERE r.name = 'Administrador de Empresa'
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission);

-- 2. Solo Lectura / Reportes: ver y exportar, sin poder modificar nada.
INSERT INTO roles (name, description, is_system)
SELECT 'Solo Lectura / Reportes', 'Puede ver y exportar informes de todos los modulos, sin poder crear, editar ni borrar nada.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Solo Lectura / Reportes');

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (
  SELECT CONCAT(module, ':read') AS permission
  FROM (SELECT 'employees' AS module UNION SELECT 'attendance' UNION SELECT 'matching'
        UNION SELECT 'holidays' UNION SELECT 'leaves' UNION SELECT 'exclusions') m
) p
WHERE r.name = 'Solo Lectura / Reportes'
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission);

-- 3. RRHH - Ausencias y Licencias: gestiona justificaciones y licencias,
-- ve empleados/asistencia, no puede borrar empleados ni tocar usuarios.
INSERT INTO roles (name, description, is_system)
SELECT 'RRHH - Ausencias y Licencias', 'Gestiona justificaciones, licencias y motivos de ausencia. Ve empleados y asistencia sin poder modificarlos.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'RRHH - Ausencias y Licencias');

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (
  SELECT 'employees:read' AS permission UNION SELECT 'attendance:read'
  UNION SELECT 'exclusions:read' UNION SELECT 'exclusions:create' UNION SELECT 'exclusions:update'
  UNION SELECT 'leaves:read' UNION SELECT 'leaves:create' UNION SELECT 'leaves:update'
  UNION SELECT 'holidays:read'
) p
WHERE r.name = 'RRHH - Ausencias y Licencias'
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission);

-- 4. Feriados: rol angosto para delegar solo el calendario de feriados.
INSERT INTO roles (name, description, is_system)
SELECT 'Feriados', 'Solo puede gestionar el calendario de feriados. Ve el resto de los modulos sin poder modificarlos.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Feriados');

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (
  SELECT 'holidays:read' AS permission UNION SELECT 'holidays:create' UNION SELECT 'holidays:update' UNION SELECT 'holidays:delete'
  UNION SELECT 'employees:read' UNION SELECT 'attendance:read'
) p
WHERE r.name = 'Feriados'
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission);
