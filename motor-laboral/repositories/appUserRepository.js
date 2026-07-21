async function findByFirebaseUid(firebaseUid, db) {
  const [[user]] = await db.query(
    `SELECT id, firebase_uid, email, tenant_id, is_superadmin, is_active
     FROM app_users
     WHERE firebase_uid = ?`,
    [firebaseUid]
  );
  if (!user) return null;

  const [permRows] = await db.query(
    `SELECT permission FROM user_permissions WHERE user_id = ?`,
    [user.id]
  );

  return {
    id: user.id,
    firebaseUid: user.firebase_uid,
    email: user.email,
    tenantId: user.tenant_id,
    isSuperadmin: Boolean(user.is_superadmin),
    isActive: Boolean(user.is_active),
    permissions: new Set(permRows.map(r => r.permission))
  };
}

async function listByTenant(tenantId, db) {
  const [rows] = await db.query(
    `SELECT id, firebase_uid, email, tenant_id, is_superadmin, is_active, created_at
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

module.exports = {
  findByFirebaseUid,
  listByTenant,
  setPermissions
};
