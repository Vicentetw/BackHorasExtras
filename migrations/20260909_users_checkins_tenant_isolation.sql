-- Fase 19 -- arreglo de raiz del hallazgo real de la re-auditoria de venta
-- (9 sep 2026, ver AUDITORIA_Y_ROADMAP_VENTA.md): users/Checkins/
-- user_employee_map son de ANTES de que existiera el concepto de "empresa"
-- en este sistema y nunca tuvieron tenant_id -- USERID es PRIMARY KEY de
-- 'users' y de 'user_employee_map', GLOBAL a todo el sistema. Con una sola
-- empresa real (la actual) nunca se nota. En cuanto una segunda empresa
-- real sincronice su propio reloj (que casi seguro numera sus USERID
-- tambien desde 1/2/3, la numeracion por defecto de estos equipos):
--   1) La pantalla de Matching ya mostraria (de hecho ya muestra, mezclado
--      con lo que haya) nombres/legajos de la otra empresa en la lista de
--      "usuarios sin vincular" -- esas tablas no tienen de donde filtrar.
--   2) Sincronizar el agente de la 2da empresa pisaria en SILENCIO el
--      nombre/legajo de un empleado de la 1ra empresa que comparta el
--      mismo USERID (upsertUsersBatch trata un USERID existente como
--      "actualizar", no como conflicto), y sus fichajes (Checkins) quedan
--      mezclados bajo el mismo USERID sin forma de separarlos despues.
--
-- Alcance ampliado durante la migracion: 'specialusers' (Marcadores) y
-- 'userexclusions' (Justificaciones) tienen el MISMO problema (sin
-- tenant_id propio) Y ademas una foreign key hacia users.USERID -- una vez
-- que USERID deja de ser unico por si solo (pasa a serlo solo junto con
-- tenant_id), esa FK ya no es sostenible tal cual, asi que quedan
-- arrastradas al mismo arreglo. 'dailyattendance'/'dayassignments' tambien
-- tienen una FK hacia users pero estan vacias y sin uso (0 filas, 0
-- referencias en codigo, ya señalado en el audit de julio) -- alcanza con
-- sacarles la FK para no bloquear el resto.
--
-- Backfill: todo lo que existe hoy es de la unica empresa real -- mismo
-- criterio ya usado en 20260722_add_tenant_to_catalogs.sql (tenant_id=6,
-- "Empresa Principal").
--
-- Migracion de un solo uso (no idempotente a proposito, mismo estilo que
-- 20260722_add_tenant_to_catalogs.sql) -- correr UNA vez.

-- ============ Sacar las FK muertas que bloquean el resto ============
ALTER TABLE dailyattendance DROP FOREIGN KEY dailyattendance_ibfk_1;
ALTER TABLE dayassignments DROP FOREIGN KEY dayassignments_ibfk_1;

-- ============ Sacar temporalmente las FK vivas hacia users/user_employee_map ============
-- (se vuelven a crear mas abajo, ya compuestas por tenant_id+USERID)
ALTER TABLE specialusers DROP FOREIGN KEY specialusers_ibfk_1;
ALTER TABLE userexclusions DROP FOREIGN KEY userexclusions_ibfk_1;

-- ============ users ============
ALTER TABLE users ADD COLUMN tenant_id INT NULL AFTER USERID;
UPDATE users SET tenant_id = 6 WHERE tenant_id IS NULL;
ALTER TABLE users MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE users
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (tenant_id, USERID),
  DROP INDEX unique_badgenumber,
  ADD UNIQUE KEY uq_users_tenant_badge (tenant_id, Badgenumber),
  ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id);

-- ============ Checkins ============
ALTER TABLE Checkins ADD COLUMN tenant_id INT NULL AFTER USERID;
UPDATE Checkins SET tenant_id = 6 WHERE tenant_id IS NULL;
ALTER TABLE Checkins MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE Checkins
  DROP INDEX uq_checkin,
  ADD UNIQUE KEY uq_checkin (tenant_id, USERID, CHECKTIME),
  ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id);

-- ============ user_employee_map ============
ALTER TABLE user_employee_map ADD COLUMN tenant_id INT NULL AFTER USERID;
UPDATE user_employee_map SET tenant_id = 6 WHERE tenant_id IS NULL;
ALTER TABLE user_employee_map MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE user_employee_map
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (tenant_id, USERID),
  ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id);

-- ============ specialusers (Marcadores) ============
ALTER TABLE specialusers ADD COLUMN tenant_id INT NULL AFTER userId;
UPDATE specialusers SET tenant_id = 6 WHERE tenant_id IS NULL;
ALTER TABLE specialusers MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE specialusers
  DROP INDEX userId,
  ADD UNIQUE KEY uq_specialusers_tenant_user (tenant_id, userId),
  ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  ADD FOREIGN KEY (tenant_id, userId) REFERENCES users(tenant_id, USERID);

-- ============ userexclusions (Justificaciones) ============
ALTER TABLE userexclusions ADD COLUMN tenant_id INT NULL AFTER userId;
UPDATE userexclusions SET tenant_id = 6 WHERE tenant_id IS NULL;
ALTER TABLE userexclusions MODIFY COLUMN tenant_id INT NOT NULL;
ALTER TABLE userexclusions
  DROP INDEX unique_exclusion,
  ADD UNIQUE KEY uq_userexclusions_tenant (tenant_id, userId, excDate, type),
  ADD FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  ADD FOREIGN KEY (tenant_id, userId) REFERENCES users(tenant_id, USERID);
