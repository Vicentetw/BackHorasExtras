// Permisos de pantallas (2026-10-09, antes de una demo). Lo que se arregló:
//  - Una cuenta del PORTAL DEL EMPLEADO no puede tener rol ni permisos (no
//    le aplicaban y la pantalla parecía decir que sí): el servidor lo rechaza.
//  - Las pantallas que ya se podían abrir dejan de quedar "a medias": quien
//    ve Presentismo puede leer los nombres que usan sus filtros, y la lista de
//    empleados, pero SIN datos personales.
//  - El tema/colores de la empresa lo lee cualquier usuario de la empresa.
// Y lo que NO cambió: sin permiso, sigue cerrado.
//
// Requiere el backend local corriendo (puerto 3000). Tenant descartable
// propio (999905), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999905;
const DNI = '30999905';
let hAdmin; let hPresentismo; let hFeriados; let hEmpleados;
let empId; let cuentaEmpleadoId;

const get = (h, url) => fetch(`${BASE_URL}${url}`, { headers: h });
const put = (h, url, body) => fetch(`${BASE_URL}${url}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function limpiar() {
  await db.query('DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM app_users WHERE firebase_uid = ?)', ['test-permisos-cuenta-empleado']);
  await db.query('DELETE FROM app_users WHERE firebase_uid = ?', ['test-permisos-cuenta-empleado']);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [T]);
}

before(async () => {
  await db.query("INSERT INTO tenants (id, name, code) VALUES (?, 'Permisos pantallas (test)', 'permisos-pantallas-test') ON DUPLICATE KEY UPDATE name = VALUES(name)", [T]);
  await limpiar();
  hAdmin = await getTestAuthHeaders('test-permisos-admin', { isSuperadmin: false, tenantId: T, permissions: ['users:read', 'users:update'] });
  hPresentismo = await getTestAuthHeaders('test-permisos-presentismo', { isSuperadmin: false, tenantId: T, permissions: ['attendance:read'] });
  hFeriados = await getTestAuthHeaders('test-permisos-feriados', { isSuperadmin: false, tenantId: T, permissions: ['holidays:read'] });
  hEmpleados = await getTestAuthHeaders('test-permisos-empleados', { isSuperadmin: false, tenantId: T, permissions: ['employees:read'] });
  const [e] = await db.query(
    "INSERT INTO employees (employee_id, nombre, documento, direccion, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (905001, 'Persona Permisos (test)', ?, 'Calle Falsa 123', ?, '2020-01-01', 0, 1)",
    [DNI, T]);
  empId = e.insertId;
  // Una cuenta del portal del empleado (como motorolatrelew@gmail.com).
  const [c] = await db.query(
    "INSERT INTO app_users (firebase_uid, email, tenant_id, employee_id, is_superadmin, is_active) VALUES ('test-permisos-cuenta-empleado', 'empleado-permisos@test.local', ?, ?, 0, 1)",
    [T, empId]);
  cuentaEmpleadoId = c.insertId;
});

after(async () => {
  await limpiar();
  for (const u of ['test-permisos-admin', 'test-permisos-presentismo', 'test-permisos-feriados', 'test-permisos-empleados']) await deleteTestUser(u);
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

test('/usuarios marca la cuenta de empleado con su legajo', async () => {
  const r = await get(hAdmin, '/api/app-users');
  assert.equal(r.status, 200);
  const u = (await r.json()).users.find((x) => x.id === cuentaEmpleadoId);
  assert.equal(u.employee_id, empId);
  assert.equal(String(u.employee_legajo), '905001');
});

test('cuenta de empleado: rol, permisos o superadmin -> 400; activar y vaciar permisos -> 200', async () => {
  const url = `/api/app-users/${cuentaEmpleadoId}`;
  const r1 = await put(hAdmin, url, { permissions: ['employees:read', 'attendance:read', 'holidays:read'] });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /portal del empleado/);
  assert.equal((await put(hAdmin, url, { roleId: 1 })).status, 400);
  const [[sinCambios]] = await db.query('SELECT role_id FROM app_users WHERE id = ?', [cuentaEmpleadoId]);
  assert.equal(sinCambios.role_id, null, 'no se guardó nada');
  const [perm] = await db.query('SELECT permission FROM user_permissions WHERE user_id = ?', [cuentaEmpleadoId]);
  assert.equal(perm.length, 0);
  assert.equal((await put(hAdmin, url, { permissions: [], roleId: null, isActive: false })).status, 200);
  const [[u]] = await db.query('SELECT is_active FROM app_users WHERE id = ?', [cuentaEmpleadoId]);
  assert.equal(u.is_active, 0);
});

test('lista de empleados: con "ver presentismo" sin datos personales; con "ver empleados" completa; con solo feriados, cerrada', async () => {
  const sinDatos = await get(hPresentismo, '/api/employees?limit=0');
  assert.equal(sinDatos.status, 200);
  const e1 = (await sinDatos.json()).data.find((x) => x.id === empId);
  assert.ok(e1, 'la persona aparece');
  assert.equal(e1.nombre, 'Persona Permisos (test)');
  for (const campo of ['documento', 'direccion', 'email', 'tipo_documento', 'motivo_baja']) assert.ok(!(campo in e1), `no trae ${campo}`);
  // No se puede buscar por DNI sin "ver empleados".
  const porDni = await (await get(hPresentismo, `/api/employees?limit=0&search=${DNI}`)).json();
  assert.equal(porDni.data.length, 0);
  // Con "ver empleados": completa y busca por DNI.
  const completa = await (await get(hEmpleados, `/api/employees?limit=0&search=${DNI}`)).json();
  assert.equal(completa.data[0].documento, DNI);
  assert.equal(completa.data[0].direccion, 'Calle Falsa 123');
  // Con solo feriados: sigue cerrada.
  assert.equal((await get(hFeriados, '/api/employees?limit=0')).status, 403);
});

test('lo que Presentismo necesita para sus filtros se puede leer con "ver presentismo"', async () => {
  for (const url of ['/api/employee-categories', '/api/ciudades', '/api/sucursales', '/api/labor-engine/admin/templates',
    '/config/overtime-settings', '/config/particular-exit-limit', '/config/campana-cutoff', '/config/campana-presentismo-modo',
    '/config/campana-solo-afectados', '/api/event-types']) {
    assert.equal((await get(hPresentismo, url)).status, 200, url);
  }
});

test('el tema de la empresa lo lee cualquiera de la empresa; escribirlo sigue pidiendo permiso', async () => {
  assert.equal((await get(hFeriados, '/config/theme')).status, 200);
  const w = await fetch(`${BASE_URL}/config/theme`, { method: 'POST', headers: { ...hFeriados, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'x' }) });
  assert.equal(w.status, 403);
});

test('cuenta de empleado: lee el tema de su empresa, no lo puede guardar, y el resto le sigue cerrado', async () => {
  const [e2] = await db.query(
    "INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (905002, 'Portal Permisos (test)', ?, '2020-01-01', 0, 1)", [T]);
  const h = await getTestAuthHeaders('test-permisos-portal', { isSuperadmin: false, tenantId: T, permissions: ['employees:read', 'attendance:read'] });
  await db.query("UPDATE app_users SET employee_id = ? WHERE firebase_uid = 'test-permisos-portal'", [e2.insertId]);
  try {
    assert.equal((await get(h, '/config/theme')).status, 200);
    const w = await fetch(`${BASE_URL}/config/theme`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'x' }) });
    assert.equal(w.status, 403);
    // Aunque tenga permisos cargados, una cuenta de empleado no ve nada de gestión.
    assert.equal((await get(h, '/api/employees?limit=0')).status, 403);
    assert.equal((await get(h, '/config/overtime-settings')).status, 403);
  } finally {
    await db.query("UPDATE app_users SET employee_id = NULL WHERE firebase_uid = 'test-permisos-portal'");
    await deleteTestUser('test-permisos-portal');
  }
});

test('lo que no se tocó sigue cerrado: con solo feriados no se leen plantillas ni configuración de Presentismo', async () => {
  for (const url of ['/api/labor-engine/admin/templates', '/config/overtime-settings', '/api/employee-categories', '/api/labor-engine/admin/employees']) {
    assert.equal((await get(hFeriados, url)).status, 403, url);
  }
});
