-- Saldo de vacaciones asignado por empleado y año (carga manual por admin).
CREATE TABLE IF NOT EXISTS employee_leave_balances (
  id INT NOT NULL AUTO_INCREMENT,
  employee_id INT NOT NULL,
  year INT NOT NULL,
  allotted_days DECIMAL(5,2) NOT NULL DEFAULT 0,
  notes VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_leave_balance (employee_id, year),
  KEY idx_employee_leave_balances_employee (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
