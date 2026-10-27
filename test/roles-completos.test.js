// Roles completos (2026-10-26, puntos S, P, R y O de
// REVISION_PROFUNDA_2026-10-26.md, sección 8). Requiere la migración
// 20261024_roles_completos y el backend local corriendo (puerto 3000).
//   S. Nadie da lo que no tiene, ni cambia una cuenta más poderosa.
//   P. "Horas extra: Editar" separado de Presentismo.
//   R. Roles de sistema nuevos; RRHH y Feriados ya no se ofrecen.
//   O. Roles propios de cada empresa, invisibles para las demás.
// Dos empresas descartables propias (998101 y 998102), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const permisos = require('../motor-laboral/services/permisos');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 998101;
const B = 998102;
const UIDS = ['rc-admin-a', 'rc-admin-b', 'rc-usuarios-a', 'rc-encargado-a', 'rc-liquida-a', 'rc-otro-admin-a'];
let hAdminA; let hAdminB; let hUsuariosA; let hEncargado; let hLiquida;
let rol = {};

const pedir = (h, metodo, ruta, body) => fetch(`${URL}${ruta}`, {
  method: metodo, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const idDe = async (uid) => (await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [uid]))[0][0].id;
const conRol = async (uid, roleId) => db.query('UPDATE app_users SET role_id = ? WHERE firebase_uid = ?', [roleId, uid]);

async function limpiar() {
  await db.query('UPDATE app_users SET role_id = NULL WHERE tenant_id IN (?, ?)', [A, B]);
  await db.query('DELETE FROM roles WHERE tenant_id IN (?, ?)', [A, B]);
  await db.query("DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM app_users WHERE email LIKE 'rc-invitado%')");
  await db.query("DELETE FROM app_users WHERE email LIKE 'rc-invitado%'");
  for (const t of ['overtime_period_adjustments', 'overtime_period_results', 'overtime_period_closings']) await db.query(`DELETE FROM ${t} WHERE tenant_id IN (?, ?)`, [A, B]).catch(() => {});
}

before(async () => {
  for (const [id, n] of [[A, 'Roles A (test)'], [B, 'Roles B (test)']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, n, `roles-completos-${id}`]);
  }
  await limpiar();
  const [roles] = await db.query('SELECT id, name FROM roles WHERE is_system = 1');
  for (const r of roles) rol[r.name] = r.id;
  const todos = permisos.PERMISOS_DE_EMPRESA;
  hAdminA = await getTestAuthHeaders('rc-admin-a', { isSuperadmin: false, tenantId: A, permissions: [] });
  await conRol('rc-admin-a', rol['Administrador de Empresa']);
  await getTestAuthHeaders('rc-otro-admin-a', { isSuperadmin: false, tenantId: A, permissions: [] });
  await conRol('rc-otro-admin-a', rol['Administrador de Empresa']);
  hAdminB = await getTestAuthHeaders('rc-admin-b', { isSuperadmin: false, tenantId: B, permissions: todos });
  // Solo administra usuarios (y ve Presentismo): el caso del punto S.
  hUsuariosA = await getTestAuthHeaders('rc-usuarios-a', { isSuperadmin: false, tenantId: A, permissions: ['users:read', 'users:create', 'users:update', 'users:delete', 'attendance:read'] });
  hEncargado = await getTestAuthHeaders('rc-encargado-a', { isSuperadmin: false, tenantId: A, permissions: [] });
  await conRol('rc-encargado-a', rol['Encargado de presentismo']);
  hLiquida = await getTestAuthHeaders('rc-liquida-a', { isSuperadmin: false, tenantId: A, permissions: [] });
  await conRol('rc-liquida-a', rol['Liquidación de horas extra']);
});

after(async () => {
  await limpiar();
  for (const uid of UIDS) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

// ---------------- R ----------------
test('R: los roles de sistema nuevos existen con sus permisos; RRHH y Feriados ya no se ofrecen', async () => {
  const r = await (await pedir(hAdminA, 'GET', '/api/roles')).json();
  const por = Object.fromEntries(r.roles.map((x) => [x.name, x]));
  assert.ok(r.rolesPropiosDisponibles);
  const enc = por['Encargado de presentismo'].permissions;
  for (const p of ['holidays:create', 'attendance:create', 'exclusions:create', 'leaves:create', 'salidas:update']) assert.ok(enc.includes(p), p);
  for (const p of ['horas_extra:update', 'attendance:update', 'settings:update', 'users:update']) assert.ok(!enc.includes(p), p);
  assert.ok(por['Liquidación de horas extra'].permissions.includes('horas_extra:update'));
  assert.ok(!por['Liquidación de horas extra'].permissions.includes('attendance:create'));
  assert.ok(!por['Supervisor de sector'].permissions.includes('holidays:create'));
  assert.ok(por['Administrador de Empresa'].permissions.includes('horas_extra:update'));
  assert.equal(por['RRHH - Ausencias y Licencias'].ofrecido, false);
  assert.equal(por.Feriados.ofrecido, false);
  assert.equal(por['Encargado de presentismo'].ofrecido, true);
});

test('R: un rol que ya no se ofrece no se puede dar a nadie nuevo', async () => {
  const r = await pedir(hAdminA, 'POST', '/api/app-users', { email: 'rc-invitado-rrhh@example.com', roleId: rol.Feriados });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ya no se ofrece/);
});

// ---------------- P ----------------
test('P: el encargado de presentismo no cierra el mes ni carga horas extra; sí carga horas de licencia', async () => {
  const cierre = await pedir(hEncargado, 'POST', '/api/liquidacion-horas-extra/cierres', { periodo: '2026-01' });
  assert.equal(cierre.status, 403);
  const he = await pedir(hEncargado, 'POST', '/add/manual', { userId: 99810101, startDatetime: '2026-01-05 15:00', endDatetime: '2026-01-05 16:00', durationMinutes: 60, type: 'he' });
  assert.equal(he.status, 403);
  assert.match((await he.json()).error, /Horas extra/);
  const omit = await pedir(hEncargado, 'POST', '/add/manual', { userId: 99810101, startDatetime: '2026-01-05 00:00', endDatetime: '2026-01-05 00:00', durationMinutes: 0, type: 'omit' });
  assert.equal(omit.status, 403);
  // Licencia: pasa el control de permiso (el usuario de reloj no existe, así
  // que lo que sigue lo decide el resto de la ruta, no el permiso).
  const lic = await pedir(hEncargado, 'POST', '/add/manual', { userId: 99810101, startDatetime: '2026-01-05 10:00', endDatetime: '2026-01-05 12:00', durationMinutes: 120, type: 'licencia' });
  assert.notEqual(lic.status, 403);
});

test('P: liquidación cierra el mes; no carga fichajes a mano', async () => {
  const cierre = await pedir(hLiquida, 'POST', '/api/liquidacion-horas-extra/cierres', { periodo: '2026-01' });
  assert.notEqual(cierre.status, 403, await cierre.text());
  const fichaje = await pedir(hLiquida, 'POST', '/api/manual-checkins', { items: [] });
  assert.equal(fichaje.status, 403);
});

test('P: con la migración, "Horas extra: Editar" es un permiso propio; Presentismo: Editar sigue autorizando salidas', async () => {
  const quien = { isSuperadmin: false, permissions: new Set(['attendance:create', 'attendance:update']) };
  assert.equal(await permisos.puedeHorasExtra(db, quien, 'update'), false);
  quien.permissions.add('horas_extra:update');
  assert.equal(await permisos.puedeHorasExtra(db, quien, 'update'), true);
  assert.ok(permisos.sumarDeducidos(new Set(['attendance:update'])).has('salidas:update'), 'Presentismo: Editar ya autorizaba salidas');
});

// ---------------- S ----------------
test('S: quien solo administra usuarios no puede invitar a un administrador ni dar permisos que no tiene', async () => {
  const admin = await pedir(hUsuariosA, 'POST', '/api/app-users', { email: 'rc-invitado-1@example.com', roleId: rol['Administrador de Empresa'] });
  assert.equal(admin.status, 403);
  assert.match((await admin.json()).error, /No podés dar permisos que vos no tenés/);
  const suelto = await pedir(hUsuariosA, 'POST', '/api/app-users', { email: 'rc-invitado-2@example.com', permissions: ['settings:update'] });
  assert.equal(suelto.status, 403);
  const inventado = await pedir(hUsuariosA, 'POST', '/api/app-users', { email: 'rc-invitado-3@example.com', permissions: ['todo:todo'] });
  assert.equal(inventado.status, 400);
  // Lo que sí tiene, lo puede dar.
  const ok = await pedir(hUsuariosA, 'POST', '/api/app-users', { email: 'rc-invitado-4@example.com', permissions: ['attendance:read'] });
  assert.equal(ok.status, 200, await ok.text());
});

test('S: no se puede cambiar, desactivar ni borrar una cuenta con más permisos que uno', async () => {
  const idAdmin = await idDe('rc-otro-admin-a');
  const desactivar = await pedir(hUsuariosA, 'PUT', `/api/app-users/${idAdmin}`, { isActive: false });
  assert.equal(desactivar.status, 403);
  const sacarRol = await pedir(hUsuariosA, 'PUT', `/api/app-users/${idAdmin}`, { roleId: null });
  assert.equal(sacarRol.status, 403);
  const borrar = await pedir(hUsuariosA, 'DELETE', `/api/app-users/${idAdmin}`);
  assert.equal(borrar.status, 403);
  // El administrador sí puede (tiene todo).
  const idInvitado = (await db.query("SELECT id FROM app_users WHERE email = 'rc-invitado-4@example.com'"))[0][0].id;
  const cambiar = await pedir(hAdminA, 'PUT', `/api/app-users/${idInvitado}`, { roleId: rol['Encargado de presentismo'] });
  assert.equal(cambiar.status, 200, await cambiar.text());
});

// ---------------- O ----------------
test('O: una empresa crea su rol; la otra no lo ve, no lo usa ni lo cambia', async () => {
  const crear = await pedir(hAdminA, 'POST', '/api/roles', { name: 'Portería', description: 'Ve presentismo', permissions: ['attendance:read', 'employees:read'] });
  const creado = await crear.json();
  assert.equal(crear.status, 200, JSON.stringify(creado));
  const { id } = creado;

  const listaA = await (await pedir(hAdminA, 'GET', '/api/roles')).json();
  const propio = listaA.roles.find((r) => r.id === id);
  assert.ok(propio && propio.editable && propio.tenantId === A);
  const listaB = await (await pedir(hAdminB, 'GET', '/api/roles')).json();
  assert.ok(!listaB.roles.some((r) => r.id === id), 'la empresa B no ve el rol de A');

  assert.equal((await pedir(hAdminB, 'PUT', `/api/roles/${id}`, { name: 'Robado' })).status, 404);
  assert.equal((await pedir(hAdminB, 'DELETE', `/api/roles/${id}`)).status, 404);
  const usarEnB = await pedir(hAdminB, 'POST', '/api/app-users', { email: 'rc-invitado-b@example.com', roleId: id });
  assert.equal(usarEnB.status, 400);

  // El mismo nombre en otra empresa sí; repetido en la misma, no.
  assert.equal((await pedir(hAdminB, 'POST', '/api/roles', { name: 'Portería', permissions: [] })).status, 200);
  assert.equal((await pedir(hAdminA, 'POST', '/api/roles', { name: 'Portería', permissions: [] })).status, 409);
  // Ni igual a uno de la plataforma.
  assert.equal((await pedir(hAdminA, 'POST', '/api/roles', { name: 'Feriados', permissions: [] })).status, 409);
});

test('O + S: nadie arma un rol con permisos que no tiene; los de sistema no se tocan', async () => {
  const mas = await pedir(hUsuariosA, 'POST', '/api/roles', { name: 'Súper', permissions: ['settings:update'] });
  assert.equal(mas.status, 403);
  assert.equal((await pedir(hAdminA, 'PUT', `/api/roles/${rol.Feriados}`, { name: 'x' })).status, 403);
  assert.equal((await pedir(hAdminA, 'DELETE', `/api/roles/${rol['Encargado de presentismo']}`)).status, 403);
});

test('O: un rol en uso no se borra, y si deja sin administrador a la empresa no se guarda', async () => {
  const todos = permisos.PERMISOS_DE_EMPRESA;
  const { id } = await (await pedir(hAdminA, 'POST', '/api/roles', { name: 'Jefatura', permissions: todos })).json();
  const idOtro = await idDe('rc-otro-admin-a');
  assert.equal((await pedir(hAdminA, 'PUT', `/api/app-users/${idOtro}`, { roleId: id })).status, 200);
  assert.equal((await pedir(hAdminA, 'DELETE', `/api/roles/${id}`)).status, 409);

  // Mientras rc-admin-a siga siendo administrador por otro rol, sacarle
  // "Usuarios: Editar" a Jefatura se puede; si fuera el único, no.
  // (rc-usuarios-a también administra usuarios: se la apaga para la prueba.)
  await conRol('rc-admin-a', id);
  await db.query("UPDATE app_users SET is_active = 0 WHERE firebase_uid = 'rc-usuarios-a'");
  const quitar = await pedir(hAdminA, 'PUT', `/api/roles/${id}`, { permissions: todos.filter((p) => p !== 'users:update') });
  assert.equal(quitar.status, 409);
  assert.match((await quitar.json()).error, /administrar usuarios/);
  await conRol('rc-admin-a', rol['Administrador de Empresa']);
  await db.query("UPDATE app_users SET is_active = 1 WHERE firebase_uid = 'rc-usuarios-a'");
  // Con otro administrador que no depende de Jefatura, sí se puede.
  const ahora = await pedir(hAdminA, 'PUT', `/api/roles/${id}`, { permissions: todos.filter((p) => p !== 'users:update') });
  assert.equal(ahora.status, 200, await ahora.text());
});
