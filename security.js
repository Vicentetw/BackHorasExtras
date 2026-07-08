const helmet = require('helmet');

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

function securityMiddlewares(app, cors) {
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOptionsDelegate, optionsSuccessStatus: 200 }));
  app.use(authMiddleware);
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
  apiKeyWarning
};
