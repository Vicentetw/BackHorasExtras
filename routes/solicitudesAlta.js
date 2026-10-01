// /api/solicitudes-alta -- SOLO superadmin. Bandeja de las solicitudes que
// llegan por el formulario de la pagina (migracion 20261012). Ver
// motor-laboral/services/altaEmpresa.js.
//
//   GET  /?estado=pending|provisioned|rejected|failed|todas
//   POST /:id/aprobar   { companyName?, email? }   crea la empresa y la cuenta
//   POST /:id/rechazar  { motivo }
const express = require('express');
const { requireSuperadmin } = require('../appUserMiddleware');
const { aprobarSolicitud, rechazarSolicitud } = require('../motor-laboral/services/altaEmpresa');

const ESTADOS = ['pending', 'provisioned', 'rejected', 'failed'];

module.exports = function (db) {
  const router = express.Router();
  router.use(requireSuperadmin);

  const responderError = (res, err, accion) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'WARN_DATA_TRUNCATED' || err.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' || err.code === 'WARN_DATA_TRUNCATED') {
      return res.status(503).json({ error: 'Falta correr la migración 20261012 (solicitudes de alta).' });
    }
    console.error(`ERROR solicitudes de alta (${accion}):`, err);
    res.status(500).json({ error: `No se pudo ${accion} la solicitud` });
  };

  router.get('/', async (req, res) => {
    const estado = String(req.query.estado || 'pending');
    if (estado !== 'todas' && !ESTADOS.includes(estado)) return res.status(400).json({ error: 'estado inválido' });
    try {
      // Sin chat_history ni chat_token_hash: no hacen falta para decidir.
      const [rows] = await db.query(
        `SELECT l.id, l.name, l.company_name, l.email, l.phone, l.contact_preference, l.employee_count, l.clock_count,
                l.schedule_type, l.status, l.tenant_id, l.error_message, l.created_at,
                l.reviewed_at, l.review_note, au.email AS reviewed_by_email
         FROM signup_leads l LEFT JOIN app_users au ON au.id = l.reviewed_by
         ${estado === 'todas' ? '' : 'WHERE l.status = ?'}
         ORDER BY l.created_at DESC LIMIT 500`, estado === 'todas' ? [] : [estado]);
      res.json({ solicitudes: rows });
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        // Antes de la migracion: la lista igual se puede ver.
        const [rows] = await db.query(
          `SELECT id, name, company_name, email, phone, contact_preference, employee_count, clock_count, schedule_type,
                  status, tenant_id, error_message, created_at FROM signup_leads
           ${estado === 'todas' ? '' : 'WHERE status = ?'} ORDER BY created_at DESC LIMIT 500`, estado === 'todas' ? [] : [estado]);
        return res.json({ solicitudes: rows });
      }
      responderError(res, err, 'leer');
    }
  });

  router.post('/:id/aprobar', async (req, res) => {
    try {
      const b = req.body || {};
      const r = await aprobarSolicitud(db, Number(req.params.id), { companyName: b.companyName, email: b.email }, req.appUser.id);
      res.json({ ok: true, ...r });
    } catch (err) {
      responderError(res, err, 'aprobar');
    }
  });

  router.post('/:id/rechazar', async (req, res) => {
    const motivo = String((req.body || {}).motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'El motivo es obligatorio.' });
    try {
      await rechazarSolicitud(db, Number(req.params.id), motivo, req.appUser.id);
      res.json({ ok: true });
    } catch (err) {
      responderError(res, err, 'rechazar');
    }
  });

  return router;
};
