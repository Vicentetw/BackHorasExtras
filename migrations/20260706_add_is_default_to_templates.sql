-- Migration: Add is_default column to work_schedule_templates
-- Run this on the production DB carefully; ensure no duplicate defaults per tenant.

ALTER TABLE work_schedule_templates
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_templates_tenant_default ON work_schedule_templates (tenant_id, is_default);

-- Optional: if you want to set an existing template as default for tenant 0 (global),
-- run:
-- UPDATE work_schedule_templates SET is_default = 1 WHERE tenant_id = 0 AND id = <template_id>;

-- To enforce at most one default per tenant you could add a partial unique index in MySQL 8
-- or enforce via application logic / trigger.
