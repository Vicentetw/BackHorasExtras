const express = require('express');
const admin = require('firebase-admin');
const { resolveTenantId, requireSuperadmin, requirePermission } = require('../appUserMiddleware');
const appUserRepository = require('../motor-laboral/repositories/appUserRepository');

// Panel de administracion de usuarios de la app (no confundir con los
// "empleados" de RRHH -- estos son las cuentas que pueden ENTRAR al
// sistema). Un usuario normal solo administra los de su propia empresa;
// el superadmin puede ademas elegir tenant y otorgar superadmin.

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 0. QUIEN SOY (para que el front sepa si mostrar controles de superadmin)
  // ==========================
  router.get('/me', async (req, res) => {
    if (!req.appUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({
      id: req.appUser.id,
      email: req.appUser.email,
      tenantId: req.appUser.tenantId,
      roleId: req.appUser.roleId,
      isSuperadmin: req.appUser.isSuperadmin,
      permissions: Array.from(req.appUser.permissions)
    });
  });

  // ==========================
  // 1. LISTAR USUARIOS DE MI EMPRESA (o de un tenant puntual si soy superadmin)
  // ==========================
  router.get('/', requirePermission('users', 'read'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId === null && !(req.appUser && req.appUser.isSuperadmin)) {
        return res.status(400).json({ error: 'No se pudo resolver tu empresa' });
      }
      if (effectiveTenantId === null) {
        // Superadmin sin ?tenantId= explicito: lista todos los app_users
        const [rows] = await db.query(
          `SELECT id, firebase_uid, email, tenant_id, role_id, is_superadmin, is_active, created_at FROM app_users ORDER BY tenant_id, email`
        );
        return res.json({ users: rows });
      }
      const rows = await appUserRepository.listByTenant(effectiveTenantId, db);
      const withPermissions = await Promise.all(rows.map(async (u) => {
        const [permRows] = await db.query('SELECT permission FROM user_permissions WHERE user_id = ?', [u.id]);
        return { ...u, permissions: permRows.map((p) => p.permission) };
      }));
      res.json({ users: withPermissions });
    } catch (err) {
      console.error('ERROR listing app users:', err);
      res.status(500).json({ error: 'Error al listar usuarios' });
    }
  });

  // ==========================
  // 2. CREAR/INVITAR USUARIO
  // Crea la cuenta de Firebase si no existe (con password temporal) y
  // devuelve un link de restablecimiento para que la persona elija la
  // suya -- este sistema no tiene envio de mail propio todavia, hay que
  // pasarle el link a mano (whatsapp, mail personal, etc).
  // ==========================
  router.post('/', requirePermission('users', 'create'), async (req, res) => {
    try {
      const { email, permissions, roleId } = req.body;
      const bodyTenantId = req.body.tenant_id ?? req.body.tenantId;
      const isSuperadminRequested = Boolean(req.body.isSuperadmin) && req.appUser && req.appUser.isSuperadmin;

      if (!email) {
        return res.status(400).json({ error: 'email es requerido' });
      }

      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : bodyTenantId;

      if (!isSuperadminRequested && (tenantId === undefined || tenantId === null)) {
        return res.status(400).json({ error: 'tenantId es requerido (salvo que sea superadmin)' });
      }

      let firebaseUser;
      try {
        firebaseUser = await admin.auth().getUserByEmail(email);
      } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
        const tempPassword = Math.random().toString(36).slice(-10) + 'A1!';
        firebaseUser = await admin.auth().createUser({ email, password: tempPassword });
      }

      const [existing] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [firebaseUser.uid]);
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Ese email ya tiene una cuenta habilitada en el sistema' });
      }

      const [result] = await db.query(
        `INSERT INTO app_users (firebase_uid, email, tenant_id, is_superadmin, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [firebaseUser.uid, email, isSuperadminRequested ? null : tenantId, isSuperadminRequested ? 1 : 0]
      );

      if (Array.isArray(permissions) && permissions.length) {
        await appUserRepository.setPermissions(result.insertId, permissions, db);
      }
      if (roleId) {
        await appUserRepository.setRole(result.insertId, roleId, db);
      }

      let resetLink = null;
      try {
        resetLink = await admin.auth().generatePasswordResetLink(email);
      } catch (err) {
        console.warn('No se pudo generar el link de restablecimiento:', err.message);
      }

      res.json({ ok: true, id: result.insertId, resetLink });
    } catch (err) {
      console.error('ERROR creating app user:', err);
      res.status(500).json({ error: 'Error al crear usuario: ' + err.message });
    }
  });

  // ==========================
  // 3. ACTUALIZAR PERMISOS / ESTADO
  // ==========================
  router.put('/:id', requirePermission('users', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { permissions, isActive, tenant_id: bodyTenantId, isSuperadmin, roleId } = req.body;

      const [[user]] = await db.query('SELECT id, tenant_id FROM app_users WHERE id = ?', [id]);
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && user.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (Array.isArray(permissions)) {
        await appUserRepository.setPermissions(id, permissions, db);
      }
      // roleId: undefined -> no tocar; null -> volver a "sin rol" (permisos
      // 100% manuales); numero -> asignar ese rol.
      if (roleId !== undefined) {
        await appUserRepository.setRole(id, roleId, db);
      }

      const updates = [];
      const params = [];
      if (isActive !== undefined) {
        updates.push('is_active = ?');
        params.push(isActive ? 1 : 0);
      }
      // Solo el superadmin puede reasignar tenant u otorgar superadmin
      if (req.appUser && req.appUser.isSuperadmin) {
        if (bodyTenantId !== undefined) {
          updates.push('tenant_id = ?');
          params.push(bodyTenantId);
        }
        if (isSuperadmin !== undefined) {
          updates.push('is_superadmin = ?');
          params.push(isSuperadmin ? 1 : 0);
        }
      }
      if (updates.length) {
        params.push(id);
        await db.query(`UPDATE app_users SET ${updates.join(', ')} WHERE id = ?`, params);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR updating app user:', err);
      res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  });

  // ==========================
  // 4. DESHABILITAR (soft-delete: is_active = 0, no se borra la cuenta)
  // ==========================
  router.delete('/:id', requirePermission('users', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const [[user]] = await db.query('SELECT id, tenant_id FROM app_users WHERE id = ?', [id]);
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && user.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      await db.query('UPDATE app_users SET is_active = 0 WHERE id = ?', [id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR deactivating app user:', err);
      res.status(500).json({ error: 'Error al deshabilitar usuario' });
    }
  });

  return router;
};
