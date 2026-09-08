// Fase 18 (continuacion) -- lectura de "hasta cuando esta actualizado
// cada reloj", para mostrar en Presentismo/Asistencia. A diferencia de
// routes/agent.js, esta ruta NO esta en publicPaths -- pasa por el login
// normal de Firebase + appUserMiddleware, la usan usuarios reales del
// sistema (no el agente).
const express = require('express');
const agentSyncStatusRepository = require('../motor-laboral/repositories/agentSyncStatusRepository');

module.exports = function (db) {
  const router = express.Router();

  // Un usuario normal ve la de su propia empresa; superadmin puede pedir
  // la de cualquiera via ?tenantId= (ej. para diagnosticar un reclamo).
  router.get('/', async (req, res) => {
    try {
      let tenantId = req.appUser?.tenantId;
      if (req.appUser?.isSuperadmin && req.query.tenantId) {
        tenantId = Number(req.query.tenantId);
      }
      if (tenantId == null) return res.json([]);
      const rows = await agentSyncStatusRepository.getSyncStatusForTenant(tenantId, db);
      res.json(rows);
    } catch (err) {
      console.error('ERROR listing sync status:', err);
      res.status(500).json({ error: 'Error al consultar el estado de sincronización' });
    }
  });

  return router;
};
