-- Reemplaza el campo de texto libre employees.categoria por un catálogo real,
-- para poder renombrar/desactivar categorías sin que queden variantes por typos.
CREATE TABLE IF NOT EXISTS employee_categories (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_category_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE employees
  DROP COLUMN categoria,
  ADD COLUMN category_id INT NULL AFTER activo,
  ADD KEY idx_employees_category (category_id);
