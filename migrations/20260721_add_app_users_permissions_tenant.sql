-- Paso 2a del plan multi-tenant: identidad de la app (mas alla del login de
-- Firebase, que solo dice "quien sos") + permisos granulares por
-- modulo:accion + el tenant real de la empresa (hoy los 477 empleados
-- activos no tienen tenant_id asignado, quedan huerfanos del filtro que se
-- va a aplicar en el siguiente paso).

CREATE TABLE IF NOT EXISTS app_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  firebase_uid VARCHAR(128) NOT NULL,
  email VARCHAR(255) NOT NULL,
  tenant_id INT NULL,              -- NULL solo tiene sentido para superadmin
  is_superadmin TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_app_users_firebase_uid (firebase_uid),
  KEY idx_app_users_tenant (tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INT NOT NULL,
  permission VARCHAR(50) NOT NULL, -- ej: 'employees:read', 'employees:write'
  PRIMARY KEY (user_id, permission),
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

-- Tenant real de la empresa (placeholder de nombre -- se puede renombrar
-- despues con un simple UPDATE, no hace falta otra migracion).
INSERT INTO tenants (name, code, timezone)
SELECT 'Empresa Principal', 'principal', 'America/Argentina/Buenos_Aires'
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE code = 'principal');

-- Migra los empleados sin tenant (los reales, no los de prueba AVP2) al
-- tenant real recien creado.
UPDATE employees e
JOIN tenants t ON t.code = 'principal'
SET e.tenant_id = t.id
WHERE e.tenant_id IS NULL;

-- Superadmin: ve todas las empresas, salta el filtro de tenant.
INSERT INTO app_users (firebase_uid, email, tenant_id, is_superadmin)
SELECT '8F5FJYCLwHSLSgEzBDhDo1UcOP33', 'perrottavicente@gmail.com', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE firebase_uid = '8F5FJYCLwHSLSgEzBDhDo1UcOP33');
