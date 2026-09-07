-- Fase 11: landing publica + alta de cliente autoservicio + chatbot de
-- ventas. `signup_leads` es a la vez el registro de cada alta autoservicio
-- (para poder auditar/contactar) Y el contador de preguntas gratis del
-- chat de la landing (chat_questions_used) -- una sola fila por intento de
-- alta, no hace falta una tabla aparte para el chat ya que el gate del
-- chat ES el mismo registro.
--
-- tenant_id queda NULL si el alta fallo despues de validar el formulario
-- pero antes de terminar de crear todo (status='failed', error_message
-- con el detalle) -- se guarda igual para no perder el lead por un error
-- tecnico nuestro.
CREATE TABLE IF NOT EXISTS signup_leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  company_name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NULL,
  contact_preference ENUM('whatsapp','llamada','email') NOT NULL DEFAULT 'whatsapp',
  employee_count INT NULL,
  clock_count INT NULL,
  schedule_type VARCHAR(255) NULL,
  tenant_id INT NULL,
  status ENUM('pending','provisioned','failed') NOT NULL DEFAULT 'pending',
  error_message TEXT NULL,
  chat_questions_used INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_signup_leads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

SELECT 'Migracion 20260908_public_signup_leads aplicada correctamente' AS resultado;
