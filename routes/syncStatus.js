// Fase 18 (continuacion) -- lectura de "hasta cuando esta actualizado
// cada reloj", para mostrar en Presentismo/Asistencia. A diferencia de
// routes/agent.js, esta ruta NO esta en publicPaths -- pasa por el login
// normal de Firebase + appUserMiddleware, la usan usuarios reales del
// sistema (no el agente).
const express = require('express');
const agentSyncStatusRepository = require('../motor-laboral/repositories/agentSyncStatusRepository');
const { requirePermission } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  // Un usuario normal ve la de su propia empresa. El superadmin: la de una
  // empresa puntual si pasa ?tenantId= (para diagnosticar un reclamo), o
  // la de TODAS si no -- antes, sin ?tenantId=, no veia ninguna (no
  // pertenece a ninguna empresa), y en la practica es el que administra
  // la unica empresa real.
  router.get('/', async (req, res) => {
    try {
      if (req.appUser?.isSuperadmin) {
        const rows = req.query.tenantId
          ? await agentSyncStatusRepository.getSyncStatusForTenant(Number(req.query.tenantId), db)
          : await agentSyncStatusRepository.getAllSyncStatus(db);
        return res.json(rows);
      }
      const tenantId = req.appUser?.tenantId;
      if (tenantId == null) return res.json([]);
      const rows = await agentSyncStatusRepository.getSyncStatusForTenant(tenantId, db);
      res.json(rows);
    } catch (err) {
      console.error('ERROR listing sync status:', err);
      res.status(500).json({ error: 'Error al consultar el estado de sincronización' });
    }
  });

  // Ponerle nombre a un reloj ("Reloj recepción") para no mostrar su IP.
  // Vacio = quitar el nombre (vuelve a verse la IP). Un reloj de otra
  // empresa responde igual que uno que no existe.
  router.put('/:id/nombre', requirePermission('settings', 'update'), async (req, res) => {
    const nombre = String((req.body || {}).nombre ?? '').trim().slice(0, 80);
    try {
      const tenantId = req.appUser.isSuperadmin ? null : req.appUser.tenantId;
      if (!req.appUser.isSuperadmin && tenantId == null) return res.status(404).json({ error: 'Reloj no encontrado' });
      const ok = await agentSyncStatusRepository.renombrar(db, { id: Number(req.params.id), tenantId, nombre: nombre || null });
      if (!ok) return res.status(404).json({ error: 'Reloj no encontrado' });
      res.json({ ok: true, nombre: nombre || null });
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: 'Falta correr la migración 20261013 (nombre del reloj).' });
      console.error('ERROR renombrando reloj:', err);
      res.status(500).json({ error: 'Error al guardar el nombre' });
    }
  });

  return router;
};
