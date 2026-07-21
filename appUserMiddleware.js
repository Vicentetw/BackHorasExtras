const db = require('./db');
const appUserRepository = require('./motor-laboral/repositories/appUserRepository');

// Modulos y acciones disponibles (documentacion, no una lista cerrada en
// codigo -- un permiso es simplemente el string "modulo:accion"):
//   modulos: employees, attendance, schedules, leaves, exclusions,
//            holidays, matching, settings
//   acciones: read, create, update, delete

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
    req.appUser = appUser;
    return next();
  } catch (err) {
    console.error('appUserMiddleware error:', err);
    return res.status(500).json({ error: 'Error resolviendo permisos del usuario' });
  }
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

module.exports = {
  appUserMiddleware,
  requirePermission,
  tenantFilter,
  resolveTenantId
};
