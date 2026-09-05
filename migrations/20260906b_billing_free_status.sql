-- Fase 9b: modo "free" -- empresas que nunca se facturan (uso interno/
-- particular, ej. AVP), a diferencia de 'trial' (tambien sin cobrar, pero
-- con fecha de vencimiento -- al mes se le empieza a aplicar el mismo
-- circuito de gracia/solo-lectura que a cualquier otra). 'free' ignora
-- las fechas por completo, para siempre, hasta que un superadmin la saque
-- de ese estado a mano -- mismo criterio que 'canceled' (tambien ignora
-- fechas) pero el resultado opuesto: nunca se bloquea en vez de bloquear
-- siempre.
ALTER TABLE tenant_subscriptions
  MODIFY COLUMN status ENUM('trial','active','grace','readonly','canceled','free') NOT NULL DEFAULT 'trial';
