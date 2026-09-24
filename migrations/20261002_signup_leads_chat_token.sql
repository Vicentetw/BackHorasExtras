-- ============================================================================
-- Que el chat de ventas solo lo pueda usar el dueño de su propio registro
-- ============================================================================
--
-- EL PROBLEMA (hallazgo F-02 de la auditoría de seguridad)
-- --------------------------------------------------------
-- POST /api/public/chat recibía el `leadId` en el body y lo usaba directo:
--
--     SELECT ... FROM signup_leads WHERE id = ?
--
-- Sin verificar que ese registro fuera de quien llama. Y el id es
-- AUTO_INCREMENT, o sea adivinable: 1, 2, 3...
--
-- Es la única ruta del sistema que llama a la API de Anthropic, y se alcanza
-- sin ninguna cuenta. Un atacante podía recorrer ids y gastar preguntas con
-- NUESTRA clave de API, además de recibir como contexto el historial de
-- conversación de otro prospecto.
--
-- En OWASP es API1:2023 (Broken Object Level Authorization); en CWE, la
-- 639 (Authorization Bypass Through User-Controlled Key).
--
-- LA SOLUCIÓN
-- -----------
-- Un token aleatorio por lead, generado al crearlo y devuelto UNA vez a quien
-- completó el formulario. El chat exige ese token; el `leadId` solo ya no
-- alcanza.
--
-- Se guarda el SHA-256 del token, no el token: mismo criterio que
-- tenant_agent_keys (ver 20260913_tenant_agent_keys.sql). Si algún día se
-- filtra un backup de esta tabla, lo que hay adentro no sirve para chatear.
--
-- Por qué un token aleatorio en la fila y no un HMAC firmado: no necesita
-- ningún secreto nuevo configurado en Render (uno menos que se puede olvidar
-- o poner mal), sobrevive a los reinicios del servidor, y se puede revocar
-- poniéndolo en NULL. Es además el patrón que este sistema ya usa y tiene
-- probado para las claves del agente.
--
-- Idempotente: se puede correr más de una vez sin romper nada.
-- ============================================================================

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_leads'
    AND COLUMN_NAME = 'chat_token_hash'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE signup_leads ADD COLUMN chat_token_hash CHAR(64) NULL COMMENT "SHA-256 del token de chat. NULL = ese lead no puede usar el chat."',
  'SELECT "chat_token_hash ya existe" AS resultado');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Los leads viejos quedan sin token, y eso es a propósito
-- ---------------------------------------------------------------------------
-- NULL significa "este lead no puede chatear". No se les genera uno: nadie
-- tiene forma de recibirlo (el token se entrega una sola vez, en la respuesta
-- del alta), así que sería una credencial que solo sirve para quien lea la
-- base. Un prospecto viejo que quiera seguir hablando entra por WhatsApp, que
-- es el camino que la propia landing ofrece al agotarse las preguntas.

SELECT 'listo' AS paso,
       COUNT(*) AS leads_sin_token_no_pueden_chatear
FROM signup_leads WHERE chat_token_hash IS NULL;
