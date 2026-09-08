// Fase 18 -- endpoints para el agente de sincronizacion de relojes
// (descarga-fichaje-py corriendo desatendido en la PC de cada sitio).
// Montado en /api/agent, agregado a `publicPaths` en horasdedica2.js --
// salta authMiddleware/firebaseAuthMiddleware/appUserMiddleware (un
// proceso desatendido no tiene sesion de Firebase) pero sigue pasando por
// helmet/rate-limit/CORS globales. La identidad ACA es la clave de agente
// (x-agent-key), no un usuario -- mismo espiritu que routes/public.js.
const express = require('express');
const rateLimit = require('express-rate-limit');
const agentKeyRepository = require('../motor-laboral/repositories/agentKeyRepository');
const billingRepository = require('../motor-laboral/repositories/billingRepository');
const { resolveEffectiveStatus, isWriteBlocked, DEFAULT_GRACE_DAYS } = require('../motor-laboral/services/billingCalculations');
const { insertCheckinsBatch, upsertUsersBatch, MAX_RECORDS_PER_BATCH } = require('../motor-laboral/services/checkinsIngestService');
const agentSyncStatusRepository = require('../motor-laboral/repositories/agentSyncStatusRepository');

// Un sitio real sincroniza cada tantos minutos -- 30/min por IP da margen
// de sobra para reintentos, sin abrir la puerta a un abuso de esta
// superficie (la unica alcanzable con SOLO una clave, sin login de Firebase).
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes del agente, intenta de nuevo en un momento.' }
});

module.exports = function (db) {
  const router = express.Router();
  router.use(agentLimiter);

  async function agentAuthMiddleware(req, res, next) {
    const key = req.headers['x-agent-key'];
    const tenantId = await agentKeyRepository.verifyAgentKey(key, db);
    if (!tenantId) return res.status(401).json({ error: 'Clave de agente inválida, pausada o revocada' });
    req.agentTenantId = tenantId;
    next();
  }

  // Mismo criterio que requireActiveSubscription (appUserMiddleware.js)
  // pero resolviendo el tenant desde la clave de agente, no de un
  // app_user logueado.
  async function requireActiveSubscriptionAgent(req, res, next) {
    try {
      const subscription = await billingRepository.getSubscriptionByTenant(req.agentTenantId, db);
      if (!subscription) return next(); // sin suscripcion armada -- no se bloquea (mismo criterio que el resto del sistema)
      const effectiveStatus = resolveEffectiveStatus({
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        gracePeriodDays: subscription.grace_period_days,
        defaultGraceDays: DEFAULT_GRACE_DAYS
      });
      if (isWriteBlocked(effectiveStatus)) {
        return res.status(402).json({
          error: subscription.grace_message || 'La suscripción de esta empresa está vencida. Regularizá el pago para poder seguir sincronizando fichajes.',
          effectiveStatus
        });
      }
      next();
    } catch (err) {
      console.error('requireActiveSubscriptionAgent error:', err);
      next(); // fail-open, mismo criterio que el resto del sistema
    }
  }

  function validateRecordsBody(req, res, next) {
    const { records } = req.body || {};
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: 'records debe ser un array' });
    }
    if (records.length === 0) {
      return res.status(400).json({ error: 'records no puede estar vacío' });
    }
    if (records.length > MAX_RECORDS_PER_BATCH) {
      return res.status(413).json({ error: `Máximo ${MAX_RECORDS_PER_BATCH} registros por lote -- dividí el envío en varias llamadas` });
    }
    next();
  }

  router.use(agentAuthMiddleware);

  // POST /api/agent/checkins -- body: { records: [{ USERID, CHECKTIME, MACHINE_IP, MACHINE_SN }, ...] }
  // MISMOS nombres de columna que ya exporta exporter.py (descarga-fichaje-py)
  // -- el agente manda el mismo shape que ya arma para el CSV, sin transformar nada.
  router.post('/checkins', requireActiveSubscriptionAgent, validateRecordsBody, async (req, res) => {
    try {
      const result = await insertCheckinsBatch(req.body.records, db);
      // Pedido real: saber "hasta cuando esta actualizado" cada reloj
      // puntual, no solo la empresa entera -- se registra por separado,
      // un problema con esto (ej. un reloj sin MACHINE_IP) no debe hacer
      // fallar la subida de fichajes en si.
      try {
        await agentSyncStatusRepository.upsertSyncStatus(req.agentTenantId, req.body.records, db);
      } catch (syncErr) {
        console.error('ERROR registrando agent_sync_status (no afecta la subida de fichajes):', syncErr);
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === 'DB_BUSY' || err.code === 'DB_UNREACHABLE') {
        return res.status(503).json({ error: err.message });
      }
      if (err.code === 'BATCH_TOO_LARGE') {
        return res.status(413).json({ error: err.message });
      }
      console.error('ERROR agent checkins:', err);
      res.status(500).json({ error: 'Error al sincronizar fichajes' });
    }
  });

  // POST /api/agent/users -- body: { records: [{ USERID, Badgenumber, Name }, ...] }
  router.post('/users', validateRecordsBody, async (req, res) => {
    try {
      const result = await upsertUsersBatch(req.body.records, db);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === 'BATCH_TOO_LARGE') {
        return res.status(413).json({ error: err.message });
      }
      console.error('ERROR agent users:', err);
      res.status(500).json({ error: 'Error al sincronizar usuarios' });
    }
  });

  // GET /api/agent/ping -- para que el agente pueda probar la clave y la
  // conectividad sin mandar datos reales (util al configurar un sitio nuevo).
  router.get('/ping', (req, res) => {
    res.json({ ok: true, tenantId: req.agentTenantId });
  });

  return router;
};
