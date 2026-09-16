const express = require('express');
const { requireAnyPermission, resolveTenantId } = require('../appUserMiddleware');

// Ciudades las consume tanto Empleados como Feriados -- un rol con
// permisos de Feriados pero no de Empleados (o viceversa) tiene que poder
// gestionarlas igual desde donde le toque trabajar. requirePermission
// exigiria los DOS a la vez; requireAnyPermission alcanza con cualquiera.
const canRead = requireAnyPermission([['employees', 'read'], ['holidays', 'read']]);
const canCreate = requireAnyPermission([['employees', 'create'], ['holidays', 'create']]);
const canUpdate = requireAnyPermission([['employees', 'update'], ['holidays', 'update']]);
const canDelete = requireAnyPermission([['employees', 'delete'], ['holidays', 'delete']]);

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR CIUDADES
  // ==========================
  router.get('/', canRead, async (req, res) => {
    try {
      const { includeInactive } = req.query;
      const effectiveTenantId = resolveTenantId(req);
      // tenant_id IS NULL = ciudad global (la carga un superadmin sin
      // empresa seleccionada, ver POST de abajo) -- visible para todos,
      // ademas de las propias de la empresa. Mismo criterio que holidays.
      const tenantClause = effectiveTenantId !== null ? ' AND (tenant_id = ? OR tenant_id IS NULL)' : '';
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
  router.post('/', canCreate, async (req, res) => {
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
  router.put('/:id', canUpdate, async (req, res) => {
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
  // 4. USO ACTUAL DE LA CIUDAD (para avisar antes de desactivarla)
  // ==========================
  // Pedido real: "quitar" una ciudad no avisaba en que condiciones se podia
  // hacer -- si ya tenia empleados, sucursales o feriados asignados, el
  // admin no tenia forma de saberlo antes de confirmar. El soft-delete en
  // si nunca rompe nada (las filas ya asignadas conservan el id, ver DELETE
  // mas abajo) -- esto es solo para que la confirmacion en el frontend
  // muestre numeros reales en vez de una advertencia generica.
  router.get('/:id/usage', canRead, async (req, res) => {
    try {
      const { id } = req.params;
      const [[{ employees }]] = await db.query('SELECT COUNT(*) AS employees FROM employees WHERE ciudad_id = ?', [id]);
      const [[{ sucursales }]] = await db.query('SELECT COUNT(*) AS sucursales FROM sucursales WHERE ciudad_id = ?', [id]);
      const [[{ holidays }]] = await db.query('SELECT COUNT(*) AS holidays FROM holidays WHERE ciudad_id = ?', [id]);
      res.json({ success: true, usage: { employees, sucursales, holidays } });
    } catch (err) {
      console.error('ERROR fetching ciudad usage:', err);
      res.status(500).json({ success: false, error: 'Error fetching ciudad usage' });
    }
  });

  // ==========================
  // 5. DESACTIVAR CIUDAD (soft delete -- no rompe sucursales/empleados/feriados ya asignados)
  // ==========================
  router.delete('/:id', canDelete, async (req, res) => {
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
