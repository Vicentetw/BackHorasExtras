-- Bug real reportado por el superadmin: creo una cuenta nueva a mano sin
-- asignarle plan ni permisos (para simular "un cliente que todavia no
-- pago") y en vez de una pantalla entendible, el usuario cayo en
-- /acceso-denegado con un mensaje tecnico ("te falta el permiso
-- employees:read") -- no tenia ninguna forma de pedir que le armen un
-- plan. subscriptionStatus en /api/app-users/me quedaba en null tanto para
-- "sin empresa" (superadmin) como para "con empresa pero sin suscripcion
-- todavia" -- dos casos bien distintos que permission-guard.ts no podia
-- distinguir.
--
-- plan_requests es la version de "solicitar el link de pago"
-- (payment_requested_at) pero para ANTES de tener siquiera una suscripcion
-- armada -- no puede vivir en tenant_subscriptions porque esa tabla exige
-- plan_id (todavia no hay ninguno elegido).
CREATE TABLE IF NOT EXISTS plan_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  requested_by INT NULL,
  phone VARCHAR(50) NULL,
  contact_preference ENUM('whatsapp','llamada','email') NOT NULL DEFAULT 'whatsapp',
  employee_count INT NULL,
  clock_count INT NULL,
  schedule_type VARCHAR(255) NULL,
  status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  CONSTRAINT fk_plan_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_plan_requests_user FOREIGN KEY (requested_by) REFERENCES app_users(id)
);

SELECT 'plan_requests aplicada correctamente' AS resultado;
