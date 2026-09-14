const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');
const eventTypeCountModeRepository = require('../motor-laboral/repositories/eventTypeCountModeRepository');

const MODOS_VALIDOS = ['corridos', 'habiles'];

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR MOTIVOS
  // ==========================
  router.get('/', requirePermission('exclusions', 'read'), async (req, res) => {
    try {
      const { includeInactive } = req.query;
      // Sin fallback a tenant_id IS NULL: la migracion a motivos por tenant
      // ya esta completa, no debe quedar ninguna fila global -- si alguna
      // vez aparece una (import/bug), mejor invisible para todos que
      // visible para todos.
      const effectiveTenantId = resolveTenantId(req);
      const tenantClause = effectiveTenantId !== null ? ' AND tenant_id = ?' : '';
      const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
      const sql = includeInactive === 'true'
        ? `SELECT * FROM event_types WHERE 1=1${tenantClause} ORDER BY descripcion ASC`
        : `SELECT * FROM event_types WHERE active = 1${tenantClause} ORDER BY descripcion ASC`;
      const [rows] = await db.query(sql, tenantParams);
      res.json({ success: true, eventTypes: rows });
    } catch (err) {
      console.error('ERROR fetching event types:', err);
      res.status(500).json({ success: false, error: 'Error fetching event types' });
    }
  });

  // ==========================
  // 2. CREAR MOTIVO
  // ==========================
  router.post('/', requirePermission('exclusions', 'create'), async (req, res) => {
    try {
      const { code, descripcion, descuenta_vacaciones, requiere_aprobacion } = req.body;

      if (!code || !descripcion) {
        return res.status(400).json({ success: false, error: 'code y descripcion son requeridos' });
      }

      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : (req.body.tenant_id ?? req.body.tenantId ?? null);

      const [result] = await db.query(
        `INSERT INTO event_types (tenant_id, code, descripcion, descuenta_vacaciones, requiere_aprobacion, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [tenantId, code, descripcion, descuenta_vacaciones ? 1 : 0, requiere_aprobacion ? 1 : 0]
      );

      res.json({ success: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating event type:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe un motivo con ese código' });
      }
      res.status(500).json({ success: false, error: 'Error creating event type' });
    }
  });

  // ==========================
  // 3. ACTUALIZAR MOTIVO
  // ==========================
  router.put('/:id', requirePermission('exclusions', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { code, descripcion, descuenta_vacaciones, requiere_aprobacion, active } = req.body;

      if (!code || !descripcion) {
        return res.status(400).json({ success: false, error: 'code y descripcion son requeridos' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM event_types WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
        }
      }

      const [result] = await db.query(
        `UPDATE event_types SET code = ?, descripcion = ?, descuenta_vacaciones = ?, requiere_aprobacion = ?, active = ?
         WHERE id = ?`,
        [code, descripcion, descuenta_vacaciones ? 1 : 0, requiere_aprobacion ? 1 : 0, active !== undefined ? (active ? 1 : 0) : 1, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR updating event type:', err);
      res.status(500).json({ success: false, error: 'Error updating event type' });
    }
  });

  // ==========================
  // 4. DESACTIVAR MOTIVO (soft delete, para no romper exclusiones existentes que lo referencian)
  // ==========================
  router.delete('/:id', requirePermission('exclusions', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM event_types WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
        }
      }

      const [result] = await db.query('UPDATE event_types SET active = 0 WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deactivating event type:', err);
      res.status(500).json({ success: false, error: 'Error deactivating event type' });
    }
  });

  // Chequea que el motivo exista y (si no es superadmin) sea de la empresa
  // de quien pide -- mismo patron que PUT/DELETE de arriba.
  async function findEventTypeOrNull(id, effectiveTenantId) {
    const [[row]] = await db.query('SELECT id, tenant_id FROM event_types WHERE id = ?', [id]);
    if (!row) return null;
    if (effectiveTenantId !== null && row.tenant_id !== effectiveTenantId) return null;
    return row;
  }

  // ==========================
  // 5. HISTORIAL DE VIGENCIAS (corridos/habiles) DE UN MOTIVO
  // GET /api/event-types/:id/count-modes
  // ==========================
  router.get('/:id/count-modes', requirePermission('exclusions', 'read'), async (req, res) => {
    try {
      const eventType = await findEventTypeOrNull(req.params.id, resolveTenantId(req));
      if (!eventType) return res.status(404).json({ success: false, error: 'Motivo no encontrado' });

      const modos = await eventTypeCountModeRepository.findByEventType(req.params.id, db);
      res.json({ success: true, modos });
    } catch (err) {
      console.error('ERROR fetching event type count modes:', err);
      res.status(500).json({ success: false, error: 'Error fetching count modes' });
    }
  });

  // ==========================
  // 6. AGREGAR UNA VIGENCIA NUEVA (cambio de modalidad desde tal fecha)
  // POST /api/event-types/:id/count-modes  Body: { modo, vigenteDesde }
  // Pedido real: esto lo decide el admin de la empresa (una paritaria que
  // cambia la norma de un motivo), no cualquiera que pueda cargar
  // licencias -- mismo permiso que ya protege el resto de la
  // configuracion sensible de la empresa (horarios, tema, limites).
  // ==========================
  router.post('/:id/count-modes', requirePermission('settings', 'update'), async (req, res) => {
    try {
      const { modo, vigenteDesde } = req.body;
      if (!MODOS_VALIDOS.includes(modo)) {
        return res.status(400).json({ success: false, error: `modo debe ser uno de: ${MODOS_VALIDOS.join(', ')}` });
      }
      if (!vigenteDesde || Number.isNaN(new Date(`${vigenteDesde}T00:00:00`).getTime())) {
        return res.status(400).json({ success: false, error: 'vigenteDesde (YYYY-MM-DD) es requerido' });
      }

      const eventType = await findEventTypeOrNull(req.params.id, resolveTenantId(req));
      if (!eventType) return res.status(404).json({ success: false, error: 'Motivo no encontrado' });

      const id = await eventTypeCountModeRepository.create(
        { eventTypeId: req.params.id, modo, vigenteDesde, createdBy: req.appUser ? req.appUser.id : null },
        db
      );
      res.json({ success: true, id });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya hay una vigencia cargada con esa misma fecha para este motivo' });
      }
      console.error('ERROR creating event type count mode:', err);
      res.status(500).json({ success: false, error: 'Error creating count mode' });
    }
  });

  return router;
};
