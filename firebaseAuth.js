const path = require('path');
const admin = require('firebase-admin');

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountJson && !serviceAccountPath) return;

  try {
    const serviceAccount = serviceAccountJson
      ? JSON.parse(serviceAccountJson)
      : require(path.resolve(serviceAccountPath));

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    initialized = true;
    console.log('✅ Firebase Admin initialized for auth validation', {
      projectId: serviceAccount.project_id
    });
  } catch (err) {
    console.error('Firebase Admin initialization error:', err);
  }
}

async function firebaseAuthMiddleware(req, res, next) {
  initFirebaseAdmin();
  if (!initialized) {
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
