const express = require('express');
const { requirePermission, requireAnyPermission, resolveTenantId } = require('../appUserMiddleware');

// Leer sucursales tambien hace falta desde el dialogo compartido de
// Ciudades/Sucursales cuando se abre desde Feriados (ciudades es un
// recurso compartido, ver routes/ciudades.js) -- la escritura (alta/baja/
// rename) se queda solo en Empleados, una sucursal no tiene relacion con
// feriados hoy.
const canRead = requireAnyPermission([['employees', 'read'], ['holidays', 'read']]);

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR SUCURSALES (opcionalmente filtradas por ciudad)
  // ==========================
  router.get('/', canRead, async (req, res) => {
    try {
      const { includeInactive, ciudadId } = req.query;
      const effectiveTenantId = resolveTenantId(req);

      // Bug real: si se desactivaba la ciudad, sus sucursales (todavia con
      // active=1 en su propia fila) seguian apareciendo como elegibles en
      // cualquier picker -- quedaba la ciudad "apagada" pero sus sedes
      // seleccionables igual. El JOIN exige que la ciudad TAMBIEN este
      // activa para el listado por defecto; includeInactive sigue trayendo
      // todo (se usa para mostrar el nombre de asignaciones ya existentes).
      let sql = includeInactive === 'true'
        ? 'SELECT s.* FROM sucursales s WHERE 1=1'
        : 'SELECT s.* FROM sucursales s JOIN ciudades c ON c.id = s.ciudad_id WHERE s.active = 1 AND c.active = 1';
      const params = [];
      if (effectiveTenantId !== null) {
        // tenant_id IS NULL = sucursal global (bajo una ciudad global) --
        // visible ademas de las propias de la empresa. Mismo criterio que ciudades.
        sql += ' AND (s.tenant_id = ? OR s.tenant_id IS NULL)';
        params.push(effectiveTenantId);
      }
      if (ciudadId) {
        sql += ' AND s.ciudad_id = ?';
        params.push(ciudadId);
      }
      sql += ' ORDER BY s.nombre ASC';

      const [rows] = await db.query(sql, params);
      res.json({ success: true, sucursales: rows });
    } catch (err) {
      console.error('ERROR fetching sucursales:', err);
      res.status(500).json({ success: false, error: 'Error fetching sucursales' });
    }
  });

  // ==========================
  // 1B. USO ACTUAL DE LA SUCURSAL (para avisar antes de desactivarla)
  // ==========================
  router.get('/:id/usage', canRead, async (req, res) => {
    try {
      const { id } = req.params;
      const [[{ employees }]] = await db.query('SELECT COUNT(*) AS employees FROM employees WHERE sucursal_id = ?', [id]);
      res.json({ success: true, usage: { employees } });
    } catch (err) {
      console.error('ERROR fetching sucursal usage:', err);
      res.status(500).json({ success: false, error: 'Error fetching sucursal usage' });
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
