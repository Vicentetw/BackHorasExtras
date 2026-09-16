const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR SUCURSALES (opcionalmente filtradas por ciudad)
  // ==========================
  router.get('/', requirePermission('employees', 'read'), async (req, res) => {
    try {
      const { includeInactive, ciudadId } = req.query;
      const effectiveTenantId = resolveTenantId(req);

      let sql = includeInactive === 'true' ? 'SELECT * FROM sucursales WHERE 1=1' : 'SELECT * FROM sucursales WHERE active = 1';
      const params = [];
      if (effectiveTenantId !== null) {
        // tenant_id IS NULL = sucursal global (bajo una ciudad global) --
        // visible ademas de las propias de la empresa. Mismo criterio que ciudades.
        sql += ' AND (tenant_id = ? OR tenant_id IS NULL)';
        params.push(effectiveTenantId);
      }
      if (ciudadId) {
        sql += ' AND ciudad_id = ?';
        params.push(ciudadId);
      }
      sql += ' ORDER BY nombre ASC';

      const [rows] = await db.query(sql, params);
      res.json({ success: true, sucursales: rows });
    } catch (err) {
      console.error('ERROR fetching sucursales:', err);
      res.status(500).json({ success: false, error: 'Error fetching sucursales' });
    }
  });

  // Chequea que la ciudad exista y sea de la empresa de quien pide, O sea
  // una ciudad global (tenant_id NULL, cargada por un superadmin) -- una
  // sucursal de una empresa puntual puede vivir bajo una ciudad global sin
  // problema, no hace falta que la ciudad tambien sea de esa empresa.
  async function findCiudadOrNull(db, ciudadId, effectiveTenantId) {
    const [[row]] = await db.query('SELECT id, tenant_id FROM ciudades WHERE id = ?', [ciudadId]);
    if (!row) return null;
    if (effectiveTenantId !== null && row.tenant_id !== null && row.tenant_id !== effectiveTenantId) return null;
    return row;
  }

  // ==========================
  // 2. CREAR SUCURSAL
  // ==========================
  router.post('/', requirePermission('employees', 'create'), async (req, res) => {
    try {
      const { nombre, ciudad_id: ciudadId, ciudadId: ciudadIdCamel } = req.body;
      const resolvedCiudadId = ciudadId ?? ciudadIdCamel;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ success: false, error: 'nombre es requerido' });
      }
      if (!resolvedCiudadId) {
        return res.status(400).json({ success: false, error: 'ciudad_id es requerido' });
      }

      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : (req.body.tenant_id ?? req.body.tenantId ?? null);

      const ciudad = await findCiudadOrNull(db, resolvedCiudadId, tenantId);
      if (!ciudad) {
        return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
      }

      const [result] = await db.query(
        'INSERT INTO sucursales (tenant_id, ciudad_id, nombre, active) VALUES (?, ?, ?, 1)',
        [tenantId, resolvedCiudadId, nombre.trim()]
      );

      res.json({ success: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating sucursal:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una sucursal con ese nombre en esa ciudad' });
      }
      res.status(500).json({ success: false, error: 'Error creating sucursal' });
    }
  });

  // ==========================
  // 3. RENOMBRAR / ACTUALIZAR SUCURSAL
  // ==========================
  router.put('/:id', requirePermission('employees', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { nombre, active, ciudad_id: ciudadId, ciudadId: ciudadIdCamel } = req.body;
      const resolvedCiudadId = ciudadId ?? ciudadIdCamel;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ success: false, error: 'nombre es requerido' });
      }
      if (!resolvedCiudadId) {
        return res.status(400).json({ success: false, error: 'ciudad_id es requerido' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM sucursales WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Sucursal no encontrada' });
        }
      }

      const ciudad = await findCiudadOrNull(db, resolvedCiudadId, effectiveTenantId);
      if (!ciudad) {
        return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
      }

      const [result] = await db.query(
        'UPDATE sucursales SET nombre = ?, ciudad_id = ?, active = ? WHERE id = ?',
        [nombre.trim(), resolvedCiudadId, active !== undefined ? (active ? 1 : 0) : 1, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Sucursal no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR updating sucursal:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una sucursal con ese nombre en esa ciudad' });
      }
      res.status(500).json({ success: false, error: 'Error updating sucursal' });
    }
  });

  // ==========================
  // 4. DESACTIVAR SUCURSAL (soft delete -- no rompe empleados ya asignados)
  // ==========================
  router.delete('/:id', requirePermission('employees', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM sucursales WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Sucursal no encontrada' });
        }
      }

      const [result] = await db.query('UPDATE sucursales SET active = 0 WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Sucursal no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deactivating sucursal:', err);
      res.status(500).json({ success: false, error: 'Error deactivating sucursal' });
    }
  });

  return router;
};
