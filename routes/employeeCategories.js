const express = require('express');
const { requirePermission, requireAnyPermission, resolveTenantId } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR CATEGORÍAS
  // ==========================
  // Nombres de categorías: también para el filtro de Presentismo y Horarios de empleados (2026-10-09).
  router.get('/', requireAnyPermission([['employees', 'read'], ['attendance', 'read'], ['schedules', 'read']]), async (req, res) => {
    try {
      const { includeInactive } = req.query;
      // Sin fallback a tenant_id IS NULL: la migracion a categorias por
      // tenant ya esta completa, no debe quedar ninguna fila global -- si
      // alguna vez aparece una (import/bug), mejor invisible para todos que
      // visible para todos.
      const effectiveTenantId = resolveTenantId(req);
      const tenantClause = effectiveTenantId !== null ? ' AND tenant_id = ?' : '';
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
  // 3b. PLANTILLA Y CONVENIO SUGERIDOS (migración 20261016)
  // ==========================
  // Solo sugerencias: completan el alta de un empleado de esta categoría y
  // "aplicar a todos los de la categoría". No cambian ningún cálculo. Tienen
  // que ser de la misma empresa que la categoría; null = sin sugerencia.
  router.put('/:id/sugerencias', requirePermission('employees', 'update'), async (req, res) => {
    const id = Number(req.params.id);
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const plantilla = num(req.body?.plantilla_sugerida_id);
    const convenio = num(req.body?.convenio_sugerido_id);
    const regimen = convenio == null ? null : num(req.body?.regimen_sugerido_id);
    try {
      const [[cat]] = await db.query('SELECT id, tenant_id FROM employee_categories WHERE id = ?', [id]);
      const effectiveTenantId = resolveTenantId(req);
      if (!cat || (effectiveTenantId !== null && cat.tenant_id !== effectiveTenantId)) {
        return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      }
      if (plantilla != null) {
        const [[t]] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [plantilla]);
        if (!t || t.tenant_id !== cat.tenant_id) return res.status(400).json({ success: false, error: 'La plantilla no es de esta empresa' });
      }
      if (convenio != null) {
        const [[c]] = await db.query('SELECT tenant_id FROM labor_conventions WHERE id = ?', [convenio]);
        if (!c || c.tenant_id !== cat.tenant_id) return res.status(400).json({ success: false, error: 'El convenio no es de esta empresa' });
      }
      if (regimen != null) {
        const [[r]] = await db.query('SELECT convention_id FROM labor_convention_regimes WHERE id = ?', [regimen]);
        if (!r || r.convention_id !== convenio) return res.status(400).json({ success: false, error: 'El régimen no es de ese convenio' });
      }
      await db.query(
        'UPDATE employee_categories SET plantilla_sugerida_id = ?, convenio_sugerido_id = ?, regimen_sugerido_id = ? WHERE id = ?',
        [plantilla, convenio, regimen, id]);
      res.json({ success: true });
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        return res.status(503).json({ success: false, error: 'Falta correr la migración 20261016 (sugerencias por categoría).' });
      }
      console.error('ERROR saving category suggestions:', err);
      res.status(500).json({ success: false, error: 'Error al guardar las sugerencias' });
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
