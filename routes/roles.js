const express = require('express');
const { requirePermission, requireSuperadmin } = require('../appUserMiddleware');

// Roles = presets con nombre por encima del modelo de permisos granular que
// ya existia (user_permissions, "modulo:accion" por usuario). Ver la
// migracion 20260902_add_roles.sql y appUserRepository.findByFirebaseUid
// para como se combinan (permisos del rol UNION overrides individuales).
// Los roles de sistema (is_system=1, sembrados por la migracion) no se
// pueden borrar ni editar sus permisos -- solo superadmin puede crear
// roles nuevos por ahora (evita que cada empresa termine con su propia
// taxonomia de roles sin ningun control).
module.exports = function (db) {
  const router = express.Router();

  router.get('/', requirePermission('users', 'read'), async (req, res) => {
    try {
      const [roles] = await db.query('SELECT id, name, description, is_system FROM roles ORDER BY is_system DESC, name');
      const [permRows] = await db.query('SELECT role_id, permission FROM role_permissions');
      const permsByRole = new Map();
      for (const row of permRows) {
        if (!permsByRole.has(row.role_id)) permsByRole.set(row.role_id, []);
        permsByRole.get(row.role_id).push(row.permission);
      }
      res.json({
        roles: roles.map((r) => ({ ...r, isSystem: Boolean(r.is_system), permissions: permsByRole.get(r.id) || [] })),
      });
    } catch (err) {
      console.error('ERROR listing roles:', err);
      res.status(500).json({ error: 'Error al listar roles' });
    }
  });

  router.post('/', requireSuperadmin, async (req, res) => {
    try {
      const { name, description, permissions } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'name es requerido' });
      }
      const [result] = await db.query(
        'INSERT INTO roles (name, description, is_system) VALUES (?, ?, 0)',
        [name.trim(), description || null]
      );
      if (Array.isArray(permissions) && permissions.length) {
        const values = permissions.map((p) => [result.insertId, p]);
        await db.query('INSERT INTO role_permissions (role_id, permission) VALUES ?', [values]);
      }
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating role:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });
      }
      res.status(500).json({ error: 'Error al crear el rol' });
    }
  });

  router.put('/:id', requireSuperadmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, permissions } = req.body;

      const [[role]] = await db.query('SELECT is_system FROM roles WHERE id = ?', [id]);
      if (!role) {
        return res.status(404).json({ error: 'Rol no encontrado' });
      }
      if (role.is_system) {
        return res.status(403).json({ error: 'No se puede editar un rol de sistema' });
      }

      if (name !== undefined || description !== undefined) {
        const updates = [];
        const params = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description || null); }
        params.push(id);
        await db.query(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      if (Array.isArray(permissions)) {
        await db.query('DELETE FROM role_permissions WHERE role_id = ?', [id]);
        if (permissions.length) {
          const values = permissions.map((p) => [id, p]);
          await db.query('INSERT INTO role_permissions (role_id, permission) VALUES ?', [values]);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR updating role:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });
      }
      res.status(500).json({ error: 'Error al actualizar el rol' });
    }
  });

  router.delete('/:id', requireSuperadmin, async (req, res) => {
    try {
      const { id } = req.params;
      const [[role]] = await db.query('SELECT is_system FROM roles WHERE id = ?', [id]);
      if (!role) {
        return res.status(404).json({ error: 'Rol no encontrado' });
      }
      if (role.is_system) {
        return res.status(403).json({ error: 'No se puede borrar un rol de sistema' });
      }
      const [[{ count }]] = await db.query('SELECT COUNT(*) as count FROM app_users WHERE role_id = ?', [id]);
      if (count > 0) {
        return res.status(409).json({ error: `Hay ${count} usuario(s) con este rol asignado -- reasignalos antes de borrarlo` });
      }
      await db.query('DELETE FROM roles WHERE id = ?', [id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR deleting role:', err);
      res.status(500).json({ error: 'Error al borrar el rol' });
    }
  });

  return router;
};
