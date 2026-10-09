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
  // employee_id (portal del empleado, migracion 20261010). Si la columna
  // todavia no existe (backend publicado antes que la migracion), se lee
  // NULL: nadie es cuenta de empleado, igual que antes.
  const sql = (conEmpleado) => `SELECT id, firebase_uid, email, tenant_id, role_id, is_superadmin, is_active,
            ${conEmpleado ? 'employee_id' : 'NULL AS employee_id'}
     FROM app_users
     WHERE firebase_uid = ?`;
  const [[user]] = await db.query(sql(true), [firebaseUid]).catch((err) => {
    if (err.code === 'ER_BAD_FIELD_ERROR') return db.query(sql(false), [firebaseUid]);
    throw err;
  });
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

  // Cuenta de EMPLEADO: no hereda ningun permiso ni superadmin, aunque la
  // fila los tuviera por error. Lo que puede hacer lo decide la lista blanca
  // de appUserMiddleware.js, no los permisos.
  const employeeId = user.employee_id == null ? null : Number(user.employee_id);
  return {
    id: user.id,
    firebaseUid: user.firebase_uid,
    email: user.email,
    tenantId: user.tenant_id,
    roleId: user.role_id,
    isSuperadmin: employeeId == null && Boolean(user.is_superadmin),
    isActive: Boolean(user.is_active),
    employeeId,
    permissions: employeeId == null ? permissions : new Set()
  };
}

async function listByTenant(tenantId, db) {
  // + de qué empleado es la cuenta (portal), con su legajo y nombre, para que
  // /usuarios la muestre como lo que es (2026-10-09). Sin la migración
  // 20261010, employee_id sale NULL para todas (como antes).
  const sql = (conEmpleado) => `SELECT u.id, u.firebase_uid, u.email, u.tenant_id, u.role_id, u.is_superadmin, u.is_active, u.created_at,
            ${conEmpleado ? 'u.employee_id, e.employee_id AS employee_legajo, e.nombre AS employee_nombre' : 'NULL AS employee_id, NULL AS employee_legajo, NULL AS employee_nombre'}
     FROM app_users u
     ${conEmpleado ? 'LEFT JOIN employees e ON e.id = u.employee_id' : ''}
     WHERE u.tenant_id = ?
     ORDER BY u.email`;
  const [rows] = await db.query(sql(true), [tenantId]).catch((err) => {
    if (err.code === 'ER_BAD_FIELD_ERROR') return db.query(sql(false), [tenantId]);
    throw err;
  });
  return rows;
}

// De qué empleado es una cuenta (null = cuenta de gestión). Tolerante a la migración 20261010.
async function employeeIdDe(appUserId, db) {
  try {
    const [[r]] = await db.query('SELECT employee_id FROM app_users WHERE id = ?', [appUserId]);
    return r && r.employee_id != null ? Number(r.employee_id) : null;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return null;
    throw err;
  }
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
  employeeIdDe,
  setPermissions,
  setRole
};
