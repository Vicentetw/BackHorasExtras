// Helper para tests: consigue un ID token real de Firebase para un usuario
// descartable (no hace falta ninguna cuenta real) y lo da de alta en
// app_users (sino appUserMiddleware lo rechaza con 403 -- un login de
// Firebase valido ya no alcanza por si solo desde el paso 2 del plan
// multi-tenant). Borra todo al terminar (Firebase + app_users).
const path = require('path');
const admin = require('firebase-admin');
const db = require('../db');

const WEB_API_KEY = 'AIzaSyAJ3oBdp9YIjJvMDOOgcybRwAbc3eGcJwI'; // publica (config de Firebase web), no es secreta

function initAdmin() {
  if (admin.apps.length) return;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const serviceAccount = serviceAccountJson
    ? JSON.parse(serviceAccountJson)
    : require(path.resolve(serviceAccountPath));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// Todos los modulo:accion que existen hoy -- se otorgan por default a un
// usuario de prueba no-superadmin, para que los tests que verifican
// aislamiento por TENANT (no de permisos) no se vean afectados por el
// gating de permisos de cada ruta. Pasar { permissions: [...] } explicito
// para probar puntualmente el efecto de un permiso faltante.
const ALL_PERMISSIONS = ['employees', 'attendance', 'schedules', 'leaves', 'exclusions', 'holidays', 'matching', 'users']
  .flatMap((m) => ['read', 'create', 'update', 'delete'].map((a) => `${m}:${a}`));

// Por default el usuario de prueba es superadmin (ve todos los tenants),
// asi los tests existentes (que comparan contra el total de la empresa,
// sin filtrar) siguen valiendo. Pasar { tenantId, isSuperadmin: false }
// para probar especificamente el aislamiento entre empresas -- en ese caso
// se le otorgan TODOS los permisos por default (ver ALL_PERMISSIONS) salvo
// que se pase `permissions` explicito.
async function getTestAuthHeaders(uid, { isSuperadmin = true, tenantId = null, permissions = null } = {}) {
  initAdmin();
  const customToken = await admin.auth().createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );
  const data = await res.json();
  if (!data.idToken) {
    throw new Error('No se pudo obtener el ID token de prueba: ' + JSON.stringify(data));
  }

  const [result] = await db.query(
    `INSERT INTO app_users (firebase_uid, email, tenant_id, is_superadmin, is_active)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), is_superadmin = VALUES(is_superadmin), is_active = 1`,
    [uid, `${uid}@test.local`, tenantId, isSuperadmin ? 1 : 0]
  );

  if (!isSuperadmin) {
    const [[appUser]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [uid]);
    const grantedPermissions = permissions !== null ? permissions : ALL_PERMISSIONS;
    await db.query('DELETE FROM user_permissions WHERE user_id = ?', [appUser.id]);
    if (grantedPermissions.length) {
      await db.query(
        'INSERT INTO user_permissions (user_id, permission) VALUES ?',
        [grantedPermissions.map((p) => [appUser.id, p])]
      );
    }
  }

  const apiKey = process.env.API_KEY;
  return {
    'x-api-key': apiKey,
    Authorization: `Bearer ${data.idToken}`
  };
}

async function deleteTestUser(uid) {
  initAdmin();
  await admin.auth().deleteUser(uid).catch(() => {});
  await db.query('DELETE FROM app_users WHERE firebase_uid = ?', [uid]).catch(() => {});
}

// db.js crea un pool que nunca se cierra solo -- sin esto, node --test se
// queda colgado despues de terminar (el pool mantiene vivo el event loop).
async function closeDb() {
  await db.end().catch(() => {});
}

module.exports = { getTestAuthHeaders, deleteTestUser, closeDb };
