const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR CIUDADES
  // ==========================
  router.get('/', requirePermission('employees', 'read'), async (req, res) => {
    try {
      const { includeInactive } = req.query;
      const effectiveTenantId = resolveTenantId(req);
      const tenantClause = effectiveTenantId !== null ? ' AND tenant_id = ?' : '';
      const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
      const sql = includeInactive === 'true'
        ? `SELECT * FROM ciudades WHERE 1=1${tenantClause} ORDER BY nombre ASC`
        : `SELECT * FROM ciudades WHERE active = 1${tenantClause} ORDER BY nombre ASC`;
      const [rows] = await db.query(sql, tenantParams);
      res.json({ success: true, ciudades: rows });
    } catch (err) {
      console.error('ERROR fetching ciudades:', err);
      res.status(500).json({ success: false, error: 'Error fetching ciudades' });
    }
  });

  // ==========================
  // 2. CREAR CIUDAD
  // ==========================
  router.post('/', requirePermission('employees', 'create'), async (req, res) => {
    try {
      const { nombre } = req.body;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ success: false, error: 'nombre es requerido' });
      }

      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : (req.body.tenant_id ?? req.body.tenantId ?? null);

      const [result] = await db.query(
        'INSERT INTO ciudades (tenant_id, nombre, active) VALUES (?, ?, 1)',
        [tenantId, nombre.trim()]
      );

      res.json({ success: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating ciudad:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una ciudad con ese nombre' });
      }
      res.status(500).json({ success: false, error: 'Error creating ciudad' });
    }
  });

  // ==========================
  // 3. RENOMBRAR / ACTUALIZAR CIUDAD
  // ==========================
  router.put('/:id', requirePermission('employees', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { nombre, active } = req.body;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ success: false, error: 'nombre es requerido' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM ciudades WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
        }
      }

      const [result] = await db.query(
        'UPDATE ciudades SET nombre = ?, active = ? WHERE id = ?',
        [nombre.trim(), active !== undefined ? (active ? 1 : 0) : 1, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR updating ciudad:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una ciudad con ese nombre' });
      }
      res.status(500).json({ success: false, error: 'Error updating ciudad' });
    }
  });

  // ==========================
  // 4. DESACTIVAR CIUDAD (soft delete -- no rompe sucursales/empleados ya asignados)
  // ==========================
  router.delete('/:id', requirePermission('employees', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM ciudades WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
        }
      }

      const [result] = await db.query('UPDATE ciudades SET active = 0 WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deactivating ciudad:', err);
      res.status(500).json({ success: false, error: 'Error deactivating ciudad' });
    }
  });

  return router;
};
