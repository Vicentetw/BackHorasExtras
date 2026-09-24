const path = require('path');
const admin = require('firebase-admin');

let initialized = false;
// true cuando SI hay credenciales configuradas pero no se pudieron cargar
// (JSON mal pegado, clave rotada, archivo que no esta). Es distinto de "no
// hay credenciales": ver el comentario largo en firebaseAuthMiddleware.
let configurado = false;
let fallóLaCarga = false;

function initFirebaseAdmin() {
  if (initialized) return;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  configurado = Boolean(serviceAccountJson || serviceAccountPath);
  if (!configurado) return;

  try {
    const serviceAccount = serviceAccountJson
      ? JSON.parse(serviceAccountJson)
      : require(path.resolve(serviceAccountPath));

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    initialized = true;
    fallóLaCarga = false;
    console.log('✅ Firebase Admin initialized for auth validation', {
      projectId: serviceAccount.project_id
    });
  } catch (err) {
    fallóLaCarga = true;
    console.error('Firebase Admin initialization error:', err);
  }
}

function esProduccion() {
  return process.env.NODE_ENV === 'production';
}

// FAIL CLOSED (hallazgo F-01 de la auditoria de seguridad)
// --------------------------------------------------------
// Antes, si Firebase Admin no llegaba a inicializarse, esto hacia next() y
// TODA la API quedaba sin autenticacion. El escenario no era un ataque: era
// un despliegue con la variable FIREBASE_SERVICE_ACCOUNT mal pegada, o una
// clave de servicio rotada. `initFirebaseAdmin` solo hace console.error y
// sigue, asi que el servidor arrancaba normal, respondiendo 200 a cualquiera,
// y nadie se enteraba.
//
// Lo unico que quedaba protegiendo era el API_KEY, que viaja en el bundle de
// Angular y esta publicado en GitHub -- o sea, nada.
//
// Ahora hay tres casos, y solo uno deja pasar:
//
//   1. Credenciales configuradas que NO cargaron -> 503 siempre, incluso
//      fuera de produccion. Este es el caso peligroso: alguien quiso tener
//      autenticacion y no la tiene. Que se note.
//   2. Sin credenciales, con NODE_ENV=production -> 503. Un servidor
//      productivo sin autenticacion no es un servidor productivo.
//   3. Sin credenciales y fuera de produccion -> pasa, como antes. Es el
//      desarrollo local sin service account, que es un caso legitimo y no
//      se quiere romper.
//
// El 503 y no un 401 a proposito: no es "tus credenciales estan mal", es
// "este servidor no puede verificar credenciales ahora mismo". La diferencia
// importa para diagnosticar, y para que el monitoreo lo tome como caida.
async function firebaseAuthMiddleware(req, res, next) {
  initFirebaseAdmin();
  if (!initialized) {
    if (fallóLaCarga || esProduccion()) {
      console.error('[seguridad] Firebase Admin no esta disponible -- se rechaza el pedido en vez de dejarlo pasar sin autenticar.');
      return res.status(503).json({
        error: 'El servidor no puede verificar la identidad en este momento. Probá de nuevo en unos minutos.'
      });
    }
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!idToken) {
    return res.status(401).json({ error: 'Unauthorized: missing Firebase ID token' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    return next();
  } catch (err) {
    console.error('Firebase auth verifyIdToken failed:', err);
    return res.status(401).json({ error: 'Unauthorized: invalid Firebase ID token' });
  }
}

module.exports = {
  firebaseAuthMiddleware,
  initFirebaseAdmin
};
