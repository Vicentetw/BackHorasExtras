const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { firebaseAuthMiddleware } = require('./firebaseAuth');
const { appUserMiddleware } = require('./appUserMiddleware');

// Generoso a proposito -- esto es una app interna (asistencia/RRHH), no una
// API publica de alto trafico. El objetivo es frenar un scaneo/ataque de
// fuerza bruta, no molestar el uso normal (un dashboard puede disparar
// varias decenas de requests en paralelo al cargar). 300/min por IP.
const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta de nuevo en un momento.' }
});

const API_KEY = process.env.API_KEY || null;
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];

function isLocalHostOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function authMiddleware(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  // Se chequean por separado: una ruta puede traer además un Authorization Bearer
  // de Firebase (identidad de usuario) que no tiene nada que ver con esta clave de
  // aplicación, y no debe hacer que se ignore el x-api-key.
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const bearerMatchesApiKey = authHeader === `Bearer ${API_KEY}`;

  if (apiKeyHeader !== API_KEY && !bearerMatchesApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function corsOptionsDelegate(req, callback) {
  const origin = req && req.headers && (req.headers.origin || req.headers.Origin);

  if (!origin) {
    return callback(null, { origin: true });
  }

  const isLocalOrigin = isLocalHostOrigin(origin);
  const allowedLocalOrigin = isLocalOrigin && CORS_ORIGINS.some(o => /localhost|127\.0\.0\.1/.test(o));

  if (CORS_ORIGINS.includes(origin) || allowedLocalOrigin) {
    return callback(null, { origin: true });
  }

  return callback(new Error(`CORS policy: Origin not allowed (${origin})`));
}

// Fase 11 (landing publica + alta autoservicio): rutas bajo publicPaths
// (ej. /api/public) siguen pasando por helmet/rate-limit/CORS -- son la
// superficie MAS expuesta del sistema, alcanzable sin ninguna credencial,
// asi que esas protecciones importan mas ahi, no menos -- pero SALTAN las
// 3 capas de identidad (API_KEY, Firebase, app_users), porque por
// definicion las llama alguien que todavia no tiene ninguna cuenta.
// routes/public.js aplica su propio rate-limit mas estricto encima de
// esto para esa ruta puntual.
// Bug real encontrado en Fase 18: un `startsWith` ingenuo hace que
// '/api/agent-keys' (que SI necesita Firebase + superadmin) matchee el
// prefijo publico '/api/agent' (los endpoints del agente de sincronizacion,
// que a proposito no llevan Firebase) -- '/api/agent-keys'.startsWith('/api/agent')
// es true. Se exige que despues del prefijo venga un '/' o que termine ahi
// mismo, para que dos rutas hermanas con el mismo prefijo de texto no se
// pisen (ej. /api/agent vs /api/agent-keys, o /api/public vs /api/publicidad
// si algun dia existiera).
function isPublicPath(req, publicPaths) {
  return publicPaths.some((p) => req.path === p || req.path.startsWith(p + '/'));
}

function securityMiddlewares(app, cors, { publicPaths = [] } = {}) {
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(apiRateLimiter);
  app.use(cors({ origin: corsOptionsDelegate, optionsSuccessStatus: 200 }));
  app.use((req, res, next) => (isPublicPath(req, publicPaths) ? next() : authMiddleware(req, res, next)));
  // El API_KEY de arriba solo filtra bots/escaneos; no identifica usuarios.
  // Esto exige ademas un login real de Firebase en TODAS las rutas (antes
  // solo se exigia en /admin), para que los datos no queden accesibles con
  // solo copiar el API_KEY del codigo fuente del front.
  app.use((req, res, next) => (isPublicPath(req, publicPaths) ? next() : firebaseAuthMiddleware(req, res, next)));
  // Un login de Firebase valido identifica a la persona, pero no dice a que
  // empresa pertenece ni que puede hacer -- eso vive en app_users/
  // user_permissions (paso 2 del plan multi-tenant), resuelto aca y colgado
  // en req.appUser para que cada ruta filtre por tenant y chequee permisos.
  app.use((req, res, next) => (isPublicPath(req, publicPaths) ? next() : appUserMiddleware(req, res, next)));
}

function apiKeyWarning() {
  if (!API_KEY) {
    console.warn('⚠️ API_KEY not set. Requests will not require authorization. Set API_KEY in .env to enable auth.');
  }
}

module.exports = {
  authMiddleware,
  corsOptionsDelegate,
  securityMiddlewares,
  apiKeyWarning,
  isPublicPath
};
