const express = require('express');
const admin = require('firebase-admin');
const { initFirebaseAdmin } = require('../firebaseAuth');
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
  // 3.5 ¿SE PUEDE BORRAR DE VERDAD?
  // ==========================
  //
  // Desde la auditoria de cargas manuales (migracion 20260927), varias
  // tablas guardan QUIEN hizo cada cosa con una foreign key contra
  // app_users. Eso es deliberado: si se pudiera borrar la cuenta, se
  // borraria el rastro de quien cargo esas horas extra o esa licencia, que
  // es justo lo que permite responder un reclamo.
  //
  // Asi que el borrado real solo corresponde a una cuenta SIN historial --
  // tipicamente una que se creo por error, o la que deja un test que se
  // corto a la mitad. Si tiene historial, lo correcto es deshabilitarla.
  //
  // OJO con dos columnas que NO son referencias a app_users aunque se
  // llamen parecido: manual_entry_log.user_id y user_exclusion_log.user_id
  // son USERID de RELOJ (users.USERID), no cuentas de la app. Por eso la
  // lista de abajo es explicita en vez de salir de information_schema.
  const REFERENCIAS_DE_HISTORIAL = [
    ['Checkins', 'created_by', 'fichajes manuales cargados'],
    ['ManualEntries', 'created_by', 'horas extra u horas manuales cargadas'],
    ['ManualEntries', 'updated_by', 'horas manuales editadas'],
    ['userexclusions', 'created_by', 'licencias o justificaciones cargadas'],
    ['userexclusions', 'updated_by', 'licencias editadas'],
    ['manual_checkin_log', 'performed_by', 'movimientos de fichajes manuales'],
    ['manual_entry_log', 'performed_by', 'movimientos de horas manuales'],
    ['user_exclusion_log', 'performed_by', 'movimientos de licencias'],
    ['payment_records', 'recorded_by', 'pagos registrados'],
    ['plan_requests', 'requested_by', 'pedidos de plan'],
    ['tenant_agent_keys', 'created_by', 'claves de agente creadas'],
    ['event_type_count_modes', 'created_by', 'configuraciones de tipos de evento']
  ];

  async function historialDelUsuario(appUserId) {
    const motivos = [];
    for (const [tabla, columna, descripcion] of REFERENCIAS_DE_HISTORIAL) {
      const [[fila]] = await db.query(
        `SELECT COUNT(*) AS n FROM \`${tabla}\` WHERE \`${columna}\` = ?`,
        [appUserId]
      );
      if (fila.n > 0) motivos.push({ descripcion, cantidad: fila.n });
    }
    return motivos;
  }

  // Devuelve si la cuenta se puede borrar y, si no, por que. La pantalla lo
  // usa para mostrar "Eliminar" o "Deshabilitar" sin hacer que el usuario
  // descubra el impedimento recien al apretar el boton.
  router.get('/:id/eliminable', requirePermission('users', 'delete'), async (req, res) => {
    try {
      const [[user]] = await db.query('SELECT id, tenant_id FROM app_users WHERE id = ?', [req.params.id]);
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && user.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const motivos = await historialDelUsuario(user.id);
      res.json({ eliminable: motivos.length === 0, motivos });
    } catch (err) {
      console.error('ERROR consultando si el usuario es eliminable:', err);
      res.status(500).json({ error: 'Error al consultar el usuario' });
    }
  });

  // ==========================
  // 4. DESHABILITAR (soft-delete: is_active = 0, no se borra la cuenta)
  //    o BORRAR DE VERDAD con ?permanente=1, si no tiene historial.
  // ==========================
  router.delete('/:id', requirePermission('users', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const [[user]] = await db.query(
        'SELECT id, tenant_id, email, firebase_uid, is_superadmin FROM app_users WHERE id = ?', [id]);
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && user.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const permanente = req.query.permanente === '1' || req.query.permanente === 'true';
      if (!permanente) {
        await db.query('UPDATE app_users SET is_active = 0 WHERE id = ?', [id]);
        return res.json({ ok: true, accion: 'deshabilitado' });
      }

      // --- Borrado real, de aca en adelante ---

      // Borrarse a uno mismo deja al sistema sin quien lo administre y sin
      // sesion para arreglarlo.
      if (req.appUser && Number(req.appUser.id) === Number(user.id)) {
        return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
      }
      // Una cuenta con acceso a TODAS las empresas solo la puede borrar
      // alguien que tambien lo tenga.
      if (Number(user.is_superadmin) === 1 && !(req.appUser && req.appUser.isSuperadmin)) {
        return res.status(403).json({ error: 'Solo un superadmin puede eliminar a otro superadmin' });
      }

      const motivos = await historialDelUsuario(user.id);
      if (motivos.length > 0) {
        return res.status(409).json({
          error: 'Esta cuenta tiene actividad registrada a su nombre, así que no se puede eliminar. Deshabilitala en su lugar.',
          motivos
        });
      }

      // Los permisos son del propio usuario, no historial: se van con el.
      await db.query('DELETE FROM user_permissions WHERE user_id = ?', [id]);
      await db.query('DELETE FROM app_users WHERE id = ?', [id]);

      // Tambien la cuenta de Firebase: si queda, ese email sigue ocupado y
      // no se lo puede volver a dar de alta.
      let firebaseBorrado = false;
      try {
        initFirebaseAdmin();
        await admin.auth().deleteUser(user.firebase_uid);
        firebaseBorrado = true;
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          firebaseBorrado = true; // ya no estaba: mismo resultado
        } else {
          // La fila ya se borro y eso es lo que ve la pantalla. Se avisa,
          // pero no se responde error: revertir seria peor.
          console.error('Usuario eliminado de la base, pero no de Firebase:', err.message);
        }
      }

      console.log(`[USUARIOS] ${user.email} eliminado definitivamente por app_user ${req.appUser ? req.appUser.id : '?'}`);
      res.json({ ok: true, accion: 'eliminado', firebaseBorrado });
    } catch (err) {
      console.error('ERROR deactivating app user:', err);
      res.status(500).json({ error: 'Error al deshabilitar usuario' });
    }
  });

  return router;
};
