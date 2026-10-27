// Permisos: el catálogo, los que se deducen de otros y la regla "nadie da lo
// que no tiene" (2026-10-26, puntos S, P, R y O de
// REVISION_PROFUNDA_2026-10-26.md, sección 8).
//
// Un permiso es el texto "modulo:accion". Cada usuario tiene los de su rol
// más los sueltos (ver appUserRepository.findByFirebaseUid).

const MODULOS = ['employees', 'attendance', 'schedules', 'leaves', 'exclusions', 'holidays', 'matching', 'settings', 'users', 'salidas', 'horas_extra'];
const ACCIONES = ['read', 'create', 'update', 'delete'];
const CATALOGO = new Set(MODULOS.flatMap((m) => ACCIONES.map((a) => `${m}:${a}`)));

// Todos los de una empresa: los que tiene el superadmin cuando trabaja en
// una empresa (modo soporte).
const PERMISOS_DE_EMPRESA = [...CATALOGO];

// ¿Está corrida la migración 20261024_roles_completos? Se reconoce por la
// columna roles.tenant_id. Una vez que está, queda (no se vuelve a mirar);
// mientras no está, se vuelve a mirar cada minuto, así no hace falta
// reiniciar el servidor después de correrla.
let migracionAplicada = false;
let ultimaRevision = 0;
async function rolesCompletosAplicada(db) {
  if (migracionAplicada) return true;
  if (Date.now() - ultimaRevision < 60_000) return false;
  ultimaRevision = Date.now();
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'tenant_id'`
  );
  migracionAplicada = r.n > 0;
  return migracionAplicada;
}

// Permiso que se deduce de otro: "Salidas: Editar" (autorizar salidas) lo
// tiene quien tiene "Presentismo: Editar", que ya podía autorizarlas (el
// servidor acepta cualquiera de los dos).
function sumarDeducidos(permisos) {
  if (permisos.has('attendance:update')) permisos.add('salidas:update');
  return permisos;
}

// "Horas extra: Editar" (punto P). Con la migración corrida, se mira ese
// permiso. Sin la migración, la regla de antes, tal cual, acción por acción
// (accionVieja = la de Presentismo que pedía esa ruta): así nadie gana ni
// pierde nada hasta que se corra. La migración se lo da a quien tenía
// Presentismo: Crear o Editar.
async function puedeHorasExtra(db, quien, accionVieja) {
  if (!quien) return false;
  if (quien.isSuperadmin) return true;
  return (await rolesCompletosAplicada(db))
    ? quien.permissions.has('horas_extra:update')
    : quien.permissions.has(`attendance:${accionVieja}`);
}

// Para la pantalla, antes de la migración: muestra "Horas extra: Editar" a
// quien ya podía hacer algo de eso (el servidor igual controla acción por
// acción con puedeHorasExtra).
async function paraLaPantalla(db, permisos) {
  const lista = new Set(permisos);
  if (!(await rolesCompletosAplicada(db)) && (lista.has('attendance:create') || lista.has('attendance:update'))) {
    lista.add('horas_extra:update');
  }
  return [...lista];
}

// Los que pide y no existen (para rechazar textos inventados).
function desconocidos(permisos) {
  return (permisos || []).filter((p) => !CATALOGO.has(p));
}

// "Nadie da lo que no tiene": de los permisos pedidos, los que quien hace
// el cambio NO tiene. El superadmin (fuera del modo soporte) los tiene todos.
function queNoTiene(quien, permisos) {
  if (!quien || quien.isSuperadmin) return [];
  return [...new Set(permisos || [])].filter((p) => !quien.permissions.has(p));
}

// Permisos efectivos de una cuenta guardada (rol + sueltos + deducidos),
// para compararlos con los de quien la quiere cambiar.
async function permisosDeCuenta(db, userId) {
  const [[u]] = await db.query('SELECT role_id FROM app_users WHERE id = ?', [userId]);
  if (!u) return new Set();
  const [sueltos] = await db.query('SELECT permission FROM user_permissions WHERE user_id = ?', [userId]);
  const permisos = new Set(sueltos.map((r) => r.permission));
  if (u.role_id) {
    const [delRol] = await db.query('SELECT permission FROM role_permissions WHERE role_id = ?', [u.role_id]);
    delRol.forEach((r) => permisos.add(r.permission));
  }
  return sumarDeducidos(permisos);
}

async function permisosDeRol(db, roleId) {
  const [filas] = await db.query('SELECT permission FROM role_permissions WHERE role_id = ?', [roleId]);
  return filas.map((r) => r.permission);
}

// Un rol que esta empresa puede usar: los de la plataforma (tenant_id NULL)
// y los propios. null si no existe o es de otra empresa. Sin la migración,
// todos son de la plataforma (como antes).
async function rolUsable(db, roleId, tenantId) {
  if (!(await rolesCompletosAplicada(db))) {
    const [[r]] = await db.query('SELECT id, name, is_system FROM roles WHERE id = ?', [roleId]);
    return r ? { ...r, tenant_id: null, ofrecido: 1 } : null;
  }
  const [[r]] = await db.query('SELECT id, name, is_system, tenant_id, ofrecido FROM roles WHERE id = ?', [roleId]);
  if (!r) return null;
  if (r.tenant_id != null && Number(r.tenant_id) !== Number(tenantId)) return null;
  return r;
}

// Texto para el mensaje de error, en criollo.
const NOMBRES = {
  employees: 'Empleados', attendance: 'Presentismo y fichajes', schedules: 'Horarios y reglas de cálculo',
  leaves: 'Licencias y vacaciones', exclusions: 'Justificaciones y motivos de ausencia', holidays: 'Feriados',
  matching: 'Vincular reloj con empleados', settings: 'Marcadores y relojes', users: 'Usuarios y roles',
  salidas: 'Autorizar salidas particulares', horas_extra: 'Horas extra y cierre de mes',
};
const ACCION = { read: 'Ver', create: 'Crear', update: 'Editar', delete: 'Eliminar' };
function enPalabras(permisos) {
  return permisos.map((p) => { const [m, a] = p.split(':'); return `${NOMBRES[m] || m}: ${ACCION[a] || a}`; }).join(', ');
}

module.exports = {
  MODULOS, ACCIONES, CATALOGO, PERMISOS_DE_EMPRESA,
  rolesCompletosAplicada, sumarDeducidos, puedeHorasExtra, paraLaPantalla, desconocidos, queNoTiene, permisosDeCuenta, permisosDeRol, rolUsable, enPalabras,
};
