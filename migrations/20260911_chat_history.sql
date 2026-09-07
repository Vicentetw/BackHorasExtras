-- Bug real encontrado probando la landing de verdad: el chat de ventas
-- respondia cada mensaje SIN memoria de los anteriores (cada llamada a la
-- API le mandaba solo el mensaje nuevo) -- un "si" en respuesta a la propia
-- pregunta del bot ("¿queres que te pase el contacto?") le llegaba sin
-- ningun contexto, y respondia cualquier cosa.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads' AND COLUMN_NAME = 'chat_history'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE signup_leads ADD COLUMN chat_history JSON NULL AFTER chat_questions_used',
  'SELECT "signup_leads.chat_history ya existe"'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'chat_history en signup_leads aplicada correctamente' AS resultado;
