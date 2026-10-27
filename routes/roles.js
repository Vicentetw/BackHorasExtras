const express = require('express');
const { requirePermission } = require('../appUserMiddleware');
const permisos = require('../motor-laboral/services/permisos');
const { administradoresActivos, PERMISO_ADMIN } = require('../motor-laboral/services/administradoresDeEmpresa');

// Roles = presets con nombre por encima del modelo de permisos granular que
// ya existia (user_permissions, "modulo:accion" por usuario). Ver la
// migracion 20260902_add_roles.sql y appUserRepository.findByFirebaseUid
// para como se combinan (permisos del rol UNION overrides individuales).
//
// Roles por empresa (2026-10-26, punto O, migración 20261024):
//   - De la plataforma (tenant_id NULL): los de sistema (no se editan ni se
//     borran) y los que crea el superadmin fuera de una empresa. Los ven
//     todas las empresas.
//   - Propios de una empresa (tenant_id = la empresa): los crea, edita y
//     borra su administrador (o el superadmin trabajando en esa empresa).
//     Ninguna otra empresa los ve. Antes solo el superadmin podía crear
//     roles, y todas las empresas veían todos.
//   - Nadie arma un rol con permisos que no tiene (punto S, ver permisos.js).
// Sin la migración todo funciona como antes y las empresas no pueden crear
// roles (se avisa).
module.exports = function (db) {
  const router = express.Router();

  // Superadmin de verdad, fuera del modo soporte: administra la plataforma.
  const esPlataforma = (req) => !!req.appUser?.isSuperadmin;
  const SIN_MIGRACION = 'Todavía no se pueden crear roles propios de la empresa: falta una actualización del sistema. Avisale a soporte.';

  router.get('/', requirePermission('users', 'read'), async (req, res) => {
    try {
      const aplicada = await permisos.rolesCompletosAplicada(db);
      const tenantId = req.appUser?.tenantId ?? null;
      let roles;
      if (!aplicada) {
        [roles] = await db.query('SELECT id, name, description, is_system, NULL AS tenant_id, 1 AS ofrecido FROM roles ORDER BY is_system DESC, name');
      } else if (esPlataforma(req)) {
        [roles] = await db.query('SELECT id, name, description, is_system, tenant_id, ofrecido FROM roles ORDER BY is_system DESC, tenant_id IS NOT NULL, name');
      } else {
        [roles] = await db.query(
          `SELECT id, name, description, is_system, tenant_id, ofrecido FROM roles
            WHERE tenant_id IS NULL OR tenant_id = ? ORDER BY is_system DESC, tenant_id IS NOT NULL, name`, [tenantId]);
      }
      const ids = roles.map((r) => r.id);
      const [permRows] = ids.length ? await db.query('SELECT role_id, permission FROM role_permissions WHERE role_id IN (?)', [ids]) : [[]];
      const permsByRole = new Map();
      for (const row of permRows) {
        if (!permsByRole.has(row.role_id)) permsByRole.set(row.role_id, []);
        permsByRole.get(row.role_id).push(row.permission);
      }
      // Cuántas cuentas lo usan (de esta empresa; el superadmin, de todas):
      // para avisar antes de editarlo y para no borrar uno en uso.
      const [usos] = ids.length
        ? (esPlataforma(req)
          ? await db.query('SELECT role_id, COUNT(*) AS n FROM app_users WHERE role_id IN (?) GROUP BY role_id', [ids])
          : await db.query('SELECT role_id, COUNT(*) AS n FROM app_users WHERE role_id IN (?) AND tenant_id = ? GROUP BY role_id', [ids, tenantId]))
        : [[]];
      const usosPorRol = new Map(usos.map((u) => [u.role_id, Number(u.n)]));
      res.json({
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          is_system: r.is_system,
          isSystem: Boolean(r.is_system),
          tenantId: r.tenant_id == null ? null : Number(r.tenant_id),
          ofrecido: Boolean(Number(r.ofrecido)),
          usuarios: usosPorRol.get(r.id) || 0,
          // Lo puede cambiar quien pide la lista (para mostrar Editar/Eliminar).
          editable: !r.is_system && (esPlataforma(req) || (r.tenant_id != null && Number(r.tenant_id) === Number(tenantId))),
          permissions: permsByRole.get(r.id) || [],
        })),
        rolesPropiosDisponibles: aplicada,
      });
    } catch (err) {
      console.error('ERROR listing roles:', err);
      res.status(500).json({ error: 'Error al listar roles' });
    }
  });

  // Validación común de nombre y permisos. Devuelve { status, error } o null.
  async function validar(req, { name, permissions, tenantId, excluirId, permisosAntes = [] }) {
    if (name !== undefined) {
      if (!name || !String(name).trim()) return { status: 400, error: 'Poné un nombre para el rol.' };
      if (String(name).trim().length > 100) return { status: 400, error: 'El nombre es demasiado largo (máximo 100 letras).' };
      // Ni repetido en la empresa, ni igual a uno de la plataforma (se confundirían en la lista).
      const [[igual]] = await db.query(
        `SELECT id FROM roles WHERE name = ? AND (tenant_id IS NULL ${tenantId != null ? 'OR tenant_id = ?' : ''}) ${excluirId ? 'AND id <> ?' : ''} LIMIT 1`,
        [String(name).trim(), ...(tenantId != null ? [tenantId] : []), ...(excluirId ? [excluirId] : [])]);
      if (igual) return { status: 409, error: 'Ya existe un rol con ese nombre.' };
    }
    if (permissions !== undefined) {
      if (!Array.isArray(permissions)) return { status: 400, error: 'Permisos inválidos.' };
      const raros = permisos.desconocidos(permissions);
      if (raros.length) return { status: 400, error: `Permisos que no existen: ${raros.join(', ')}` };
      const falta = permisos.queNoTiene(req.appUser, permissions.filter((p) => !permisosAntes.includes(p)));
      if (falta.length) return { status: 403, error: `No podés armar un rol con permisos que vos no tenés: ${permisos.enPalabras(falta)}.` };
    }
    return null;
  }

  // El rol que se quiere cambiar, si quien llama puede cambiarlo.
  async function rolEditable(req, id) {
    const [[role]] = await db.query('SELECT id, name, is_system, tenant_id FROM roles WHERE id = ?', [id]);
    if (!role) return { status: 404, error: 'Rol no encontrado' };
    if (role.is_system) return { status: 403, error: 'Los roles de sistema no se pueden cambiar. Creá uno propio a partir de él.' };
    if (esPlataforma(req)) return { role };
    if (role.tenant_id == null) return { status: 403, error: 'Es un rol de la plataforma: no se puede cambiar desde una empresa.' };
    if (Number(role.tenant_id) !== Number(req.appUser?.tenantId)) return { status: 404, error: 'Rol no encontrado' };
    return { role };
  }

  router.post('/', requirePermission('users', 'update'), async (req, res) => {
    try {
      const { name, description, permissions = [] } = req.body;
      const aplicada = await permisos.rolesCompletosAplicada(db);
      if (!esPlataforma(req) && !aplicada) return res.status(409).json({ error: SIN_MIGRACION });
      const tenantId = esPlataforma(req) ? null : req.appUser.tenantId;
      if (!esPlataforma(req) && tenantId == null) return res.status(400).json({ error: 'No se pudo resolver tu empresa' });
      const mal = await validar(req, { name, permissions, tenantId });
      if (mal) return res.status(mal.status).json({ error: mal.error });
      const [result] = aplicada
        ? await db.query('INSERT INTO roles (name, description, is_system, tenant_id) VALUES (?, ?, 0, ?)', [String(name).trim(), description || null, tenantId])
        : await db.query('INSERT INTO roles (name, description, is_system) VALUES (?, ?, 0)', [String(name).trim(), description || null]);
      if (permissions.length) {
        await db.query('INSERT INTO role_permissions (role_id, permission) VALUES ?', [[...new Set(permissions)].map((p) => [result.insertId, p])]);
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

  router.put('/:id', requirePermission('users', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, permissions } = req.body;

      const r = await rolEditable(req, id);
      if (!r.role) return res.status(r.status).json({ error: r.error });
      const antes = await permisos.permisosDeRol(db, id);
      const mal = await validar(req, { name, permissions, tenantId: r.role.tenant_id, excluirId: id, permisosAntes: antes });
      if (mal) return res.status(mal.status).json({ error: mal.error });

      // Nadie queda afuera por un clic: si el rol deja de poder administrar
      // usuarios, la empresa tiene que seguir teniendo un administrador que no
      // dependa de este rol.
      if (Array.isArray(permissions) && antes.includes(PERMISO_ADMIN) && !permissions.includes(PERMISO_ADMIN) && r.role.tenant_id != null) {
        const admins = await administradoresActivos(db, r.role.tenant_id);
        const [conEsteRol] = admins.length
          ? await db.query(
            `SELECT u.id FROM app_users u WHERE u.id IN (?) AND u.role_id = ?
               AND NOT EXISTS (SELECT 1 FROM user_permissions p WHERE p.user_id = u.id AND p.permission = ?)`, [admins, id, PERMISO_ADMIN])
          : [[]];
        if (admins.length - conEsteRol.length === 0) {
          return res.status(409).json({ error: 'Sin "Usuarios y roles: Editar" en este rol, la empresa se queda sin nadie que pueda administrar usuarios. Primero dale el rol de administrador a otra persona.' });
        }
      }

      if (name !== undefined || description !== undefined) {
        const updates = [];
        const params = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(String(name).trim()); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description || null); }
        params.push(id);
        await db.query(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      if (Array.isArray(permissions)) {
        await db.query('DELETE FROM role_permissions WHERE role_id = ?', [id]);
        if (permissions.length) {
          const values = [...new Set(permissions)].map((p) => [id, p]);
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

  router.delete('/:id', requirePermission('users', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const r = await rolEditable(req, id);
      if (!r.role) return res.status(r.status).json({ error: r.error });
      const [[{ count }]] = await db.query('SELECT COUNT(*) as count FROM app_users WHERE role_id = ?', [id]);
      if (count > 0) {
        return res.status(409).json({ error: `Hay ${count} usuario(s) con este rol: cambiales el rol antes de borrarlo.` });
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
