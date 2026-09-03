-- ============================================================
-- Diagnostico de esquema: que migraciones de migrations/ ya estan
-- aplicadas en la base de PRODUCCION (Clever Cloud) y cuales faltan.
--
-- Es de solo lectura (INFORMATION_SCHEMA), no modifica nada. Correlo
-- contra produccion y compara cada fila con la columna "Si existe"
-- de abajo antes de correr NINGUN archivo de migrations/ -- varios
-- usan ALTER TABLE ADD COLUMN sin IF NOT EXISTS, y van a fallar con
-- "columna ya existe" si se corren dos veces.
--
-- No hay tabla de control de migraciones en este proyecto (no hay
-- ningun schema_migrations) -- este script reemplaza esa falta.
-- ============================================================

SELECT 'work_schedule_templates.is_default' AS chequeo,
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='work_schedule_templates' AND COLUMN_NAME='is_default') AS existe
UNION ALL
SELECT 'event_types.active',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='event_types' AND COLUMN_NAME='active')
UNION ALL
SELECT 'userexclusions.event_type_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='userexclusions' AND COLUMN_NAME='event_type_id')
UNION ALL
SELECT 'tabla employee_leave_balances',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employee_leave_balances')
UNION ALL
SELECT 'tabla employee_categories',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employee_categories')
UNION ALL
SELECT 'employees.category_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employees' AND COLUMN_NAME='category_id')
UNION ALL
SELECT 'employees.categoria (obsoleta, ver nota)',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employees' AND COLUMN_NAME='categoria')
UNION ALL
SELECT 'employees.exclude_from_report',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employees' AND COLUMN_NAME='exclude_from_report')
UNION ALL
SELECT 'employees.tenant_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employees' AND COLUMN_NAME='tenant_id')
UNION ALL
SELECT 'tabla tenants',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='tenants')
UNION ALL
SELECT 'tabla app_users',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='app_users')
UNION ALL
SELECT 'tabla user_permissions',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='user_permissions')
UNION ALL
SELECT 'holidays.tenant_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='holidays' AND COLUMN_NAME='tenant_id')
UNION ALL
SELECT 'event_types.tenant_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='event_types' AND COLUMN_NAME='tenant_id')
UNION ALL
SELECT 'employee_categories.tenant_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='employee_categories' AND COLUMN_NAME='tenant_id')
UNION ALL
SELECT 'Checkins indice idx_checkins_checktime',
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='Checkins' AND INDEX_NAME='idx_checkins_checktime')
UNION ALL
SELECT 'tabla roles',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='roles')
UNION ALL
SELECT 'tabla role_permissions',
  EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='role_permissions')
UNION ALL
SELECT 'app_users.role_id',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='app_users' AND COLUMN_NAME='role_id')
UNION ALL
SELECT 'specialusers.direction',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='specialusers' AND COLUMN_NAME='direction')
UNION ALL
SELECT 'users.isExcluded',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='users' AND COLUMN_NAME='isExcluded')
UNION ALL
SELECT 'holidays.name',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='holidays' AND COLUMN_NAME='name')
UNION ALL
SELECT 'holidays.type',
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='holidays' AND COLUMN_NAME='type');
