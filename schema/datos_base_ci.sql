-- ============================================================================
-- Datos minimos para que la suite corra sobre una base vacia (CI)
-- ============================================================================
--
-- Solo catalogos GLOBALES y empresas de prueba. NUNCA datos de empleados ni
-- fichajes: este repo es publico.
--
--   - tenants 4 y 6: varios tests los dan por sentado (4 = "AVP2", la empresa
--     de fixture de desarrollo; 6 = la empresa real en produccion). Aca son
--     empresas vacias con nombre generico. Los tests que necesitan los DATOS
--     reales de la empresa 6 se saltean solos si no los encuentran (ver
--     test-helpers/datosReales.js).
--   - roles de sistema + sus permisos: los cargaba la migracion
--     20260902_add_roles.sql, anterior a la foto de estructura.
--   - plans: los planes de facturacion.
--
-- Regenerar con: bash scripts/generar-esquema-ci.sh
-- ============================================================================

INSERT INTO `tenants` (id, name, code) VALUES (4, 'AVP2 (fixture de desarrollo)', 'avp2');
INSERT INTO `tenants` (id, name, code) VALUES (6, 'Empresa 6 (CI, sin datos)', 'empresa-6-ci');
INSERT INTO `roles` VALUES (1,'Administrador de Empresa','Acceso completo a todos los modulos dentro de su propia empresa, incluyendo gestion de usuarios.',1,'2026-09-02 18:35:33');
INSERT INTO `roles` VALUES (2,'Solo Lectura / Reportes','Puede ver y exportar informes de todos los modulos, sin poder crear, editar ni borrar nada.',1,'2026-09-02 18:35:33');
INSERT INTO `roles` VALUES (3,'RRHH - Ausencias y Licencias','Gestiona justificaciones, licencias y motivos de ausencia. Ve empleados y asistencia sin poder modificarlos.',1,'2026-09-02 18:35:33');
INSERT INTO `roles` VALUES (4,'Feriados','Solo puede gestionar el calendario de feriados. Ve el resto de los modulos sin poder modificarlos.',1,'2026-09-02 18:35:33');
INSERT INTO `role_permissions` VALUES (1,'attendance:create');
INSERT INTO `role_permissions` VALUES (1,'attendance:delete');
INSERT INTO `role_permissions` VALUES (1,'attendance:read');
INSERT INTO `role_permissions` VALUES (1,'attendance:update');
INSERT INTO `role_permissions` VALUES (1,'employees:create');
INSERT INTO `role_permissions` VALUES (1,'employees:delete');
INSERT INTO `role_permissions` VALUES (1,'employees:read');
INSERT INTO `role_permissions` VALUES (1,'employees:update');
INSERT INTO `role_permissions` VALUES (1,'exclusions:create');
INSERT INTO `role_permissions` VALUES (1,'exclusions:delete');
INSERT INTO `role_permissions` VALUES (1,'exclusions:read');
INSERT INTO `role_permissions` VALUES (1,'exclusions:update');
INSERT INTO `role_permissions` VALUES (1,'holidays:create');
INSERT INTO `role_permissions` VALUES (1,'holidays:delete');
INSERT INTO `role_permissions` VALUES (1,'holidays:read');
INSERT INTO `role_permissions` VALUES (1,'holidays:update');
INSERT INTO `role_permissions` VALUES (1,'leaves:create');
INSERT INTO `role_permissions` VALUES (1,'leaves:delete');
INSERT INTO `role_permissions` VALUES (1,'leaves:read');
INSERT INTO `role_permissions` VALUES (1,'leaves:update');
INSERT INTO `role_permissions` VALUES (1,'matching:create');
INSERT INTO `role_permissions` VALUES (1,'matching:delete');
INSERT INTO `role_permissions` VALUES (1,'matching:read');
INSERT INTO `role_permissions` VALUES (1,'matching:update');
INSERT INTO `role_permissions` VALUES (1,'schedules:create');
INSERT INTO `role_permissions` VALUES (1,'schedules:delete');
INSERT INTO `role_permissions` VALUES (1,'schedules:read');
INSERT INTO `role_permissions` VALUES (1,'schedules:update');
INSERT INTO `role_permissions` VALUES (1,'settings:create');
INSERT INTO `role_permissions` VALUES (1,'settings:delete');
INSERT INTO `role_permissions` VALUES (1,'settings:read');
INSERT INTO `role_permissions` VALUES (1,'settings:update');
INSERT INTO `role_permissions` VALUES (1,'users:create');
INSERT INTO `role_permissions` VALUES (1,'users:delete');
INSERT INTO `role_permissions` VALUES (1,'users:read');
INSERT INTO `role_permissions` VALUES (1,'users:update');
INSERT INTO `role_permissions` VALUES (2,'attendance:read');
INSERT INTO `role_permissions` VALUES (2,'employees:read');
INSERT INTO `role_permissions` VALUES (2,'exclusions:read');
INSERT INTO `role_permissions` VALUES (2,'holidays:read');
INSERT INTO `role_permissions` VALUES (2,'leaves:read');
INSERT INTO `role_permissions` VALUES (2,'matching:read');
INSERT INTO `role_permissions` VALUES (3,'attendance:read');
INSERT INTO `role_permissions` VALUES (3,'employees:read');
INSERT INTO `role_permissions` VALUES (3,'exclusions:create');
INSERT INTO `role_permissions` VALUES (3,'exclusions:read');
INSERT INTO `role_permissions` VALUES (3,'exclusions:update');
INSERT INTO `role_permissions` VALUES (3,'holidays:read');
INSERT INTO `role_permissions` VALUES (3,'leaves:create');
INSERT INTO `role_permissions` VALUES (3,'leaves:read');
INSERT INTO `role_permissions` VALUES (3,'leaves:update');
INSERT INTO `role_permissions` VALUES (4,'attendance:read');
INSERT INTO `role_permissions` VALUES (4,'employees:read');
INSERT INTO `role_permissions` VALUES (4,'holidays:create');
INSERT INTO `role_permissions` VALUES (4,'holidays:delete');
INSERT INTO `role_permissions` VALUES (4,'holidays:read');
INSERT INTO `role_permissions` VALUES (4,'holidays:update');
INSERT INTO `plans` VALUES (1,'Plan estándar 1 usuario',18.00,2.20,10,10,5.00,10.00,17.00,1,1,'2026-09-05 19:21:23','2026-09-10 01:25:42');
INSERT INTO `plans` VALUES (2,'Plan 15',18.00,2.20,15,15,5.00,10.00,17.00,1,0,'2026-09-06 02:33:47','2026-09-07 19:12:42');
INSERT INTO `plans` VALUES (3,'Plan 50',18.00,2.20,50,NULL,5.00,10.00,17.00,1,0,'2026-09-06 02:36:09','2026-09-06 02:36:09');
INSERT INTO `plans` VALUES (4,'Plan 100',18.00,2.20,100,NULL,5.00,10.00,17.00,1,0,'2026-09-06 02:36:33','2026-09-06 02:36:33');
