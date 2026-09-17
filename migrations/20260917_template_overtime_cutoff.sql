-- Migration: corte y tope de HE por plantilla (columnas nullable, sin
-- default forzado -- una plantilla sin estos datos cae al horario de salida
-- de esa misma plantilla / al tope global, ver
-- overtimeCalculations.resolveOvertimeCutoffMinutes/resolveOvertimeCapMinutes).
-- Pedido real: "no todos tienen el mismo horario" -- reemplaza el corte y
-- el tope unicos globales (/config/overtime-settings, antes editables desde
-- Presentismo y Horas Extra por Regimen) como fuente principal; esas dos
-- pantallas dejan de mostrar esos controles, ahora se cargan en la
-- plantilla (Motor Laboral > Plantillas).
-- Segura de correr en caliente: ADD COLUMN nullable, no reescribe filas
-- existentes con un valor por default, no bloquea la tabla mas que el
-- tiempo de la propia ALTER.

ALTER TABLE work_schedule_templates
  ADD COLUMN overtime_cutoff_time TIME NULL DEFAULT NULL
    COMMENT 'Corte HE propio de esta plantilla (HH:MM:SS); NULL = usar el horario de salida de la plantilla',
  ADD COLUMN overtime_cap_minutes INT NULL DEFAULT NULL
    COMMENT 'Tope diario de HE propio de esta plantilla, en minutos; NULL = usar el tope global configurado';
