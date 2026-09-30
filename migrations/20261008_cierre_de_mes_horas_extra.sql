-- ============================================================================
-- Cierre de mes de horas extra (bloque B5)
-- ============================================================================
--
-- Por que existe: el informe para liquidacion de un mes tiene que ser el
-- MISMO aunque despues alguien corrija un fichaje, cargue una licencia o
-- cambie un tope. Al cerrar el mes se guarda una foto del resultado de cada
-- persona; el informe de un mes cerrado sale de esa foto, no se recalcula.
--
-- La foto tambien resuelve el TOPE ANUAL: para saber cuanto le queda a una
-- persona en octubre hay que saber cuanto se le computo de enero a
-- septiembre, y eso es la suma de los meses ya cerrados de ese año.
--
-- Nada se borra ni se modifica (append-only, igual que el resto de las
-- auditorias del sistema):
--   overtime_period_closings  cada CERRAR o REABRIR, con quien y cuando. El
--                             estado de un mes es su ultima accion.
--   overtime_period_results   la foto de cada persona, atada a UN cierre. Si
--                             el mes se reabre y se vuelve a cerrar, queda la
--                             foto vieja (para auditoria) y una nueva.
--
-- Idempotente. Sin cierres cargados, nada cambia.
-- ============================================================================

CREATE TABLE IF NOT EXISTS overtime_period_closings (
  id INT NOT NULL AUTO_INCREMENT,
  tenant_id INT NOT NULL,
  periodo CHAR(7) NOT NULL,               -- 'AAAA-MM'
  accion ENUM('CERRAR', 'REABRIR') NOT NULL,
  motivo VARCHAR(255) NULL,               -- obligatorio para REABRIR
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_period_closings_tenant_periodo (tenant_id, periodo, id),
  CONSTRAINT fk_period_closings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS overtime_period_results (
  id INT NOT NULL AUTO_INCREMENT,
  closing_id INT NOT NULL,
  tenant_id INT NOT NULL,
  periodo CHAR(7) NOT NULL,
  employee_id INT NOT NULL,               -- employees.id (interno)
  legajo INT NULL,                        -- copia: el informe no depende de que la persona siga existiendo
  nombre VARCHAR(200) NULL,
  convenio VARCHAR(120) NULL,
  regimen VARCHAR(120) NULL,
  con_regimen TINYINT(1) NOT NULL DEFAULT 0,
  reales INT NOT NULL DEFAULT 0,
  computables INT NOT NULL DEFAULT 0,     -- del regimen (va al tope anual)
  manuales INT NOT NULL DEFAULT 0,        -- cargadas a mano
  a_liquidar INT NOT NULL DEFAULT 0,      -- lo que se paga: computables + manuales (o la HE de siempre sin regimen)
  excedente INT NOT NULL DEFAULT 0,
  pendiente INT NOT NULL DEFAULT 0,
  registradas INT NOT NULL DEFAULT 0,     -- horas de dedicacion (no se pagan)
  no_computadas INT NOT NULL DEFAULT 0,
  por_recargo JSON NULL,                  -- { "50": minutos, "100": minutos, ... }
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_results_closing_employee (closing_id, employee_id),
  KEY idx_period_results_tenant_periodo (tenant_id, periodo, employee_id),
  CONSTRAINT fk_period_results_closing FOREIGN KEY (closing_id) REFERENCES overtime_period_closings(id),
  CONSTRAINT fk_period_results_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SELECT 'cierre de mes de horas extra: listo' AS resultado;
