-- ============================================================================
-- Siembra de una INSTALACIÓN NUEVA (base recién creada con la estructura)
-- ============================================================================
--
-- Cuándo se usa: después de cargar en una base vacía la estructura exportada
-- con scripts/exportar-estructura.ps1 (REPLICAR_INSTALACION.md, paso 1.5).
-- NO se usa para restaurar un backup: el backup ya trae todos los datos.
--
-- QUÉ CARGA (solo datos de la plataforma, nada de ninguna empresa):
--   * los 4 roles del sistema con sus permisos (copiados de producción el
--     2026-10-09: 36 + 6 + 9 + 6 = 57 permisos);
--   * el plan de facturación por defecto (sin él no se puede aprobar una
--     solicitud de alta: "No hay un plan por defecto configurado").
--
-- QUÉ NO CARGA, a propósito:
--   * empresas, usuarios, empleados: nada. El superadmin se crea a mano
--     (paso 4) y el resto sale de las pantallas.
--   * valores de configuración "globales": el código ya tiene sus valores
--     por defecto, y cada empresa recibe los suyos al crearse (escala de
--     vacaciones y régimen de pago: kitInicialEmpresa.js).
--
-- POR QUÉ ESTE ARCHIVO Y NO LAS MIGRACIONES 20260902/20260903 (como decía
-- antes el instructivo): esas migraciones empiezan agregando columnas
-- (ALTER TABLE ... ADD COLUMN). Sobre la estructura exportada esas columnas
-- ya existen, el ALTER falla y `mysql` corta ahí: los roles NUNCA se cargan.
-- Comprobado en un ensayo el 2026-10-09 (quedaban 0 roles). Este archivo
-- solo tiene INSERT, y cada uno controla que no exista: se puede correr
-- más de una vez sin duplicar nada.
-- ============================================================================

-- Administrador de Empresa
INSERT INTO roles (name, description, is_system)
SELECT 'Administrador de Empresa', 'Acceso completo a todos los modulos dentro de su propia empresa, incluyendo gestion de usuarios.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Administrador de Empresa' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r JOIN (
  SELECT 'attendance:create' AS permission
  UNION ALL SELECT 'attendance:delete'
  UNION ALL SELECT 'attendance:read'
  UNION ALL SELECT 'attendance:update'
  UNION ALL SELECT 'employees:create'
  UNION ALL SELECT 'employees:delete'
  UNION ALL SELECT 'employees:read'
  UNION ALL SELECT 'employees:update'
  UNION ALL SELECT 'exclusions:create'
  UNION ALL SELECT 'exclusions:delete'
  UNION ALL SELECT 'exclusions:read'
  UNION ALL SELECT 'exclusions:update'
  UNION ALL SELECT 'holidays:create'
  UNION ALL SELECT 'holidays:delete'
  UNION ALL SELECT 'holidays:read'
  UNION ALL SELECT 'holidays:update'
  UNION ALL SELECT 'leaves:create'
  UNION ALL SELECT 'leaves:delete'
  UNION ALL SELECT 'leaves:read'
  UNION ALL SELECT 'leaves:update'
  UNION ALL SELECT 'matching:create'
  UNION ALL SELECT 'matching:delete'
  UNION ALL SELECT 'matching:read'
  UNION ALL SELECT 'matching:update'
  UNION ALL SELECT 'schedules:create'
  UNION ALL SELECT 'schedules:delete'
  UNION ALL SELECT 'schedules:read'
  UNION ALL SELECT 'schedules:update'
  UNION ALL SELECT 'settings:create'
  UNION ALL SELECT 'settings:delete'
  UNION ALL SELECT 'settings:read'
  UNION ALL SELECT 'settings:update'
  UNION ALL SELECT 'users:create'
  UNION ALL SELECT 'users:delete'
  UNION ALL SELECT 'users:read'
  UNION ALL SELECT 'users:update'
) p
WHERE r.name = 'Administrador de Empresa' AND r.is_system = 1;

-- Solo Lectura / Reportes
INSERT INTO roles (name, description, is_system)
SELECT 'Solo Lectura / Reportes', 'Puede ver y exportar informes de todos los modulos, sin poder crear, editar ni borrar nada.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Solo Lectura / Reportes' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r JOIN (
  SELECT 'attendance:read' AS permission
  UNION ALL SELECT 'employees:read'
  UNION ALL SELECT 'exclusions:read'
  UNION ALL SELECT 'holidays:read'
  UNION ALL SELECT 'leaves:read'
  UNION ALL SELECT 'matching:read'
) p
WHERE r.name = 'Solo Lectura / Reportes' AND r.is_system = 1;

-- RRHH - Ausencias y Licencias
INSERT INTO roles (name, description, is_system)
SELECT 'RRHH - Ausencias y Licencias', 'Gestiona justificaciones, licencias y motivos de ausencia. Ve empleados y asistencia sin poder modificarlos.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'RRHH - Ausencias y Licencias' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r JOIN (
  SELECT 'attendance:read' AS permission
  UNION ALL SELECT 'employees:read'
  UNION ALL SELECT 'exclusions:create'
  UNION ALL SELECT 'exclusions:read'
  UNION ALL SELECT 'exclusions:update'
  UNION ALL SELECT 'holidays:read'
  UNION ALL SELECT 'leaves:create'
  UNION ALL SELECT 'leaves:read'
  UNION ALL SELECT 'leaves:update'
) p
WHERE r.name = 'RRHH - Ausencias y Licencias' AND r.is_system = 1;

-- Feriados
INSERT INTO roles (name, description, is_system)
SELECT 'Feriados', 'Solo puede gestionar el calendario de feriados. Ve el resto de los modulos sin poder modificarlos.', 1
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Feriados' AND is_system = 1);
INSERT IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r JOIN (
  SELECT 'attendance:read' AS permission
  UNION ALL SELECT 'employees:read'
  UNION ALL SELECT 'holidays:create'
  UNION ALL SELECT 'holidays:delete'
  UNION ALL SELECT 'holidays:read'
  UNION ALL SELECT 'holidays:update'
) p
WHERE r.name = 'Feriados' AND r.is_system = 1;

-- Plan por defecto (los precios se editan después en la pantalla Planes).
INSERT INTO plans (name, base_price_usd, price_per_employee_usd, min_billed_employees, is_default)
SELECT 'Plan estándar', 18.00, 2.20, 10, 1
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE is_default = 1);

-- Control: tiene que dar roles = 4, permisos = 57, plan_por_defecto = 1.
SELECT (SELECT COUNT(*) FROM roles WHERE is_system = 1) AS roles,
       (SELECT COUNT(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.is_system = 1) AS permisos,
       (SELECT COUNT(*) FROM plans WHERE is_default = 1) AS plan_por_defecto;
