// "Una empresa siempre tiene que tener al menos un administrador" (2026-10-09,
// aprobado por el dueño). Administrador = cuenta ACTIVA de gestión (no del
// portal del empleado, no superadmin) que puede administrar usuarios
// (permiso users:update, por su rol o por un permiso suelto).
//
// Antes, un administrador podía desactivarse o quitarse el rol a sí mismo, o
// alguien podía desactivar/bajar de rol al último: la empresa quedaba sin
// nadie que pudiera invitar ni cambiar permisos, y solo el superadmin lo
// podía arreglar a mano.
//
// El superadmin queda afuera de la regla del ÚLTIMO administrador (resuelve
// casos de soporte: el administrador se fue y hay que pasarle el control a
// otro). La regla de la PROPIA cuenta vale para todos.

const PERMISO_ADMIN = 'users:update';

// Permisos que daría a una cuenta su rol + sus permisos sueltos.
async function puedeAdministrar(db, { roleId, permisos }) {
  if ((permisos || []).includes(PERMISO_ADMIN)) return true;
  if (!roleId) return false;
  const [[r]] = await db.query('SELECT 1 AS si FROM role_permissions WHERE role_id = ? AND permission = ?', [roleId, PERMISO_ADMIN]);
  return !!r;
}

// Ids de las cuentas que hoy administran usuarios en la empresa.
async function administradoresActivos(db, tenantId) {
  const sql = (conEmpleado) => `
    SELECT u.id FROM app_users u
    WHERE u.tenant_id = ? AND u.is_active = 1 AND u.is_superadmin = 0 ${conEmpleado ? 'AND u.employee_id IS NULL' : ''}
      AND (EXISTS (SELECT 1 FROM user_permissions p WHERE p.user_id = u.id AND p.permission = ?)
        OR EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = u.role_id AND rp.permission = ?))`;
  const [filas] = await db.query(sql(true), [tenantId, PERMISO_ADMIN, PERMISO_ADMIN]).catch((err) => {
    if (err.code === 'ER_BAD_FIELD_ERROR') return db.query(sql(false), [tenantId, PERMISO_ADMIN, PERMISO_ADMIN]);
    throw err;
  });
  return filas.map((f) => Number(f.id));
}

/**
 * ¿Este cambio deja a la empresa sin administrador?
 * @param cambio { activa?: boolean, roleId?: number|null, permisos?: string[], eliminar?: boolean }
 *   (lo que no venga, queda como está)
 * @returns mensaje para mostrar, o null si el cambio está bien.
 */
async function controlarUltimoAdministrador(db, cuenta, cambio) {
  if (cuenta.tenant_id == null) return null;
  const admins = await administradoresActivos(db, cuenta.tenant_id);
  if (!admins.includes(Number(cuenta.id))) return null; // no es administrador: no cambia nada
  if (admins.length > 1) return null; // hay otro
  let sigue = !cambio.eliminar && cambio.activa !== false;
  if (sigue && (cambio.roleId !== undefined || cambio.permisos !== undefined)) {
    const [permisosActuales] = await db.query('SELECT permission FROM user_permissions WHERE user_id = ?', [cuenta.id]);
    sigue = await puedeAdministrar(db, {
      roleId: cambio.roleId !== undefined ? cambio.roleId : cuenta.role_id,
      permisos: cambio.permisos !== undefined ? cambio.permisos : permisosActuales.map((p) => p.permission),
    });
  }
  if (sigue) return null;
  return 'Es el último administrador de la empresa: si se le quita, nadie va a poder invitar usuarios ni cambiar permisos. Primero dale el rol de administrador a otra persona.';
}

module.exports = { controlarUltimoAdministrador, administradoresActivos, puedeAdministrar, PERMISO_ADMIN };
