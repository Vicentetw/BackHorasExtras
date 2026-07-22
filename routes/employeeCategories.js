const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR CATEGORÍAS
  // ==========================
  router.get('/', requirePermission('employees', 'read'), async (req, res) => {
    try {
      const { includeInactive } = req.query;
      const effectiveTenantId = resolveTenantId(req);
      const tenantClause = effectiveTenantId !== null ? ' AND (tenant_id = ? OR tenant_id IS NULL)' : '';
      const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
      const sql = includeInactive === 'true'
        ? `SELECT * FROM employee_categories WHERE 1=1${tenantClause} ORDER BY name ASC`
        : `SELECT * FROM employee_categories WHERE active = 1${tenantClause} ORDER BY name ASC`;
      const [rows] = await db.query(sql, tenantParams);
      res.json({ success: true, categories: rows });
    } catch (err) {
      console.error('ERROR fetching employee categories:', err);
      res.status(500).json({ success: false, error: 'Error fetching employee categories' });
    }
  });

  // ==========================
  // 2. CREAR CATEGORÍA
  // ==========================
  router.post('/', requirePermission('employees', 'create'), async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name es requerido' });
      }

      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : (req.body.tenant_id ?? req.body.tenantId ?? null);

      const [result] = await db.query(
        'INSERT INTO employee_categories (tenant_id, name, active) VALUES (?, ?, 1)',
        [tenantId, name.trim()]
      );

      res.json({ success: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating employee category:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una categoría con ese nombre' });
      }
      res.status(500).json({ success: false, error: 'Error creating employee category' });
    }
  });

  // ==========================
  // 3. RENOMBRAR / ACTUALIZAR CATEGORÍA
  // ==========================
  router.put('/:id', requirePermission('employees', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { name, active } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name es requerido' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM employee_categories WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
        }
      }

      const [result] = await db.query(
        'UPDATE employee_categories SET name = ?, active = ? WHERE id = ?',
        [name.trim(), active !== undefined ? (active ? 1 : 0) : 1, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR updating employee category:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una categoría con ese nombre' });
      }
      res.status(500).json({ success: false, error: 'Error updating employee category' });
    }
  });

  // ==========================
  // 4. DESACTIVAR CATEGORÍA (soft delete, no rompe empleados ya asignados)
  // ==========================
  router.delete('/:id', requirePermission('employees', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM employee_categories WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
        }
      }

      const [result] = await db.query('UPDATE employee_categories SET active = 0 WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deactivating employee category:', err);
      res.status(500).json({ success: false, error: 'Error deactivating employee category' });
    }
  });

  return router;
};
