-- ============================================================================
-- Arreglo puntual: Aguilar Gabriel (105) y, de paso, BEHR (2454)
-- ============================================================================
--
-- QUE PASO
-- --------
-- Aguilar Gabriel ficha con el usuario de reloj 105, que en el reloj no tiene
-- nombre cargado (aparece como "NN-105"). Al darlo de alta se escribio el
-- nombre "AGUILAR GABRIEL" en el usuario 115 por error, y ademas el empleado
-- se creo SIN empresa (tenant_id NULL).
--
-- Estado verificado en produccion el 2026-09-23:
--
--   usuario de reloj 105  "NN-105"           240 fichadas (04/05 al 22/09)  SIN VINCULO
--   usuario de reloj 115  "AGUILAR GABRIEL"    0 fichadas                   vinculado a BEHR
--   empleado id=516       legajo 105 "Aguilar Grabriel"   tenant_id = NULL
--
-- Un empleado con tenant_id NULL no empareja con ningun usuario de reloj: el
-- JOIN compara `u.tenant_id = e.tenant_id` y en SQL `6 = NULL` no da falso,
-- da NULL. Por eso la pantalla de Matching no lo proponia nunca, aunque el
-- numero del reloj y el legajo coincidieran exactamente.
--
-- Y APARECIO OTRA COSA: BEHR TAMBIEN ESTA MAL
-- --------------------------------------------
-- BEHR, Angel Enrique (legajo 2454, id=219, dado de baja) tiene como UNICO
-- vinculo el usuario 115, que no es suyo y nunca ficho. Su usuario de reloj
-- de verdad es el 2454 ("BEHR"), con 356 fichadas hasta diciembre de 2025,
-- y esta SIN VINCULAR. O sea que sus fichadas historicas no le llegan a
-- ningun informe. Esta de baja, asi que no corre riesgo de acumular mas,
-- pero cualquier reporte del 2025 lo muestra sin horas.
--
-- COMPROBADO ANTES DE ESCRIBIR ESTO
-- ----------------------------------
--   * no hay ningun otro empleado con legajo 105 en la empresa 6 (0 choques);
--   * el usuario 115 tiene CERO fichadas, asi que sacarle el vinculo no mueve
--     ni una hora de nadie.
--
-- COMO CORRERLO
--   mysql -h HOST -P PUERTO -u USUARIO -p BASE < ARREGLO_AGUILAR_105.sql
--
-- Cada paso imprime como quedo. Si algun numero no da lo esperado, PARAR y
-- revisar antes de seguir: esto toca datos reales de personas.
-- ============================================================================

START TRANSACTION;

-- ---------------------------------------------------------------------------
-- 1. Aguilar Gabriel pasa a pertenecer a AVP
-- ---------------------------------------------------------------------------
UPDATE employees SET tenant_id = 6 WHERE id = 516 AND tenant_id IS NULL;

SELECT 'paso 1' AS paso, id, employee_id AS legajo, nombre, tenant_id
FROM employees WHERE id = 516;
-- Esperado: tenant_id = 6

-- ---------------------------------------------------------------------------
-- 2. Sacar el vinculo equivocado 115 -> BEHR
-- ---------------------------------------------------------------------------
-- El 115 no es de BEHR ni de Gabriel: es un usuario de reloj al que se le
-- escribio el nombre por error y que nunca ficho.
DELETE FROM user_employee_map
WHERE USERID = 115 AND tenant_id = 6;

SELECT 'paso 2' AS paso, COUNT(*) AS vinculos_del_115
FROM user_employee_map WHERE USERID = 115 AND tenant_id = 6;
-- Esperado: 0

-- ---------------------------------------------------------------------------
-- 3. Vincular el 105 (el que ficha) con Aguilar Gabriel
-- ---------------------------------------------------------------------------
-- Este paso se puede hacer tambien desde la pantalla de Matching, y es lo
-- preferible: despues del paso 1 la propone sola, porque el numero del reloj
-- (105) coincide con el legajo (105). Se deja aca por si se quiere resolver
-- todo de una.
INSERT INTO user_employee_map (USERID, employee_id, match_type, tenant_id)
SELECT 105, 516, 'manual', 6
WHERE NOT EXISTS (
  SELECT 1 FROM user_employee_map WHERE USERID = 105 AND tenant_id = 6
);

SELECT 'paso 3' AS paso, m.USERID, u.Name AS nombre_reloj,
       e.employee_id AS legajo, e.nombre AS empleado,
       (SELECT COUNT(*) FROM Checkins c
         WHERE c.tenant_id = 6 AND c.USERID = 105) AS fichadas_que_ahora_le_llegan
FROM user_employee_map m
JOIN users u ON u.USERID = m.USERID AND u.tenant_id = m.tenant_id
JOIN employees e ON e.id = m.employee_id
WHERE m.USERID = 105 AND m.tenant_id = 6;
-- Esperado: Aguilar Grabriel, legajo 105, 240 fichadas

-- ---------------------------------------------------------------------------
-- 4. Vincular a BEHR con SU usuario de reloj de verdad
-- ---------------------------------------------------------------------------
INSERT INTO user_employee_map (USERID, employee_id, match_type, tenant_id)
SELECT 2454, 219, 'manual', 6
WHERE NOT EXISTS (
  SELECT 1 FROM user_employee_map WHERE USERID = 2454 AND tenant_id = 6
);

SELECT 'paso 4' AS paso, m.USERID, u.Name AS nombre_reloj,
       e.employee_id AS legajo, e.nombre AS empleado,
       (SELECT COUNT(*) FROM Checkins c
         WHERE c.tenant_id = 6 AND c.USERID = 2454) AS fichadas_que_ahora_le_llegan
FROM user_employee_map m
JOIN users u ON u.USERID = m.USERID AND u.tenant_id = m.tenant_id
JOIN employees e ON e.id = m.employee_id
WHERE m.USERID = 2454 AND m.tenant_id = 6;
-- Esperado: BEHR, Angel Enrique, legajo 2454, 356 fichadas

COMMIT;

-- ============================================================================
-- FALTA UN PASO QUE NO ES SQL, Y SIN EL VUELVE EL PROBLEMA
-- ============================================================================
-- `users.Name` NO se edita desde el sistema: se sobrescribe con lo que diga
-- el reloj en cada sincronizacion de usuarios. Asi que, mientras el reloj
-- siga diciendo que el 115 se llama "AGUILAR GABRIEL" y el 105 no tenga
-- nombre, la proxima sincronizacion vuelve a dejar todo confuso.
--
-- En el reloj hay que:
--   * ponerle el nombre AGUILAR GABRIEL al usuario 105 (el que ficha);
--   * sacarle ese nombre al 115 (o borrar el 115 si no lo usa nadie --
--     tiene cero fichadas desde siempre).
--
-- Recien despues de eso conviene apretar "Solo usuarios" en el agente.
-- ============================================================================
