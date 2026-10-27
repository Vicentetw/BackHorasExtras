const express = require('express');
// API modular de firebase-admin (la 'getAuth()' vieja no existe desde la v14).

const { initializeApp, getApps, cert } = require('firebase-admin/app');

const { getAuth } = require('firebase-admin/auth');
const { initFirebaseAdmin } = require('../firebaseAuth');
const { resolveTenantId, requireSuperadmin, requirePermission } = require('../appUserMiddleware');
const appUserRepository = require('../motor-laboral/repositories/appUserRepository');
const { modulosDe } = require('../motor-laboral/services/modulos');
const { controlarUltimoAdministrador, puedeAdministrar } = require('../motor-laboral/services/administradoresDeEmpresa');
const permisos = require('../motor-laboral/services/permisos');
const billingRepository = require('../motor-laboral/repositories/billingRepository');
const { resolveEffectiveStatus, DEFAULT_GRACE_DAYS } = require('../motor-laboral/services/billingCalculations');

// Panel de administracion de usuarios de la app (no confundir con los
// "empleados" de RRHH -- estos son las cuentas que pueden ENTRAR al
// sistema). Un usuario normal solo administra los de su propia empresa;
// el superadmin puede ademas elegir tenant y otorgar superadmin.

module.exports = function (db) {
  const router = express.Router();

  // "Nadie da lo que no tiene" (2026-10-26, punto S). Antes, alguien con
  // permiso de crear usuarios podía crear OTRA cuenta (por ejemplo con un
  // segundo mail suyo) con más permisos que los propios, incluido el rol de
  // administrador. Ahora:
  //   - el rol y los permisos sueltos que se dan tienen que estar entre los
  //     de quien los da;
  //   - una cuenta con permisos que uno no tiene (más "poderosa") no se puede
  //     editar, desactivar ni borrar: la maneja alguien que los tenga.
  // El superadmin queda afuera (administra la plataforma); en modo soporte
  // tiene todos los de la empresa, así que tampoco lo frena.
  // Devuelve el mensaje de error o null.
  async function controlarQueOtorga(req, { roleId, roleIdAnterior, extras, extrasAnteriores, tenantId }) {
    const nuevos = (extras || []).filter((p) => !(extrasAnteriores || []).includes(p));
    const raros = permisos.desconocidos(nuevos);
    if (raros.length) return { status: 400, error: `Permisos que no existen: ${raros.join(', ')}` };
    let delRol = [];
    if (roleId != null && Number(roleId) !== Number(roleIdAnterior ?? NaN)) {
      const rol = await permisos.rolUsable(db, roleId, tenantId);
      if (!rol) return { status: 400, error: 'Ese rol no existe o es de otra empresa.' };
      if (!Number(rol.ofrecido)) return { status: 400, error: `El rol "${rol.name}" ya no se ofrece. Elegí uno de la lista.` };
      delRol = await permisos.permisosDeRol(db, roleId);
    }
    const falta = permisos.queNoTiene(req.appUser, [...nuevos, ...delRol]);
    if (falta.length) {
      return { status: 403, error: `No podés dar permisos que vos no tenés: ${permisos.enPalabras(falta)}. Pedíselo a un administrador.` };
    }
    return null;
  }

  // Áreas que ve una cuenta (2026-10-26, punto Q; ver alcance.js). Lista
  // vacía = toda la empresa. Sin la migración 20261025 no se pueden elegir.
  async function areasDe(userId) {
    try {
      const [f] = await db.query('SELECT area_id FROM app_user_areas WHERE user_id = ? ORDER BY area_id', [userId]);
      return f.map((x) => Number(x.area_id));
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return [];
      throw err;
    }
  }
  // Valida y guarda. Devuelve { status, error } o null.
  async function guardarAreas(userId, tenantId, areas) {
    const ids = [...new Set((areas || []).map(Number))];
    if (ids.some((x) => !Number.isInteger(x))) return { status: 400, error: 'Áreas inválidas.' };
    try {
      if (ids.length) {
        const [ok] = await db.query('SELECT id FROM areas WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]);
        if (ok.length !== ids.length) return { status: 400, error: 'Alguna de esas áreas no es de la empresa.' };
      }
      await db.query('DELETE FROM app_user_areas WHERE user_id = ?', [userId]);
      if (ids.length) await db.query('INSERT INTO app_user_areas (user_id, area_id) VALUES ?', [ids.map((a) => [userId, a])]);
      return null;
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        return ids.length ? { status: 409, error: 'Todavía no se puede limitar por áreas: falta una actualización del sistema.' } : null;
      }
      throw err;
    }
  }

  async function controlarQuePuedeManejar(req, userId) {
    if (!req.appUser || req.appUser.isSuperadmin) return null;
    const falta = permisos.queNoTiene(req.appUser, [...(await permisos.permisosDeCuenta(db, userId))]);
    if (!falta.length) return null;
    return 'Esta cuenta tiene permisos que vos no tenés, así que solo la puede cambiar un administrador.';
  }

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
      // (+ "Horas extra: Editar" deducido si falta la migración 20261024, ver permisos.js)
      permissions: await permisos.paraLaPantalla(db, req.appUser.permissions),
      // Portal del empleado: el frontend muestra SOLO "Mi asistencia".
      employeeId: req.appUser.employeeId ?? null,
      // Modulos que el superadmin le habilito a la empresa (ver modulos.js).
      modulos: req.appUser.tenantId != null ? await modulosDe(db, req.appUser.tenantId).catch(() => ({})) : {},
      // Soporte: no se lo manda a /pagos aunque la empresa esté vencida (es el operador).
      subscriptionStatus: req.appUser.soporte ? null : subscriptionStatus,
      // Superadmin trabajando en una empresa (cabecera X-Empresa-Trabajo):
      // con esto el frontend muestra el aviso "Estás trabajando en X como
      // soporte" y sigue mostrando el menú de plataforma (Empresas, etc.).
      soporte: req.appUser.soporte ? { empresaId: req.appUser.soporte.empresaId, empresaNombre: req.appUser.soporte.empresaNombre } : null,
      superadminReal: req.appUser.isSuperadmin || !!req.appUser.soporte,
      // Usuario limitado a algunas áreas (2026-10-26): cuáles. null = toda la empresa.
      areas: req.appUser.areas && req.appUser.areas.length
        ? (await db.query('SELECT id, nombre FROM areas WHERE id IN (?) ORDER BY nombre', [req.appUser.areas]))[0]
        : null,
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
        // + employee_id: marcar las cuentas del portal (sin la migración 20261010, NULL).
        const [rows] = await db.query(
          `SELECT u.id, u.firebase_uid, u.email, u.tenant_id, u.role_id, u.is_superadmin, u.is_active, u.created_at,
                  u.employee_id, e.employee_id AS employee_legajo, e.nombre AS employee_nombre
           FROM app_users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.tenant_id, u.email`
        ).catch((err) => {
          if (err.code === 'ER_BAD_FIELD_ERROR') {
            return db.query(`SELECT id, firebase_uid, email, tenant_id, role_id, is_superadmin, is_active, created_at FROM app_users ORDER BY tenant_id, email`);
          }
          throw err;
        });
        return res.json({ users: rows });
      }
      const rows = await appUserRepository.listByTenant(effectiveTenantId, db);
      const withPermissions = await Promise.all(rows.map(async (u) => {
        const [permRows] = await db.query('SELECT permission FROM user_permissions WHERE user_id = ?', [u.id]);
        return { ...u, permissions: permRows.map((p) => p.permission), areas: await areasDe(u.id) };
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

      const noOtorga = await controlarQueOtorga(req, { roleId, extras: Array.isArray(permissions) ? permissions : [], tenantId });
      if (noOtorga) return res.status(noOtorga.status).json({ error: noOtorga.error });
      if (Array.isArray(req.body.areas) && req.body.areas.length && !isSuperadminRequested
          && await puedeAdministrar(db, { roleId, permisos: Array.isArray(permissions) ? permissions : [] })) {
        return res.status(400).json({ error: 'Quien administra usuarios ve toda la empresa: no se lo puede limitar a áreas.' });
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

      if (Array.isArray(req.body.areas) && req.body.areas.length && !isSuperadminRequested) {
        const mal = await guardarAreas(created.id, tenantId, req.body.areas);
        if (mal) return res.status(mal.status).json({ error: `La cuenta se creó, pero sin limitarla a áreas: ${mal.error}`, id: created.id, resetLink: created.resetLink });
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
      const { permissions, isActive, tenant_id: bodyTenantId, isSuperadmin, roleId, areas } = req.body;

      const [[user]] = await db.query('SELECT id, tenant_id FROM app_users WHERE id = ?', [id]);
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && user.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // Cuenta del PORTAL DEL EMPLEADO: solo ve su propia asistencia (lista
      // blanca en appUserMiddleware.js). Un rol, permisos o superadmin no le
      // harían nada: antes se guardaban igual y la pantalla parecía decir que
      // sí (caso real 2026-10-09). Ahora se rechaza con la explicación. Sí se
      // puede activar/desactivar y vaciarle permisos viejos.
      const esCuentaDeEmpleado = (await appUserRepository.employeeIdDe(id, db)) != null;
      if (esCuentaDeEmpleado && ((Array.isArray(permissions) && permissions.length > 0) || (roleId !== undefined && roleId !== null) || isSuperadmin)) {
        return res.status(400).json({
          error: 'Esta cuenta es del portal del empleado: solo ve su propia asistencia y no puede tener rol ni permisos. Para darle acceso de gestión, invitá otra cuenta con otro email.'
        });
      }

      // Nadie puede quedar afuera por un clic (2026-10-09): ni cambiarse a sí
      // mismo rol/permisos/superadmin o desactivarse, ni dejar a la empresa
      // sin administrador. Se compara con lo que YA tiene: guardar el propio
      // usuario sin cambios sigue andando.
      const [[actual]] = await db.query('SELECT id, tenant_id, role_id, is_active, is_superadmin FROM app_users WHERE id = ?', [id]);
      const [permRows] = await db.query('SELECT permission FROM user_permissions WHERE user_id = ?', [id]);
      const permisosActuales = new Set(permRows.map((p) => p.permission));
      const cambiaRol = roleId !== undefined && (roleId == null ? null : Number(roleId)) !== (actual.role_id == null ? null : Number(actual.role_id));
      const cambiaPermisos = Array.isArray(permissions)
        && (permissions.length !== permisosActuales.size || permissions.some((p) => !permisosActuales.has(p)));
      const seDesactiva = isActive !== undefined && !isActive;
      const cambiaSuper = isSuperadmin !== undefined && !!isSuperadmin !== !!Number(actual.is_superadmin);
      if (req.appUser && Number(req.appUser.id) === Number(id) && (cambiaRol || cambiaPermisos || seDesactiva || cambiaSuper)) {
        return res.status(400).json({ error: 'No podés cambiar tu propio rol ni tus permisos, ni desactivar tu propia cuenta. Pedíselo a otro administrador.' });
      }
      const cambiaActiva = isActive !== undefined && !!isActive !== !!Number(actual.is_active);
      const areasAntes = await areasDe(id);
      const cambiaAreas = Array.isArray(areas)
        && JSON.stringify([...new Set(areas.map(Number))].sort((a, b) => a - b)) !== JSON.stringify(areasAntes);
      if (cambiaAreas && esCuentaDeEmpleado) {
        return res.status(400).json({ error: 'Una cuenta del portal del empleado no se limita por áreas: ya ve solo lo suyo.' });
      }
      // Sacarse el límite de áreas a uno mismo sería verse más gente.
      if (cambiaAreas && req.appUser && Number(req.appUser.id) === Number(id)) {
        return res.status(400).json({ error: 'No podés cambiar tus propias áreas. Pedíselo a otro administrador.' });
      }
      // Quien administra usuarios ve toda la empresa: limitado a áreas no
      // podría entrar a Usuarios y la empresa podría quedarse sin nadie que
      // administre (alcance.js cierra esa pantalla a los limitados).
      if (Array.isArray(areas) && areas.length && await puedeAdministrar(db, {
        roleId: roleId !== undefined ? roleId : actual.role_id,
        permisos: Array.isArray(permissions) ? permissions : [...permisosActuales],
      })) {
        return res.status(400).json({ error: 'Quien administra usuarios ve toda la empresa: no se lo puede limitar a áreas. Sacale "Usuarios y roles: Editar" o dejalo sin áreas.' });
      }
      if (cambiaRol || cambiaPermisos || cambiaActiva || cambiaAreas) {
        const masPoderosa = await controlarQuePuedeManejar(req, id);
        if (masPoderosa) return res.status(403).json({ error: masPoderosa });
        const noOtorga = await controlarQueOtorga(req, {
          roleId: cambiaRol ? roleId : null, roleIdAnterior: actual.role_id,
          extras: cambiaPermisos ? permissions : [], extrasAnteriores: [...permisosActuales],
          tenantId: actual.tenant_id,
        });
        if (noOtorga) return res.status(noOtorga.status).json({ error: noOtorga.error });
      }
      if (!(req.appUser && req.appUser.isSuperadmin) && (cambiaRol || cambiaPermisos || seDesactiva)) {
        const aviso = await controlarUltimoAdministrador(db, actual, {
          activa: seDesactiva ? false : undefined,
          roleId: cambiaRol ? (roleId == null ? null : Number(roleId)) : undefined,
          permisos: cambiaPermisos ? permissions : undefined,
        });
        if (aviso) return res.status(409).json({ error: aviso });
      }

      if (cambiaAreas) {
        const mal = await guardarAreas(id, actual.tenant_id, areas);
        if (mal) return res.status(mal.status).json({ error: mal.error });
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
    ['marker_corrections', 'created_by', 'marcadores corregidos'],
    ['marker_corrections', 'updated_by', 'correcciones de marcadores editadas'],
    ['marker_correction_log', 'performed_by', 'movimientos de correcciones de marcadores'],
    ['event_type_quotas', 'created_by', 'cupos de motivos configurados'],
    ['overtime_regime_policies', 'created_by', 'reglas de horas extra configuradas'],
    ['employee_overtime_authorizations', 'created_by', 'autorizaciones de horas extra'],
    ['overtime_excess_approvals', 'created_by', 'excedentes de horas extra aprobados'],
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

      // Borrarse o desactivarse a uno mismo deja sin sesión para arreglarlo
      // (antes solo se impedía el borrado; desactivarse se podía).
      if (req.appUser && Number(req.appUser.id) === Number(user.id)) {
        return res.status(400).json({ error: permanente ? 'No podés eliminar tu propia cuenta' : 'No podés desactivar tu propia cuenta. Pedíselo a otro administrador.' });
      }
      const masPoderosa = await controlarQuePuedeManejar(req, id);
      if (masPoderosa) return res.status(403).json({ error: masPoderosa });
      // Ni dejar a la empresa sin administrador (salvo el superadmin: soporte).
      if (!(req.appUser && req.appUser.isSuperadmin)) {
        const [[cuenta]] = await db.query('SELECT id, tenant_id, role_id FROM app_users WHERE id = ?', [id]);
        const aviso = await controlarUltimoAdministrador(db, cuenta, permanente ? { eliminar: true } : { activa: false });
        if (aviso) return res.status(409).json({ error: aviso });
      }

      if (!permanente) {
        await db.query('UPDATE app_users SET is_active = 0 WHERE id = ?', [id]);
        return res.json({ ok: true, accion: 'deshabilitado' });
      }

      // --- Borrado real, de aca en adelante ---
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
        await getAuth().deleteUser(user.firebase_uid);
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
