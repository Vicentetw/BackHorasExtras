const admin = require('firebase-admin');
const { initFirebaseAdmin } = require('../../firebaseAuth');

// Secuencia compartida "crear usuario de Firebase (o reusar si ya existe) +
// fila en app_users + generar reset link" -- antes vivia solo dentro de
// routes/appUsers.js POST '/' (alta manual por un admin). Extraida aca para
// que el alta autoservicio (routes/public.js, Fase 11) la reuse tal cual,
// en vez de duplicar la logica de Firebase Admin en dos lugares.
//
// Tira un Error con `.code = 'EMAIL_TAKEN'` si el email ya tiene una cuenta
// habilitada -- el llamador decide que status HTTP le corresponde (409 en
// ambos casos hoy, pero es su decision, no de este repositorio).
async function createInvitedUser({ email, tenantId, isSuperadmin, roleId, permissions }, db) {
  // El alta manual (routes/appUsers.js) siempre llega aca DESPUES de
  // firebaseAuthMiddleware, que ya llama a esto. El alta autoservice
  // (routes/public.js) salta ESE middleware a proposito (es publica, sin
  // Firebase token) -- sin este llamado, admin.auth() explotaria sin
  // inicializar en el primer pedido que le llegue al servidor.
  initFirebaseAdmin();

  let firebaseUser;
  try {
    firebaseUser = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const tempPassword = Math.random().toString(36).slice(-10) + 'A1!';
    firebaseUser = await admin.auth().createUser({ email, password: tempPassword });
  }

  const [existing] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [firebaseUser.uid]);
  if (existing.length > 0) {
    const err = new Error('Ese email ya tiene una cuenta habilitada en el sistema');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }

  const [result] = await db.query(
    `INSERT INTO app_users (firebase_uid, email, tenant_id, is_superadmin, is_active)
     VALUES (?, ?, ?, ?, 1)`,
    [firebaseUser.uid, email, isSuperadmin ? null : tenantId, isSuperadmin ? 1 : 0]
  );

  if (Array.isArray(permissions) && permissions.length) {
    await setPermissions(result.insertId, permissions, db);
  }
  if (roleId) {
    await setRole(result.insertId, roleId, db);
  }

  // Sin infraestructura de mail propia (ver comentario en routes/appUsers.js)
  // -- quien llama a esta funcion es responsable de mostrarle este link a
  // la persona (en pantalla, por WhatsApp, etc.). null si Firebase no pudo
  // generarlo, no se considera un error fatal del alta.
  let resetLink = null;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(email);
  } catch (err) {
    console.warn('No se pudo generar el link de restablecimiento:', err.message);
  }

  return { id: result.insertId, resetLink };
}

async function findByFirebaseUid(firebaseUid, db) {
  const [[user]] = await db.query(
    `SELECT id, firebase_uid, email, tenant_id, role_id, is_superadmin, is_active
     FROM app_users
     WHERE firebase_uid = ?`,
    [firebaseUid]
  );
  if (!user) return null;

  // Permisos efectivos = permisos del rol (si tiene uno asignado) UNION
  // overrides individuales en user_permissions -- un rol es solo un preset
  // con nombre, no reemplaza el mecanismo fino que ya existia. Un usuario
  // con role_id = NULL funciona exactamente como antes de esta migracion.
  const [permRows] = await db.query(
    `SELECT permission FROM user_permissions WHERE user_id = ?`,
    [user.id]
  );
  const permissions = new Set(permRows.map(r => r.permission));

  if (user.role_id) {
    const [rolePermRows] = await db.query(
      `SELECT permission FROM role_permissions WHERE role_id = ?`,
      [user.role_id]
    );
    rolePermRows.forEach(r => permissions.add(r.permission));
  }

  return {
    id: user.id,
    firebaseUid: user.firebase_uid,
    email: user.email,
    tenantId: user.tenant_id,
    roleId: user.role_id,
    isSuperadmin: Boolean(user.is_superadmin),
    isActive: Boolean(user.is_active),
    permissions
  };
}

async function listByTenant(tenantId, db) {
  const [rows] = await db.query(
    `SELECT id, firebase_uid, email, tenant_id, role_id, is_superadmin, is_active, created_at
     FROM app_users
     WHERE tenant_id = ?
     ORDER BY email`,
    [tenantId]
  );
  return rows;
}

async function setPermissions(userId, permissions, db) {
  await db.query(`DELETE FROM user_permissions WHERE user_id = ?`, [userId]);
  if (!permissions.length) return;
  const values = permissions.map(p => [userId, p]);
  await db.query(`INSERT INTO user_permissions (user_id, permission) VALUES ?`, [values]);
}

// roleId puede ser null para volver a "sin rol" (permisos 100% manuales).
async function setRole(userId, roleId, db) {
  await db.query(`UPDATE app_users SET role_id = ? WHERE id = ?`, [roleId, userId]);
}

module.exports = {
  createInvitedUser,
  findByFirebaseUid,
  listByTenant,
  setPermissions,
  setRole
};
