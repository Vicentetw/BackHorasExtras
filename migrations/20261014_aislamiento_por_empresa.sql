-- ============================================================================
-- Aislamiento por empresa (AISLAMIENTO_POR_EMPRESA.md, letras B, C, D, E, F, I)
-- ============================================================================
--
-- QUE HACE: los datos "globales" (tenant_id NULL) que en realidad eran de AVP
-- pasan a ser de AVP. Despues de esto, cada empresa tiene solo lo suyo.
--
-- ORDEN DE PUBLICACION (importante):
--   1. Correr ESTA migracion.
--   2. Recien despues, publicar el codigo nuevo.
-- Con el codigo de hoy, correr esto no cambia NADA: ese codigo lee "lo de la
-- empresa O lo global", asi que encuentra los mismos datos (ahora como de
-- AVP). El codigo nuevo lee solo lo de la empresa; si se publicara ANTES de
-- esta migracion, AVP dejaria de ver los feriados 02/04 y 03/04 y sus valores
-- de configuracion.
--
-- Se puede correr mas de una vez: cada paso mira si ya esta hecho.
-- Solo actua si existe la empresa AVP (id 6, nombre 'avp'); si no, no hace nada.
-- Las cargas manuales de horas sin empresa pasan a AVP (decision del dueño,
-- 2026-10-06): produccion tiene una sola empresa, asi que son suyas.
-- ============================================================================

SET @avp := (SELECT id FROM tenants WHERE id = 6 AND LOWER(name) = 'avp');

-- ---------------------------------------------------------------- B. Feriados
-- Los que AVP no tiene propios (misma fecha y misma ciudad) pasan a AVP...
UPDATE holidays g
SET g.tenant_id = @avp
WHERE @avp IS NOT NULL AND g.tenant_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT date, ciudad_id FROM holidays WHERE tenant_id = 6) propio
    WHERE propio.date = g.date AND propio.ciudad_id <=> g.ciudad_id
  );
-- ...y los que AVP ya tenia repetidos se borran (el de AVP queda).
DELETE FROM holidays WHERE @avp IS NOT NULL AND tenant_id IS NULL;

-- --------------------------------------------------- C. Horario por fecha
UPDATE companyschedule g
SET g.tenant_id = @avp
WHERE @avp IS NOT NULL AND g.tenant_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT scheduleDate FROM companyschedule WHERE tenant_id = 6) propio
    WHERE propio.scheduleDate = g.scheduleDate
  );
DELETE FROM companyschedule WHERE @avp IS NOT NULL AND tenant_id IS NULL;

-- ------------------------------------- D. Ciudades, sucursales y catalogos
-- "trelew" (en minuscula) es un duplicado de "Trelew" que nadie usa (ni
-- empleados, ni sucursales, ni feriados): se borra en vez de moverla, porque
-- al quedar las dos en AVP chocarian (el nombre no distingue mayusculas).
DELETE c FROM ciudades c
WHERE @avp IS NOT NULL AND c.tenant_id IS NULL
  AND EXISTS (SELECT 1 FROM (SELECT id, nombre FROM ciudades WHERE tenant_id IS NULL) otra
              WHERE otra.id < c.id AND LOWER(otra.nombre) = LOWER(c.nombre))
  AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.ciudad_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM (SELECT ciudad_id FROM sucursales) s WHERE s.ciudad_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM (SELECT ciudad_id FROM holidays) h WHERE h.ciudad_id = c.id);
UPDATE ciudades c
SET c.tenant_id = @avp
WHERE @avp IS NOT NULL AND c.tenant_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM (SELECT nombre FROM ciudades WHERE tenant_id = 6) propia
                  WHERE LOWER(propia.nombre) = LOWER(c.nombre));
UPDATE sucursales SET tenant_id = @avp WHERE @avp IS NOT NULL AND tenant_id IS NULL;

UPDATE employee_categories c
SET c.tenant_id = @avp
WHERE @avp IS NOT NULL AND c.tenant_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM (SELECT name FROM employee_categories WHERE tenant_id = 6) propia
                  WHERE LOWER(propia.name) = LOWER(c.name));

-- La regla de 50 % apunta al convenio 1 (CCT 572/09), que es de AVP.
UPDATE day_type_overtime_rules r
SET r.tenant_id = @avp
WHERE @avp IS NOT NULL AND r.tenant_id IS NULL
  AND (r.convention_id IS NULL OR r.convention_id IN (SELECT id FROM labor_conventions WHERE tenant_id = 6));

-- Regimen de pago: si AVP no tiene uno propio, el global pasa a ser suyo.
UPDATE payroll_regime_settings g
SET g.tenant_id = @avp
WHERE @avp IS NOT NULL AND g.tenant_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM payroll_regime_settings WHERE tenant_id = 6) propio);
DELETE FROM payroll_regime_settings WHERE @avp IS NOT NULL AND tenant_id IS NULL;

-- ------------------------------------------------------- E. Configuracion
-- AVP recibe copia propia de cada valor global que hoy usa sin tenerlo propio.
-- Quedan globales solo los de la PLATAFORMA (no de una empresa): el Telegram
-- del dueño, el contador del chat de ventas y el firewall de la landing.
INSERT INTO app_settings (tenant_id, name, value)
SELECT @avp, g.name, g.value
FROM app_settings g
WHERE @avp IS NOT NULL AND g.tenant_id IS NULL
  AND g.name NOT IN ('telegramChatIds', 'chatVentasContadorDiario', 'firewallAllowedCountries', 'firewallAllowedIps')
  AND NOT EXISTS (SELECT 1 FROM (SELECT name FROM app_settings WHERE tenant_id = 6) propio WHERE propio.name = g.name);
DELETE FROM app_settings
WHERE @avp IS NOT NULL AND tenant_id IS NULL
  AND name NOT IN ('telegramChatIds', 'chatVentasContadorDiario', 'firewallAllowedCountries', 'firewallAllowedIps');

-- ------------------------------------------------- F. Escala de vacaciones
-- La global (14/21/25/30) es la de AVP: pasa a ser suya si no tiene una.
UPDATE vacation_scale g
SET g.tenant_id = @avp
WHERE @avp IS NOT NULL AND g.tenant_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM vacation_scale WHERE tenant_id = 6) propia);
DELETE FROM vacation_scale WHERE @avp IS NOT NULL AND tenant_id IS NULL;

-- --------------------------------------------------------------- I. Limpieza
-- Restos de importaciones viejas sin empresa (nombres y DNI sin dueño).
DELETE FROM staging_employees WHERE @avp IS NOT NULL AND tenant_id IS NULL;

-- Cargas manuales de horas sin empresa: pasan a AVP. (La migracion 20260927
-- no pudo deducirles la empresa porque el empleado ya no esta en `users`.)
UPDATE ManualEntries
SET tenant_id = @avp
WHERE @avp IS NOT NULL AND tenant_id IS NULL;

-- ---------------------------------------------------------------- Control
-- Lo que deberia quedar sin empresa despues de correr esto: solo el usuario
-- los 4 valores de plataforma (app_settings) y nada mas.
SELECT 'holidays' AS tabla, COUNT(*) AS sin_empresa FROM holidays WHERE tenant_id IS NULL
UNION ALL SELECT 'companyschedule', COUNT(*) FROM companyschedule WHERE tenant_id IS NULL
UNION ALL SELECT 'ciudades', COUNT(*) FROM ciudades WHERE tenant_id IS NULL
UNION ALL SELECT 'sucursales', COUNT(*) FROM sucursales WHERE tenant_id IS NULL
UNION ALL SELECT 'employee_categories', COUNT(*) FROM employee_categories WHERE tenant_id IS NULL
UNION ALL SELECT 'day_type_overtime_rules', COUNT(*) FROM day_type_overtime_rules WHERE tenant_id IS NULL
UNION ALL SELECT 'payroll_regime_settings', COUNT(*) FROM payroll_regime_settings WHERE tenant_id IS NULL
UNION ALL SELECT 'vacation_scale', COUNT(*) FROM vacation_scale WHERE tenant_id IS NULL
UNION ALL SELECT 'staging_employees', COUNT(*) FROM staging_employees WHERE tenant_id IS NULL
UNION ALL SELECT 'ManualEntries', COUNT(*) FROM ManualEntries WHERE tenant_id IS NULL
UNION ALL SELECT 'app_settings (solo plataforma)', COUNT(*) FROM app_settings WHERE tenant_id IS NULL;
