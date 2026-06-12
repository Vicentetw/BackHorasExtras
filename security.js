const helmet = require('helmet');

const API_KEY = process.env.API_KEY || null;
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : ['http://localhost:3000'];

function isLocalHostOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function authMiddleware(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = tokenFromHeader || req.headers['x-api-key'];

  if (!token || token !== API_KEY) {
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
