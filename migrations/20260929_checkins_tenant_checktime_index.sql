-- ============================================================================
-- Indice (tenant_id, CHECKTIME) en Checkins
-- ============================================================================
--
-- POR QUE
-- -------
-- La consulta central de Presentismo y Horas Extra pide los fichajes de UNA
-- empresa en un rango de fechas:
--
--     WHERE c.CHECKTIME >= ? AND c.CHECKTIME < ? AND c.tenant_id = ?
--
-- Los indices que habia no sirven bien para eso:
--   * `idx_checkins_checktime (CHECKTIME)` filtra por fecha pero despues hay
--     que descartar a mano los de las otras empresas;
--   * `uq_checkin (tenant_id, USERID, CHECKTIME)` tiene el tenant primero,
--     pero con USERID en el medio -- para filtrar por fecha sin saber el
--     USERID, MySQL tiene que hacer un "skip scan" (se ve en el EXPLAIN),
--     que es su plan B y cuesta bastante mas.
--
-- Este indice tiene exactamente las dos columnas de la consulta, en el orden
-- correcto: primero la empresa (igualdad), despues la fecha (rango). Es la
-- regla clasica de un indice compuesto.
--
-- Medido contra produccion antes de crearlo: traer un año de fichajes sin
-- joins tardaba 4.788 ms con el skip scan.
--
-- Es solo un indice: no cambia ningun dato ni ninguna consulta. Lo unico que
-- cuesta es un poco mas de espacio y un pelin mas de trabajo al insertar
-- fichajes nuevos, que es despreciable al lado de lo que ahorra al leer.
-- ============================================================================

SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins'
    AND INDEX_NAME = 'idx_checkins_tenant_checktime'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX idx_checkins_tenant_checktime ON Checkins (tenant_id, CHECKTIME)',
  'SELECT "idx_checkins_tenant_checktime ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'indice (tenant_id, CHECKTIME) listo' AS resultado;
