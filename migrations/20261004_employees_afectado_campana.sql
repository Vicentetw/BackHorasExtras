-- ============================================================================
-- Tilde por empleado "Afectado a campaña / viajes"
-- ============================================================================
--
-- EL PROBLEMA
-- -----------
-- El marcador de campaña no dice de quien es: el sistema se lo da a quien
-- ficha enseguida en el mismo reloj. Si justo ficha alguien de oficina, que
-- nunca sale al campo, se le abre una "campaña" de dias, y sus ausencias
-- siguientes pueden terminar contadas como trabajadas o excusadas.
--
-- LA SOLUCION
-- -----------
-- Marcar quien puede salir a campaña. Cuando la empresa activa "solo
-- detectar campañas de empleados afectados" (ajuste campanaSoloAfectados,
-- en Salidas > Campaña), un empleado SIN la tilde no se puede llevar un
-- marcador de campaña: el marcador sigue esperando a la persona correcta.
-- Ver `soloPuedenConsumir` en motor-laboral/services/movementsCalculations.js.
--
-- DEFAULT 0 y el ajuste apagado: no cambia nada hasta que la empresa marque
-- a su gente y lo active. Si se activara con nadie marcado, desaparecerian
-- todas las campañas -- por eso la pantalla no deja activarlo sin nadie
-- marcado y ofrece marcar de una vez a quienes ya salieron a campaña.
--
-- ES SEGURA DE CORRER: una columna nueva con default, idempotente.
-- ============================================================================

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'afectado_campana'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE employees ADD COLUMN afectado_campana TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT "employees.afectado_campana ya existe"'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'employees.afectado_campana creada correctamente' AS resultado;
