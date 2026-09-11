-- =====================================================================
-- Foto COMPLETA del esquema de produccion (SOLO estructura, CERO datos).
-- Generada con SHOW CREATE TABLE contra la base real de Clever Cloud el
-- 2026-09-11, para poder levantar una base nueva DESDE CERO sin
-- depender de correr 30+ migraciones incrementales en orden -- las tablas
-- originales (users, Checkins, employees, etc.) son anteriores a la carpeta
-- migrations/ y nunca tuvieron un script de creacion propio hasta este dump.
--
-- Uso (base NUEVA, vacia):
--   export MYSQL_ADDON_HOST=... MYSQL_ADDON_USER=... MYSQL_ADDON_PASSWORD=... MYSQL_ADDON_DB=...
--   node run-sql.js schema/full_schema_snapshot.sql
--
-- Despues de correr esto, la base queda con la MISMA estructura que produccion
-- a la fecha de arriba -- no hace falta correr ninguno de los archivos de
-- migrations/ (todos estan reflejados aca). Si en el futuro se agregan
-- migraciones nuevas DESPUES de esta fecha, esas si hay que correrlas aparte.
-- =====================================================================

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `Checkins`;
CREATE TABLE `Checkins` (
  `id` int NOT NULL AUTO_INCREMENT,
  `USERID` int NOT NULL,
  `tenant_id` int NOT NULL,
  `CHECKTIME` datetime NOT NULL,
  `MACHINE_IP` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `MACHINE_SN` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_checkin` (`tenant_id`,`USERID`,`CHECKTIME`),
  KEY `idx_checkins_machine_sn` (`MACHINE_SN`),
  KEY `idx_checkins_machine_ip` (`MACHINE_IP`),
  KEY `idx_checkins_checktime` (`CHECKTIME`),
  CONSTRAINT `Checkins_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `ManualEntries`;
CREATE TABLE `ManualEntries` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `startDatetime` datetime NOT NULL,
  `endDatetime` datetime NOT NULL,
  `durationMinutes` int NOT NULL,
  `type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `note` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `agent_sync_status`;
CREATE TABLE `agent_sync_status` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `machine_ip` varchar(45) DEFAULT NULL,
  `machine_sn` varchar(45) DEFAULT NULL,
  `last_synced_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_checktime` datetime DEFAULT NULL,
  `fichajes_ultima_subida` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_agent_sync_status_machine` (`tenant_id`,`machine_ip`,`machine_sn`),
  CONSTRAINT `fk_agent_sync_status_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `app_settings`;
CREATE TABLE `app_settings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `tenant_id` int DEFAULT NULL,
  `value` text NOT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `tenant_key` int GENERATED ALWAYS AS (coalesce(`tenant_id`,-(1))) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_app_settings_name_tenant` (`name`,`tenant_key`),
  KEY `idx_app_settings_name_tenant` (`name`,`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `app_users`;
CREATE TABLE `app_users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `firebase_uid` varchar(128) NOT NULL,
  `email` varchar(255) NOT NULL,
  `tenant_id` int DEFAULT NULL,
  `role_id` int DEFAULT NULL,
  `is_superadmin` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_app_users_firebase_uid` (`firebase_uid`),
  KEY `idx_app_users_tenant` (`tenant_id`),
  KEY `idx_app_users_role` (`role_id`),
  CONSTRAINT `app_users_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `fk_app_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `attendance_calculation_results`;
CREATE TABLE `attendance_calculation_results` (
  `id` int NOT NULL AUTO_INCREMENT,
  `run_id` int NOT NULL,
  `date` date NOT NULL,
  `employee_id` int DEFAULT NULL,
  `user_id` int DEFAULT NULL,
  `status` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `scheduled_start` time DEFAULT NULL,
  `scheduled_end` time DEFAULT NULL,
  `first_checkin` datetime DEFAULT NULL,
  `last_checkin` datetime DEFAULT NULL,
  `worked_minutes` int DEFAULT NULL,
  `overtime_minutes` int DEFAULT NULL,
  `night_minutes` int DEFAULT NULL,
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_attendance_calculation_results_run` (`run_id`),
  KEY `idx_attendance_calculation_results_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `attendance_calculation_runs`;
CREATE TABLE `attendance_calculation_runs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `employee_id` int DEFAULT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` enum('PENDING','COMPLETED','FAILED') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'PENDING',
  `notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_attendance_calculation_runs_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `companyschedule`;
CREATE TABLE `companyschedule` (
  `id` int NOT NULL AUTO_INCREMENT,
  `scheduleDate` date DEFAULT NULL,
  `timeEntrance` time DEFAULT '07:00:00',
  `timeExit` time DEFAULT '13:40:00',
  `description` varchar(255) DEFAULT NULL,
  `isWorkDay` tinyint(1) DEFAULT '1',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `scheduleDate` (`scheduleDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `dailyattendance`;
CREATE TABLE `dailyattendance` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `attDate` date NOT NULL,
  `timeIn` datetime DEFAULT NULL,
  `timeOut` datetime DEFAULT NULL,
  `hoursWorked` decimal(5,2) DEFAULT NULL,
  `isPresent` tinyint(1) DEFAULT NULL,
  `remarks` varchar(255) DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_attendance` (`userId`,`attDate`),
  KEY `idx_daily_attendance_date` (`attDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `day_overrides`;
CREATE TABLE `day_overrides` (
  `id` int NOT NULL AUTO_INCREMENT,
  `calendar_id` int NOT NULL,
  `date` date NOT NULL,
  `override_type` enum('WORKDAY','HOLIDAY','LICENSE','PERMISSION','TRAINING','OTHER') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'OTHER',
  `override_notes` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_day_overrides_calendar` (`calendar_id`),
  KEY `idx_day_overrides_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `dayassignments`;
CREATE TABLE `dayassignments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `assDate` date NOT NULL,
  `assignmentType` varchar(50) DEFAULT NULL,
  `timeStart` time DEFAULT NULL,
  `timeEnd` time DEFAULT NULL,
  `duration` decimal(5,2) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_date` (`userId`,`assDate`),
  KEY `idx_day_assignments_date` (`assDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `employee_categories`;
CREATE TABLE `employee_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int DEFAULT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employee_category_tenant_name` (`tenant_id`,`name`),
  KEY `idx_employee_categories_tenant` (`tenant_id`),
  CONSTRAINT `employee_categories_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `employee_events`;
CREATE TABLE `employee_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `employee_id` int NOT NULL,
  `event_type_id` int NOT NULL,
  `fecha_desde` date NOT NULL,
  `fecha_hasta` date NOT NULL,
  `dias` int DEFAULT NULL,
  `observaciones` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `balance_year` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `employee_leave_balances`;
CREATE TABLE `employee_leave_balances` (
  `id` int NOT NULL AUTO_INCREMENT,
  `employee_id` int NOT NULL,
  `year` int NOT NULL,
  `allotted_days` decimal(5,2) NOT NULL DEFAULT '0.00',
  `notes` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `expiration_date` date DEFAULT NULL,
  `is_automatic` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employee_leave_balance` (`employee_id`,`year`),
  KEY `idx_employee_leave_balances_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `employee_work_calendars`;
CREATE TABLE `employee_work_calendars` (
  `id` int NOT NULL AUTO_INCREMENT,
  `employee_id` int NOT NULL,
  `tenant_id` int NOT NULL,
  `template_id` int NOT NULL,
  `valid_from` date NOT NULL,
  `valid_to` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_employee_work_calendars_employee` (`employee_id`),
  KEY `idx_employee_work_calendars_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `employees`;
CREATE TABLE `employees` (
  `id` int NOT NULL AUTO_INCREMENT,
  `employee_id` int DEFAULT NULL,
  `nombre` varchar(150) NOT NULL,
  `documento` varchar(50) DEFAULT NULL,
  `tipo_documento` int DEFAULT NULL,
  `direccion` varchar(255) DEFAULT NULL,
  `zona_id` int DEFAULT NULL,
  `zona_real_id` int DEFAULT NULL,
  `fecha_alta` date DEFAULT NULL,
  `fecha_baja` date DEFAULT NULL,
  `activo` tinyint(1) DEFAULT '1',
  `category_id` int DEFAULT NULL,
  `overtime_authorized` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `legajo_alt` varchar(50) DEFAULT NULL,
  `exclude_from_report` tinyint(1) NOT NULL DEFAULT '0',
  `tenant_id` int DEFAULT NULL,
  `motivo_baja` varchar(100) DEFAULT NULL,
  `payroll_regime` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employee_tenant_legajo` (`tenant_id`,`employee_id`),
  KEY `idx_employees_tenant` (`tenant_id`),
  KEY `idx_employees_category` (`category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `event_type_mappings`;
CREATE TABLE `event_type_mappings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `raw_code` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `category` enum('ENTRY','EXIT','OVERTIME_START','OVERTIME_END','BREAK_START','BREAK_END','OTHER') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'OTHER',
  `requires_approval` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_type_mapping` (`tenant_id`,`raw_code`),
  KEY `idx_event_type_mappings_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `event_types`;
CREATE TABLE `event_types` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int DEFAULT NULL,
  `code` varchar(50) DEFAULT NULL,
  `descripcion` varchar(100) DEFAULT NULL,
  `descuenta_vacaciones` tinyint(1) DEFAULT '0',
  `requiere_aprobacion` tinyint(1) DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  KEY `idx_event_types_tenant` (`tenant_id`),
  CONSTRAINT `event_types_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `holidays`;
CREATE TABLE `holidays` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int DEFAULT NULL,
  `date` date NOT NULL,
  `year` year DEFAULT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `description` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('NATIONAL','PROVINCIAL','LOCAL','EXCEPTIONAL','OPTIONAL') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'NATIONAL',
  `reason` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `isWorkDay` tinyint(1) DEFAULT '0',
  `recurring` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_holiday_date` (`date`),
  KEY `idx_holidays_tenant` (`tenant_id`),
  CONSTRAINT `holidays_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `labor_conventions`;
CREATE TABLE `labor_conventions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_labor_conventions_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `overtime_policies`;
CREATE TABLE `overtime_policies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `convention_id` int NOT NULL,
  `threshold_daily_minutes` int DEFAULT '480',
  `threshold_weekly_minutes` int DEFAULT NULL,
  `threshold_monthly_minutes` int DEFAULT NULL,
  `max_daily_minutes` int DEFAULT '720',
  `multiplier` decimal(4,2) DEFAULT '1.50',
  `daily_limit_alert_minutes` int DEFAULT '240',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_overtime_policies_convention` (`convention_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payment_records`;
CREATE TABLE `payment_records` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `amount_usd` decimal(10,2) NOT NULL,
  `amount_local` decimal(12,2) DEFAULT NULL,
  `local_currency` varchar(10) DEFAULT 'ARS',
  `method` enum('manual','mercadopago') NOT NULL,
  `reference` varchar(255) DEFAULT NULL,
  `period_start` date NOT NULL,
  `period_end` date NOT NULL,
  `recorded_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_payment_records_tenant` (`tenant_id`),
  KEY `fk_payment_records_app_user` (`recorded_by`),
  CONSTRAINT `fk_payment_records_app_user` FOREIGN KEY (`recorded_by`) REFERENCES `app_users` (`id`),
  CONSTRAINT `fk_payment_records_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `payroll_regime_settings`;
CREATE TABLE `payroll_regime_settings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int DEFAULT NULL,
  `regime` varchar(20) NOT NULL DEFAULT 'monthly',
  `week_start_day` tinyint NOT NULL DEFAULT '1',
  `biweekly_cut_day1` tinyint NOT NULL DEFAULT '1',
  `biweekly_cut_day2` tinyint NOT NULL DEFAULT '16',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_payroll_regime_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `plan_requests`;
CREATE TABLE `plan_requests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `requested_by` int DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `contact_preference` enum('whatsapp','llamada','email') NOT NULL DEFAULT 'whatsapp',
  `employee_count` int DEFAULT NULL,
  `clock_count` int DEFAULT NULL,
  `schedule_type` varchar(255) DEFAULT NULL,
  `status` enum('pending','resolved') NOT NULL DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_plan_requests_tenant` (`tenant_id`),
  KEY `fk_plan_requests_user` (`requested_by`),
  CONSTRAINT `fk_plan_requests_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `fk_plan_requests_user` FOREIGN KEY (`requested_by`) REFERENCES `app_users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `plans`;
CREATE TABLE `plans` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `base_price_usd` decimal(10,2) NOT NULL,
  `price_per_employee_usd` decimal(10,2) NOT NULL,
  `min_billed_employees` int NOT NULL DEFAULT '5',
  `max_employees` int DEFAULT NULL,
  `discount_quarterly_pct` decimal(5,2) NOT NULL DEFAULT '5.00',
  `discount_semiannual_pct` decimal(5,2) NOT NULL DEFAULT '10.00',
  `discount_annual_pct` decimal(5,2) NOT NULL DEFAULT '17.00',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `role_permissions`;
CREATE TABLE `role_permissions` (
  `role_id` int NOT NULL,
  `permission` varchar(50) NOT NULL,
  PRIMARY KEY (`role_id`,`permission`),
  CONSTRAINT `role_permissions_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `roles`;
CREATE TABLE `roles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `is_system` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `shift_blocks`;
CREATE TABLE `shift_blocks` (
  `id` int NOT NULL AUTO_INCREMENT,
  `template_id` int NOT NULL,
  `day_of_week` tinyint(1) NOT NULL,
  `block_name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `block_type` enum('WORK','BREAK','GUARD','OVERTIME','OTHER') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'WORK',
  `crosses_midnight` tinyint(1) NOT NULL DEFAULT '0',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_shift_blocks_template` (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `signup_leads`;
CREATE TABLE `signup_leads` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `company_name` varchar(150) NOT NULL,
  `email` varchar(255) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `contact_preference` enum('whatsapp','llamada','email') NOT NULL DEFAULT 'whatsapp',
  `employee_count` int DEFAULT NULL,
  `clock_count` int DEFAULT NULL,
  `schedule_type` varchar(255) DEFAULT NULL,
  `tenant_id` int DEFAULT NULL,
  `status` enum('pending','provisioned','failed') NOT NULL DEFAULT 'pending',
  `error_message` text,
  `chat_questions_used` int NOT NULL DEFAULT '0',
  `chat_history` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_signup_leads_tenant` (`tenant_id`),
  CONSTRAINT `fk_signup_leads_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `specialusers`;
CREATE TABLE `specialusers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `tenant_id` int NOT NULL,
  `badgeNumber` varchar(50) NOT NULL,
  `name` varchar(100) NOT NULL,
  `category` varchar(50) DEFAULT NULL,
  `direction` enum('SALIDA','REGRESO') DEFAULT NULL,
  `function` varchar(255) DEFAULT NULL,
  `isActive` tinyint(1) DEFAULT '1',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_specialusers_tenant_user` (`tenant_id`,`userId`),
  KEY `idx_special_users_badge` (`badgeNumber`),
  CONSTRAINT `specialusers_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `specialusers_ibfk_2` FOREIGN KEY (`tenant_id`, `userId`) REFERENCES `users` (`tenant_id`, `USERID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `staging_employees`;
CREATE TABLE `staging_employees` (
  `id` int NOT NULL AUTO_INCREMENT,
  `employee_id` int DEFAULT NULL,
  `nombre` varchar(150) DEFAULT NULL,
  `documento` varchar(50) DEFAULT NULL,
  `tipo_documento` int DEFAULT NULL,
  `direccion` varchar(255) DEFAULT NULL,
  `zona_id` int DEFAULT NULL,
  `zona_real_id` int DEFAULT NULL,
  `fecha_alta` date DEFAULT NULL,
  `fecha_baja` date DEFAULT NULL,
  `activo` tinyint(1) DEFAULT NULL,
  `import_batch_id` varchar(50) DEFAULT NULL,
  `tenant_id` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `tenant_agent_keys`;
CREATE TABLE `tenant_agent_keys` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `label` varchar(150) DEFAULT NULL,
  `key_prefix` varchar(16) NOT NULL,
  `key_hash` char(64) NOT NULL,
  `status` enum('active','paused','revoked') NOT NULL DEFAULT 'active',
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tenant_agent_keys_prefix` (`key_prefix`),
  KEY `fk_tenant_agent_keys_tenant` (`tenant_id`),
  KEY `fk_tenant_agent_keys_user` (`created_by`),
  CONSTRAINT `fk_tenant_agent_keys_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `fk_tenant_agent_keys_user` FOREIGN KEY (`created_by`) REFERENCES `app_users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `tenant_subscriptions`;
CREATE TABLE `tenant_subscriptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `plan_id` int NOT NULL,
  `billing_period` enum('monthly','quarterly','semiannual','annual') NOT NULL DEFAULT 'monthly',
  `status` enum('trial','active','grace','readonly','canceled','free') NOT NULL DEFAULT 'trial',
  `payment_method` enum('manual','mercadopago') NOT NULL DEFAULT 'manual',
  `mercadopago_subscription_id` varchar(100) DEFAULT NULL,
  `current_period_start` date DEFAULT NULL,
  `current_period_end` date DEFAULT NULL,
  `grace_period_days` int DEFAULT NULL,
  `grace_message` text,
  `last_payment_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `cancellation_requested_at` datetime DEFAULT NULL,
  `cancellation_requested_by` int DEFAULT NULL,
  `last_checkout_url` text,
  `last_checkout_generated_at` datetime DEFAULT NULL,
  `payment_requested_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_tenant_subscription` (`tenant_id`),
  KEY `fk_tenant_subscriptions_plan` (`plan_id`),
  CONSTRAINT `fk_tenant_subscriptions_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`),
  CONSTRAINT `fk_tenant_subscriptions_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `tenants`;
CREATE TABLE `tenants` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `code` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `timezone` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'America/Argentina/Buenos_Aires',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tenant_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `tolerance_policies`;
CREATE TABLE `tolerance_policies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `convention_id` int NOT NULL,
  `late_tolerance_minutes` int DEFAULT '10',
  `early_exit_tolerance_minutes` int DEFAULT '10',
  `rounding_increment_minutes` int DEFAULT '5',
  `rounding_mode` enum('NONE','UP','DOWN','NEAREST') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'NEAREST',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tolerance_policies_convention` (`convention_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `user_employee_map`;
CREATE TABLE `user_employee_map` (
  `USERID` int NOT NULL,
  `tenant_id` int NOT NULL,
  `employee_id` int NOT NULL,
  `match_type` varchar(20) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`tenant_id`,`USERID`),
  CONSTRAINT `user_employee_map_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `user_permissions`;
CREATE TABLE `user_permissions` (
  `user_id` int NOT NULL,
  `permission` varchar(50) NOT NULL,
  PRIMARY KEY (`user_id`,`permission`),
  CONSTRAINT `user_permissions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `app_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `userexclusions`;
CREATE TABLE `userexclusions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `userId` int NOT NULL,
  `tenant_id` int NOT NULL,
  `excDate` date NOT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `type` varchar(50) DEFAULT NULL,
  `event_type_id` int DEFAULT NULL,
  `excFrom` time DEFAULT NULL,
  `excTo` time DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_userexclusions_tenant` (`tenant_id`,`userId`,`excDate`,`type`),
  KEY `idx_user_exclusions_date` (`excDate`),
  KEY `idx_userexclusions_event_type` (`event_type_id`),
  CONSTRAINT `fk_userexclusions_event_type` FOREIGN KEY (`event_type_id`) REFERENCES `event_types` (`id`),
  CONSTRAINT `userexclusions_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `userexclusions_ibfk_2` FOREIGN KEY (`tenant_id`, `userId`) REFERENCES `users` (`tenant_id`, `USERID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `USERID` int NOT NULL,
  `tenant_id` int NOT NULL,
  `isExcluded` tinyint(1) DEFAULT '0',
  `Badgenumber` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `Name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`tenant_id`,`USERID`),
  UNIQUE KEY `uq_users_tenant_badge` (`tenant_id`,`Badgenumber`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `vacation_scale`;
CREATE TABLE `vacation_scale` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int DEFAULT NULL,
  `min_years` int NOT NULL,
  `max_years` int DEFAULT NULL,
  `days` int NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vacation_scale_tenant` (`tenant_id`),
  CONSTRAINT `vacation_scale_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS `work_schedule_templates`;
CREATE TABLE `work_schedule_templates` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `type` enum('FIXED','FLEXIBLE','ROTATIVE','CUSTOM') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'FIXED',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_work_schedule_templates_tenant` (`tenant_id`),
  KEY `idx_templates_tenant_default` (`tenant_id`,`is_default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;