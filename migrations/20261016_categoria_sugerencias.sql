-- ============================================================================
-- Categoría con plantilla y convenio sugeridos (aprobado por el dueño, 2026-10-08)
-- ============================================================================
--
-- QUE AGREGA (nada se borra ni se renombra):
--   employee_categories + plantilla_sugerida_id  plantilla de horario que se
--                                                propone al dar de alta a alguien
--                                                de esta categoría
--                       + convenio_sugerido_id   convenio que se propone
--                       + regimen_sugerido_id    régimen dentro del convenio (opcional)
--
-- Son solo SUGERENCIAS: no cambian ningún cálculo ni asignan nada solas. Se
-- usan para completar el alta de un empleado y para "aplicar a todos los de
-- la categoría", siempre con confirmación.
--
-- Sin claves foráneas a propósito: borrar o desactivar una plantilla no
-- tiene que fallar por una sugerencia. El código valida que sean de la
-- misma empresa y las ignora si ya no existen.
--
-- ORDEN DE PUBLICACION: da igual. Sin esta migración, las categorías siguen
-- funcionando como siempre y guardar una sugerencia avisa que falta correrla.
-- Se puede correr más de una vez.
-- ============================================================================

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_categories' AND COLUMN_NAME = 'plantilla_sugerida_id');
SET @s := IF(@c = 0,
  'ALTER TABLE employee_categories ADD COLUMN plantilla_sugerida_id INT NULL, ADD COLUMN convenio_sugerido_id INT NULL, ADD COLUMN regimen_sugerido_id INT NULL',
  'SELECT "employee_categories.plantilla_sugerida_id ya existe"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Control: las 3 columnas nuevas.
SELECT COUNT(*) AS columnas_nuevas FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_categories'
   AND COLUMN_NAME IN ('plantilla_sugerida_id', 'convenio_sugerido_id', 'regimen_sugerido_id');
