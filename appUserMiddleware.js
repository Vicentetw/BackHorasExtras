const db = require('./db');
const appUserRepository = require('./motor-laboral/repositories/appUserRepository');
const billingRepository = require('./motor-laboral/repositories/billingRepository');
const { resolveEffectiveStatus, isWriteBlocked, isFullyBlocked, DEFAULT_GRACE_DAYS } = require('./motor-laboral/services/billingCalculations');

// Modulos y acciones disponibles (documentacion, no una lista cerrada en
// codigo -- un permiso es simplemente el string "modulo:accion"):
//   modulos: employees, attendance, schedules, leaves, exclusions,
//            holidays, matching, settings, users
//   acciones: read, create, update, delete
// ('users' ya se usaba de verdad en routes/appUsers.js -- faltaba en esta
// lista, corregido al armar routes/roles.js).

// Corre DESPUES de firebaseAuthMiddleware (necesita req.user ya resuelto).
// Un login de Firebase valido NO alcanza por si solo: ademas hace falta un
// registro en app_users (lo da de alta un admin o el superadmin), sino la
// cuenta esta "logueada" pero no habilitada para usar el sistema.
async function appUserMiddleware(req, res, next) {
  if (!req.user || !req.user.uid) {
    // Sin firebaseAuthMiddleware activo (ej. Firebase Admin no configurado
    // en local) no hay como resolver el usuario de la app -- se deja pasar
    // igual que hace firebaseAuthMiddleware en ese caso, para no romper
    // el desarrollo local sin credenciales.
    return next();
  }

  try {
    const appUser = await appUserRepository.findByFirebaseUid(req.user.uid, db);
    if (!appUser || !appUser.isActive) {
      return res.status(403).json({ error: 'Usuario no habilitado en el sistema' });
    }

    // Fase 9 (venta): corte manual de acceso -- a diferencia de 'readonly'
    // (automatico, solo bloquea alta de fichajes/empleados, ver
    // requireActiveSubscription mas abajo), 'canceled' lo pone a mano un
    // superadmin cuando la empresa dejo de pagar del todo, y bloquea
    // CUALQUIER ruta para esa empresa, no solo las de alta. Superadmin
    // nunca se bloquea (es el operador de la plataforma). Fail-open si
    // falla la consulta -- no se corta a nadie por un error nuestro.
    if (!appUser.isSuperadmin && appUser.tenantId != null) {
      try {
        const subscription = await billingRepository.getSubscriptionByTenant(appUser.tenantId, db);
        if (subscription) {
          const effectiveStatus = resolveEffectiveStatus({
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            gracePeriodDays: subscription.grace_period_days,
            defaultGraceDays: DEFAULT_GRACE_DAYS
          });
          if (isFullyBlocked(effectiveStatus)) {
            return res.status(403).json({
              error: subscription.grace_message || 'El acceso de tu empresa fue suspendido. Contactá a soporte para regularizar la situación.',
              effectiveStatus
            });
          }
        }
      } catch (billingErr) {
        console.error('appUserMiddleware billing check error:', billingErr);
      }
    }

    req.appUser = appUser;
    return next();
  } catch (err) {
    console.error('appUserMiddleware error:', err);
    return res.status(500).json({ error: 'Error resolviendo permisos del usuario' });
  }
}

// Exige superadmin (crear/listar empresas, ver todos los tenants -- un
// usuario normal ya tiene su tenant fijo, no necesita esto).
function requireSuperadmin(req, res, next) {
  if (!req.appUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.appUser.isSuperadmin) {
    return res.status(403).json({ error: 'Requiere superadmin' });
  }
  return next();
}

// Exige un permiso puntual ("employees:read", "leaves:approve", etc.).
// El superadmin salta cualquier chequeo de permiso.
function requirePermission(moduleName, action) {
  const permission = `${moduleName}:${action}`;
  return (req, res, next) => {
    if (!req.appUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.appUser.isSuperadmin || req.appUser.permissions.has(permission)) {
      return next();
    }
    return res.status(403).json({ error: `Falta el permiso "${permission}"` });
  };
}

// Fragmento de WHERE para filtrar por tenant. El superadmin no filtra
// (ve todas las empresas). Uso: `AND ${tenantFilter(req, 'e.tenant_id').sql}`
// con los params en el mismo orden en el array de la query.
function tenantFilter(req, column = 'tenant_id') {
  if (req.appUser && req.appUser.isSuperadmin) {
    return { sql: '1=1', params: [] };
  }
  const tenantId = req.appUser ? req.appUser.tenantId : null;
  return { sql: `${column} = ?`, params: [tenantId] };
}

// Resuelve el tenantId "efectivo" a usar en un request: un usuario normal
// SIEMPRE queda atado al suyo (req.appUser.tenantId), sin importar lo que
// mande en la query -- solo el superadmin puede pedir explicitamente
// "ver como" una empresa puntual via ?tenantId=. Si no hay req.appUser
// (Firebase Admin no configurado en local), no filtra -- mismo fallback
// permisivo que ya usan appUserMiddleware/firebaseAuthMiddleware para no
// romper el desarrollo local sin credenciales.
function resolveTenantId(req) {
  if (!req.appUser) return null;
  if (req.appUser.isSuperadmin) {
    return req.query.tenantId !== undefined && req.query.tenantId !== ''
      ? Number(req.query.tenantId)
      : null;
  }
  return req.appUser.tenantId;
}

// Fase 9 (venta): bloquea escritura (POST/PUT/DELETE) si a la empresa se le
// vencio el periodo de gracia de pago ('readonly'). Un tenant SIN fila en
// tenant_subscriptions (empresas que ya usaban el sistema antes de que
// existiera este esquema) no se bloquea -- se trata como sin restriccion
// todavia, para no tumbar de golpe a nadie. Superadmin nunca se bloquea
// (es el operador de la plataforma, no un cliente). Fail-open a proposito:
// si falla la consulta de suscripcion, no se bloquea a nadie por un error
// nuestro -- mejor de mas tiempo de gracia que un cliente al dia trabado
// por un bug de este chequeo.
function requireActiveSubscription(req, res, next) {
  if (!req.appUser || req.appUser.isSuperadmin) return next();
  const tenantId = req.appUser.tenantId;
  if (tenantId == null) return next();

  billingRepository.getSubscriptionByTenant(tenantId, db)
    .then((subscription) => {
      if (!subscription) return next();
      const effectiveStatus = resolveEffectiveStatus({
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        gracePeriodDays: subscription.grace_period_days,
        defaultGraceDays: DEFAULT_GRACE_DAYS
      });
      if (isWriteBlocked(effectiveStatus)) {
        return res.status(402).json({
          error: subscription.grace_message || 'Tu suscripción está vencida. Regularizá el pago para poder seguir cargando datos.',
          effectiveStatus
        });
      }
      return next();
    })
    .catch((err) => {
      console.error('requireActiveSubscription error:', err);
      return next();
    });
}

module.exports = {
  appUserMiddleware,
  requirePermission,
  requireSuperadmin,
  requireActiveSubscription,
  tenantFilter,
  resolveTenantId
};
