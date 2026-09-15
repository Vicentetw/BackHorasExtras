-- Bug real encontrado (re-auditoria del motor diario, Fase 20): la
-- migracion 20260722_add_tenant_to_catalogs.sql agrego tenant_id a
-- holidays, event_types y employee_categories, pero solo actualizo el
-- UNIQUE KEY de employee_categories (uq_employee_category_name ->
-- uq_employee_category_tenant_name). holidays se quedo con
-- uq_holiday_date UNICO SOBRE `date` SOLA -- dos empresas distintas no
-- podian tener un feriado en la misma fecha (el INSERT de la segunda
-- fallaba con ER_DUP_ENTRY). Se reemplaza por unico POR EMPRESA, mismo
-- patron ya usado para employee_categories.
ALTER TABLE holidays DROP INDEX uq_holiday_date;
ALTER TABLE holidays ADD UNIQUE KEY uq_holiday_tenant_date (tenant_id, date);
