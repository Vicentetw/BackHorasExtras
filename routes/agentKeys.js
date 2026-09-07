// Fase 18 -- administracion de claves de agente por tenant (generar,
// pausar, revocar). Solo superadmin -- es una credencial de maquina que
// puede escribir fichajes/usuarios de una empresa, mismo nivel de cuidado
// que cualquier otra decision de plataforma en este archivo.
const express = require('express');
const { requireSuperadmin } = require('../appUserMiddleware');
const agentKeyRepository = require('../motor-laboral/repositories/agentKeyRepository');

const VALID_STATUSES = ['active', 'paused', 'revoked'];

module.exports = function (db) {
  const router = express.Router();

  router.use(requireSuperadmin);

  // ?tenantId= filtra a una empresa puntual; sin el, lista todas (para una
  // futura pantalla general si hiciera falta -- hoy el uso real es siempre
  // filtrado por tenant, desde Facturacion).
  router.get('/', async (req, res) => {
    try {
      if (req.query.tenantId) {
        const rows = await agentKeyRepository.getAgentKeysForTenant(req.query.tenantId, db);
        return res.json(rows);
      }
      const rows = await agentKeyRepository.getAllAgentKeys(db);
      res.json(rows);
    } catch (err) {
      console.error('ERROR listing agent keys:', err);
      res.status(500).json({ error: 'Error al listar las claves de agente' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { tenant_id, label } = req.body;
      if (!tenant_id) return res.status(400).json({ error: 'tenant_id es requerido' });
      const { id, plaintext } = await agentKeyRepository.createAgentKey(
        { tenantId: tenant_id, label, createdBy: req.appUser.id },
        db
      );
      // El plaintext viaja UNA sola vez, en esta respuesta -- no se puede
      // volver a consultar despues (solo se guarda el hash).
      res.status(201).json({ ok: true, id, key: plaintext });
    } catch (err) {
      console.error('ERROR creating agent key:', err);
      res.status(500).json({ error: 'Error al generar la clave de agente' });
    }
  });

  router.post('/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status debe ser uno de: ${VALID_STATUSES.join(', ')}` });
      }
      await agentKeyRepository.setAgentKeyStatus(req.params.id, status, db);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR updating agent key status:', err);
      res.status(500).json({ error: 'Error al actualizar la clave de agente' });
    }
  });

  return router;
};
