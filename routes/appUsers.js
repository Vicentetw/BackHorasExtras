const express = require('express');
const { resolveTenantId, requireSuperadmin, requirePermission } = require('../appUserMiddleware');
const appUserRepository = require('../motor-laboral/repositories/appUserRepository');
const billingRepository = require('../motor-laboral/repositories/billingRepository');
const { resolveEffectiveStatus, DEFAULT_GRACE_DAYS } = require('../motor-laboral/services/billingCalculations');

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

    // Fase 10 (panel de Pagos del cliente): el front necesita saber si la
    // suscripcion de su empresa esta cancelada para redirigir cualquier
    // pantalla a /pagos (ver permission-guard.ts en Angular) -- se calcula
    // aca, una sola vez al cargar el perfil, reusando la MISMA logica que
    // ya usa GET /api/billing/subscriptions/:tenantId (no reimplementar).
    // null para superadmin o para un usuario sin empresa asignada -- a
    // ninguno de los dos se lo bloquea nunca por esto.
    //
    // Fase 17 -- bug real: 'none' (empresa CON tenant pero SIN suscripcion
    // armada todavia, ni siquiera un trial -- ej. un usuario creado a mano
    // sin asignarle plan) quedaba indistinguible de null (superadmin/sin
    // empresa) -- permission-guard.ts no tenia forma de mandarlo a /pagos,
    // y terminaba en un /acceso-denegado incomprensible en la primera
    // pantalla que probara.
    let subscriptionStatus = null;
    if (!req.appUser.isSuperadmin && req.appUser.tenantId != null) {
      try {
        const subscription = await billingRepository.getSubscriptionByTenant(req.appUser.tenantId, db);
        if (subscription) {
          subscriptionStatus = resolveEffectiveStatus({
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            gracePeriodDays: subscription.grace_period_days,
            defaultGraceDays: DEFAULT_GRACE_DAYS
          });
        } else {
          subscriptionStatus = 'none';
        }
      } catch (err) {
        console.error('ERROR resolviendo subscriptionStatus en /me:', err);
      }
    }

    res.json({
      id: req.appUser.id,
      email: req.appUser.email,
      tenantId: req.appUser.tenantId,
      roleId: req.appUser.roleId,
      isSuperadmin: req.appUser.isSuperadmin,
      permissions: Array.from(req.appUser.permissions),
      subscriptionStatus
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

      let created;
      try {
        created = await appUserRepository.createInvitedUser(
          { email, tenantId: isSuperadminRequested ? null : tenantId, isSuperadmin: isSuperadminRequested, roleId, permissions },
          db
        );
      } catch (err) {
        if (err.code === 'EMAIL_TAKEN') {
          return res.status(409).json({ error: err.message });
        }
        throw err;
      }

      res.json({ ok: true, id: created.id, resetLink: created.resetLink });
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
