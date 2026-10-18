-- ============================================================================
-- Cómo se cuentan las horas extra, por plantilla (2026-10-17)
-- ============================================================================
--
-- POR QUE: en la pantalla "Horas extra", cada empresa elige cómo se cuentan
-- (marcas del reloj, o lo que supera el horario) y una plantilla puede tener
-- su propia excepción: otro método, si llegar antes cuenta y un mínimo de
-- minutos. Lo de la empresa se guarda en app_settings (no necesita esto).
--
-- QUE AGREGA (nada se borra ni se renombra): la tabla plantilla_horas_extra.
-- Una fila por plantilla con excepción; sin fila = vale lo de la empresa.
--
-- ORDEN DE PUBLICACION: da igual. Sin la migración, las excepciones por
-- plantilla no se pueden guardar (la pantalla avisa) y todo usa lo de la
-- empresa. Se puede correr más de una vez.
-- ============================================================================

CREATE TABLE IF NOT EXISTS plantilla_horas_extra (
  template_id            INT NOT NULL PRIMARY KEY,
  tenant_id              INT NOT NULL,
  metodo                 VARCHAR(24) NULL,          -- MARCAS_O_ESTIMADO | MARCAS_O_EXCESO | EXCESO | MARCAS | NULL = el de la empresa
  contar_llegada         TINYINT NULL,              -- 1 = llegar antes cuenta, 0 = no, NULL = lo de la empresa
  minimo                 INT NULL,                  -- minutos; NULL = el del convenio o la empresa
  actualizado_por_email  VARCHAR(255) NULL,
  actualizado_en         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_plantilla_he_tenant (tenant_id)
);

-- Control.
SELECT COUNT(*) AS tabla_plantilla_horas_extra FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plantilla_horas_extra';
