-- Complemento de 20260905_tenant_scope_app_settings.sql: esa migracion dejo
-- sin ningun UNIQUE KEY sobre (name, tenant_id), confiando en que el
-- DELETE+INSERT transaccional del repositorio evitara duplicados -- pero
-- eso NO es atomico frente a dos requests concurrentes (dos DELETE pueden
-- correr antes de que cualquiera de los dos INSERT exista, dejando dos
-- filas globales para el mismo nombre). Se detecto en la practica:
-- test/overtime-authorization-mode.test.js dejo DOS filas
-- 'overtimeAuthorizationMode' con tenant_id NULL, y el motor de horas
-- extra eligio una al azar (LIMIT 1 sin desempate), dando un total de HE
-- muy distinto al esperado en /attendance-range.
--
-- MySQL no puede poner una UNIQUE KEY directa sobre una columna NULL-able
-- y esperar que dos NULL cuenten como iguales (los trata como distintos) --
-- se resuelve con una columna generada que reemplaza NULL por un sentinel
-- concreto (-1, ningun tenant real usa ese id) y la UNIQUE KEY va sobre esa
-- columna generada en vez de tenant_id directo.
-- Deduplicar PRIMERO (se queda con la fila de id mas alto -- la mas
-- reciente -- para cada (name, tenant_id)) -- agregar la UNIQUE KEY de
-- abajo falla si todavia hay duplicados.
DELETE t1 FROM app_settings t1
INNER JOIN app_settings t2
  ON t1.name = t2.name
  AND t1.tenant_id <=> t2.tenant_id
  AND t1.id < t2.id;

ALTER TABLE app_settings
  ADD COLUMN tenant_key INT GENERATED ALWAYS AS (COALESCE(tenant_id, -1)) STORED,
  ADD UNIQUE KEY uniq_app_settings_name_tenant (name, tenant_key);
