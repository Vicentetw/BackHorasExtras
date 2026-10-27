const express = require('express');
const { requirePermission, requireAnyPermission, resolveTenantId } = require('../appUserMiddleware');

// Áreas de cada empresa (2026-10-26, punto Q; migración 20261025_areas).
// Un área agrupa empleados ("Depósito", "Ventas"...) y sirve para limitar a
// un usuario a su gente (ver alcance.js). Las administra quien puede editar
// empleados. Sin la migración, la lista sale vacía con disponible: false y
// no se puede crear nada (la pantalla avisa).
module.exports = function (db) {
  const router = express.Router();
  const SIN_MIGRACION = 'Todavía no se pueden usar áreas: falta una actualización del sistema. Avisale a soporte.';
  const faltaTabla = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

  function empresa(req, res) {
    const t = resolveTenantId(req);
    if (t == null) { res.status(400).json({ error: 'Elegí primero en qué empresa trabajar.' }); return null; }
    return t;
  }

  router.get('/', requireAnyPermission([['employees', 'read'], ['attendance', 'read'], ['users', 'read'], ['schedules', 'read']]), async (req, res) => {
    const t = empresa(req, res); if (t == null) return;
    try {
      const [areas] = await db.query(
        `SELECT a.id, a.nombre,
                (SELECT COUNT(*) FROM employees e WHERE e.area_id = a.id AND e.activo = 1) AS empleados,
                (SELECT COUNT(*) FROM app_user_areas ua WHERE ua.area_id = a.id) AS usuarios
           FROM areas a WHERE a.tenant_id = ? ORDER BY a.nombre`, [t]);
      res.json({ disponible: true, areas: areas.map((a) => ({ ...a, empleados: Number(a.empleados), usuarios: Number(a.usuarios) })) });
    } catch (err) {
      if (faltaTabla(err)) return res.json({ disponible: false, areas: [] });
      console.error('ERROR listando áreas:', err);
      res.status(500).json({ error: 'Error al listar las áreas' });
    }
  });

  function nombreValido(nombre) {
    const n = String(nombre || '').trim();
    if (!n) return { error: 'Poné un nombre para el área.' };
    if (n.length > 100) return { error: 'El nombre es demasiado largo (máximo 100 letras).' };
    return { n };
  }

  router.post('/', requirePermission('employees', 'update'), async (req, res) => {
    const t = empresa(req, res); if (t == null) return;
    const v = nombreValido(req.body?.nombre);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const [r] = await db.query('INSERT INTO areas (tenant_id, nombre) VALUES (?, ?)', [t, v.n]);
      res.json({ ok: true, id: r.insertId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay un área con ese nombre.' });
      if (faltaTabla(err)) return res.status(409).json({ error: SIN_MIGRACION });
      console.error('ERROR creando área:', err);
      res.status(500).json({ error: 'Error al crear el área' });
    }
  });

  router.put('/:id', requirePermission('employees', 'update'), async (req, res) => {
    const t = empresa(req, res); if (t == null) return;
    const v = nombreValido(req.body?.nombre);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const [r] = await db.query('UPDATE areas SET nombre = ? WHERE id = ? AND tenant_id = ?', [v.n, req.params.id, t]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Área no encontrada' });
      res.json({ ok: true });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay un área con ese nombre.' });
      if (faltaTabla(err)) return res.status(409).json({ error: SIN_MIGRACION });
      console.error('ERROR renombrando área:', err);
      res.status(500).json({ error: 'Error al guardar el área' });
    }
  });

  router.delete('/:id', requirePermission('employees', 'update'), async (req, res) => {
    const t = empresa(req, res); if (t == null) return;
    try {
      const [[a]] = await db.query('SELECT id FROM areas WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
      if (!a) return res.status(404).json({ error: 'Área no encontrada' });
      // Si se borrara el área de un usuario limitado a ella, ese usuario
      // pasaría a ver TODA la empresa (sin áreas = sin límite). Primero hay
      // que cambiarle las áreas.
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM app_user_areas WHERE area_id = ?', [a.id]);
      if (n > 0) return res.status(409).json({ error: `Hay ${n} usuario(s) que ven solo esta área: cambiales las áreas en Usuarios y roles antes de borrarla.` });
      // Los empleados quedan sin área (la clave foránea los pasa a NULL).
      await db.query('DELETE FROM areas WHERE id = ?', [a.id]);
      res.json({ ok: true });
    } catch (err) {
      if (faltaTabla(err)) return res.status(409).json({ error: SIN_MIGRACION });
      console.error('ERROR borrando área:', err);
      res.status(500).json({ error: 'Error al borrar el área' });
    }
  });

  // Asignar (o quitar, con areaId null) el área de varios empleados a la vez.
  router.put('/asignar/empleados', requirePermission('employees', 'update'), async (req, res) => {
    const t = empresa(req, res); if (t == null) return;
    const ids = Array.isArray(req.body?.employeeIds) ? req.body.employeeIds.map(Number).filter(Number.isInteger) : [];
    const areaId = req.body?.areaId == null ? null : Number(req.body.areaId);
    if (!ids.length) return res.status(400).json({ error: 'Elegí al menos un empleado.' });
    try {
      if (areaId != null) {
        const [[a]] = await db.query('SELECT id FROM areas WHERE id = ? AND tenant_id = ?', [areaId, t]);
        if (!a) return res.status(404).json({ error: 'Área no encontrada' });
      }
      const [r] = await db.query('UPDATE employees SET area_id = ? WHERE tenant_id = ? AND id IN (?)', [areaId, t, ids]);
      res.json({ ok: true, actualizados: r.affectedRows });
    } catch (err) {
      if (faltaTabla(err)) return res.status(409).json({ error: SIN_MIGRACION });
      console.error('ERROR asignando área:', err);
      res.status(500).json({ error: 'Error al asignar el área' });
    }
  });

  return router;
};
