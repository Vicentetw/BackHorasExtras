-- Fase 8 (seguridad/multi-tenant): app_settings pasa de ser 100% global
-- (corte de HE, tope de campana, limite mensual de salida particular, modo
-- de autorizacion de HE, tema, etc. eran una unica fila compartida por
-- TODAS las empresas del mismo backend) a soportar override por tenant,
-- mismo patron que payroll_regime_settings: tenant_id NULL = default
-- global, se prefiere la fila especifica del tenant si existe. Sin esto,
-- el admin de una empresa podia cambiar sin querer la configuracion de
-- otra empresa -- real solo si varias empresas comparten el mismo
-- backend/base (multi-tenant compartido, la decision tomada para este
-- sistema).
--
-- `name` deja de ser PRIMARY KEY (ahora puede repetirse, una fila por
-- tenant) -- pasa a un `id` autoincremental, igual que
-- payroll_regime_settings. No hay UNIQUE KEY sobre (name, tenant_id) a
-- proposito, mismo motivo que alli: MySQL trata cada NULL como distinto
-- para unicidad, asi que no evitaria duplicar la fila global. En su lugar,
-- el repositorio (appSettingsRepository.js) hace DELETE + INSERT dentro de
-- una transaccion para garantizar una sola fila por (name, tenant).
ALTER TABLE app_settings
  DROP PRIMARY KEY,
  ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST,
  ADD COLUMN tenant_id INT NULL AFTER name,
  ADD INDEX idx_app_settings_name_tenant (name, tenant_id);
