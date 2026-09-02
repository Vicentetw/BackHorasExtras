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
  findByFirebaseUid,
  listByTenant,
  setPermissions,
  setRole
};
