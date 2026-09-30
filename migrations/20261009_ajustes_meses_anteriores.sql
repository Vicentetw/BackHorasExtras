-- ============================================================================
-- Ajustes de meses anteriores (bloque B5, segunda parte)
-- ============================================================================
--
-- Pedido del dueño del producto (2026-09-30): un mes cerrado se puede seguir
-- corrigiendo, y la diferencia se paga (o se descuenta) al mes siguiente.
--
-- Como funciona: el informe del mes abierto revisa los 3 meses anteriores
-- que esten cerrados. Para cada persona compara lo que da HOY ese mes contra
-- lo que ya se le pago por el (la foto del cierre + los ajustes ya pagados).
-- La diferencia aparece como "ajuste de meses anteriores", con su mes de
-- origen. Al cerrar el mes, esos ajustes se guardan aca como PAGADOS, asi el
-- mes que viene no se vuelven a cobrar.
--
-- Un ajuste pagado vale mientras el mes en que se pago siga cerrado: si ese
-- mes se reabre, el ajuste deja de contar y se recalcula al volver a cerrar.
-- Append-only, como el resto: nada se borra ni se modifica.
--
-- `computables` (la parte del regimen) alimenta el tope anual del año del
-- mes de ORIGEN: esas horas son de ese mes aunque se paguen despues.
-- Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS overtime_period_adjustments (
  id INT NOT NULL AUTO_INCREMENT,
  closing_id INT NOT NULL,                -- cierre del mes en que se PAGA
  tenant_id INT NOT NULL,
  periodo CHAR(7) NOT NULL,               -- mes en que se paga ('AAAA-MM')
  periodo_origen CHAR(7) NOT NULL,        -- mes al que corresponde la diferencia
  employee_id INT NOT NULL,               -- employees.id (interno)
  legajo INT NULL,
  nombre VARCHAR(200) NULL,
  minutos INT NOT NULL,                   -- diferencia a pagar (negativa = descuento)
  computables INT NOT NULL DEFAULT 0,     -- diferencia en lo computable del regimen
  por_recargo JSON NULL,                  -- diferencia por recargo
  PRIMARY KEY (id),
  KEY idx_period_adjustments_closing (closing_id),
  KEY idx_period_adjustments_origen (tenant_id, periodo_origen, employee_id),
  CONSTRAINT fk_period_adjustments_closing FOREIGN KEY (closing_id) REFERENCES overtime_period_closings(id),
  CONSTRAINT fk_period_adjustments_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SELECT 'ajustes de meses anteriores: listo' AS resultado;
