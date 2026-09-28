-- ============================================================================
-- Cupo por motivo: "Artículo 55, no más de 6 por año"
-- ============================================================================
--
-- Pedido real (2026-09-28): que las justificaciones y licencias se cuenten y
-- se pueda configurar un tope por motivo, con aviso al pasarse.
--
-- QUE SE GUARDA Y QUE NO
-- ----------------------
-- Aca se guarda SOLO la regla (el tope). El consumo ("lleva 4 de 6") NO se
-- guarda: se calcula cada vez a partir de las licencias, las justificaciones
-- y los fichajes (motor-laboral/services/cupoMotivos.js). Un contador
-- guardado se desincroniza en cuanto alguien edita o borra una licencia; uno
-- calculado siempre dice la verdad.
--
-- POR QUE ES UN HISTORIAL (vigente_desde) Y NO UN VALOR FIJO
-- ----------------------------------------------------------
-- Un convenio o una paritaria puede cambiar el tope ("desde 2027, 8 por
-- año"). Mismo criterio que event_type_count_modes (corridos/habiles): se
-- aplica la vigencia en curso a la fecha que se evalua.
--
-- COLUMNAS
--   max_dias_anio  tope por periodo anual (NULL = sin tope anual)
--   max_dias_mes   tope por mes calendario (NULL = sin tope mensual)
--   periodo        'calendario' (1/1 a 31/12, lo habitual en estatutos y
--                  convenios) | 'aniversario' (desde la fecha de ingreso)
--   al_exceder     'avisar' (default: se puede cargar igual, con
--                  confirmacion) | 'bloquear' (el backend rechaza la carga).
--                  Se eligio avisar como default porque en RRHH bloquear
--                  suele terminar en una ausencia que NO se registra, que es
--                  peor que una registrada por encima del tope.
--
-- ES SEGURA DE CORRER: solo crea una tabla nueva. Idempotente. Sin filas, no
-- cambia nada: un motivo sin cupo cargado sigue exactamente como antes.
-- ============================================================================

SET @tbl_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_type_quotas'
);
SET @sql = IF(@tbl_exists = 0,
  "CREATE TABLE event_type_quotas (
    id INT NOT NULL AUTO_INCREMENT,
    tenant_id INT NOT NULL,
    event_type_id INT NOT NULL,
    max_dias_anio INT NULL,
    max_dias_mes INT NULL,
    periodo ENUM('calendario','aniversario') NOT NULL DEFAULT 'calendario',
    al_exceder ENUM('avisar','bloquear') NOT NULL DEFAULT 'avisar',
    vigente_desde DATE NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_event_type_quotas_vigencia (event_type_id, vigente_desde),
    KEY idx_event_type_quotas_tenant (tenant_id),
    CONSTRAINT fk_event_type_quotas_event_type FOREIGN KEY (event_type_id) REFERENCES event_types(id),
    CONSTRAINT fk_event_type_quotas_created_by FOREIGN KEY (created_by) REFERENCES app_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  'SELECT "event_type_quotas ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'event_type_quotas creada correctamente' AS resultado;
