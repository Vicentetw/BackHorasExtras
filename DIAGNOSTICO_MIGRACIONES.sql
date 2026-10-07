-- ============================================================================
-- ¿Qué migraciones ya están aplicadas en esta base? (SOLO LECTURA)
-- ============================================================================
-- No cambia nada: solo mira si existe lo que crea cada migración (una tabla,
-- una columna o un índice). Correr en phpMyAdmin sobre la base de producción.
--   aplicada = 1  -> ya está, no hace falta correrla
--   aplicada = 0  -> falta correrla
-- Las migraciones se pueden correr más de una vez sin problema, pero así se
-- sabe cuáles faltan sin adivinar.

SELECT '20260927 auditoría de cargas manuales' AS migracion,
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ManualEntries' AND COLUMN_NAME = 'created_by') > 0 AS aplicada
UNION ALL SELECT '20260928 horario de empresa por empresa',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companyschedule' AND COLUMN_NAME = 'tenant_id') > 0
UNION ALL SELECT '20260929 índice de fichajes',
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Checkins' AND INDEX_NAME = 'idx_checkins_tenant_checktime') > 0
UNION ALL SELECT '20260930 pagos sin duplicados',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mercadopago_events') > 0
UNION ALL SELECT '20261001 cotización del dólar en pagos',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_records' AND COLUMN_NAME = 'exchange_rate') > 0
UNION ALL SELECT '20261002 chat de la landing',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads' AND COLUMN_NAME = 'chat_token_hash') > 0
UNION ALL SELECT '20261003 corrección de marcadores',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marker_corrections') > 0
UNION ALL SELECT '20261004 afectado a campaña',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'afectado_campana') > 0
UNION ALL SELECT '20261005 cupos por motivo',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_type_quotas') > 0
UNION ALL SELECT '20261006 régimen de horas extra',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'overtime_regime_policies') > 0
UNION ALL SELECT '20261007 regímenes dentro del convenio',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'labor_convention_regimes') > 0
UNION ALL SELECT '20261008 cierre de mes',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'overtime_period_closings') > 0
UNION ALL SELECT '20261009 ajustes de meses anteriores',
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'overtime_period_adjustments') > 0
UNION ALL SELECT '20261010 portal del empleado',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_users' AND COLUMN_NAME = 'employee_id') > 0
UNION ALL SELECT '20261011 titular de la empresa',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'titular_email') > 0
UNION ALL SELECT '20261012 solicitudes de alta',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads' AND COLUMN_NAME = 'reviewed_by') > 0
UNION ALL SELECT '20261013 nombre del reloj',
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_sync_status' AND COLUMN_NAME = 'nombre') > 0
-- 20261014 no crea nada: pasa a AVP los datos sin empresa. Se da por
-- aplicada cuando ya no quedan escala de vacaciones ni cargas manuales sin
-- empresa (antes de correrla hay 4 y 1).
UNION ALL SELECT '20261014 aislamiento por empresa (rama aislamiento-por-empresa)',
  (SELECT COUNT(*) FROM vacation_scale WHERE tenant_id IS NULL) = 0
  AND (SELECT COUNT(*) FROM ManualEntries WHERE tenant_id IS NULL) = 0;
