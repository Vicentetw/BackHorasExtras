-- ============================================================================
-- Áreas y usuarios limitados a sus áreas (2026-10-26, punto Q de
-- REVISION_PROFUNDA_2026-10-26.md, sección 8)
-- ============================================================================
--
-- POR QUE: un supervisor tiene que ver y tocar solo a su gente. Hasta ahora
-- los permisos valían para toda la empresa. Así lo hacen Factorial y Buk:
-- cada empleado pertenece a un área y a un usuario se le dice qué áreas ve.
--
-- QUE AGREGA (nada se borra ni se renombra):
--   tabla areas           las áreas de cada empresa ("Depósito", "Ventas"...),
--                         las crea su administrador.
--   employees.area_id     a qué área pertenece cada empleado (NULL = ninguna).
--   tabla app_user_areas  qué áreas ve cada usuario. Un usuario SIN filas acá
--                         ve toda la empresa, como siempre: a nadie le cambia
--                         nada hasta que se le elijan áreas.
--
-- ORDEN DE PUBLICACION: da igual. Sin la migración, la pantalla no ofrece
-- áreas y todos ven toda la empresa (como hoy). Se puede correr más de una vez.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS areas (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  tenant_id   INT NOT NULL,
  nombre      VARCHAR(100) NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_areas_tenant_nombre (tenant_id, nombre),
  CONSTRAINT fk_areas_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'area_id');
SET @s := IF(@c = 0,
  "ALTER TABLE employees ADD COLUMN area_id INT NULL, ADD KEY idx_employees_area (area_id), ADD CONSTRAINT fk_employees_area FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE SET NULL",
  "SELECT 'employees ya tenía area_id' AS aviso");
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS app_user_areas (
  user_id  INT NOT NULL,
  area_id  INT NOT NULL,
  PRIMARY KEY (user_id, area_id),
  CONSTRAINT fk_user_areas_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_areas_area FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE CASCADE
);

-- Control.
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('areas', 'app_user_areas')) AS tablas_nuevas,
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'area_id') AS columna_area;
