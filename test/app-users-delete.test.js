// Eliminar cuentas de usuario de la app, de verdad y no solo deshabilitar.
//
// POR QUE EXISTE ESTA DISTINCION
// ------------------------------
// Desde la auditoria de cargas manuales (migracion 20260927), varias tablas
// guardan QUIEN hizo cada cosa con una foreign key contra app_users. Eso es
// deliberado: si se pudiera borrar la cuenta, se borraria el rastro de quien
// cargo esas horas extra o esa licencia -- justo lo que permite responder un
// reclamo.
//
// Asi que el borrado real solo corresponde a una cuenta SIN historial. El
// caso que lo motivo es concreto: un test mal escrito
// (country-firewall-http.test.js) dejaba un app_user SUPERADMIN colgado en
// la base cada vez que corria, y desde la pantalla no habia forma de
// sacarlo, porque el boton de borrar solo hacia is_active = 0.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999930;
const UID_ADMIN = 'test-borrado-admin';
const UID_LIMPIO = 'test-borrado-sin-historial';
const UID_CON_HISTORIAL = 'test-borrado-con-historial';
const USERID_RELOJ = 8890060;

let headersAdmin;
let idLimpio, idConHistorial;

async function limpiar() {
  await db.query('DELETE FROM manual_entry_log WHERE user_id = ?', [USERID_RELOJ]);
  await db.query('DELETE FROM ManualEntries WHERE userId = ?', [USERID_RELOJ]);
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [USERID_RELOJ]);
  await db.query('DELETE FROM users WHERE USERID = ?', [USERID_RELOJ]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT]);
}

before(async () => {
  await db.query(
    "INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Borrado (test)', 'tenant-borrado-test') " +
    'ON DUPLICATE KEY UPDATE name = VALUES(name)', [TENANT]);

  headersAdmin = await getTestAuthHeaders(UID_ADMIN, { isSuperadmin: true });
  await getTestAuthHeaders(UID_LIMPIO, { isSuperadmin: false, tenantId: TENANT, permissions: [] });
  const headersConHistorial = await getTestAuthHeaders(UID_CON_HISTORIAL, {
    isSuperadmin: false, tenantId: TENANT,
    permissions: ['attendance:read', 'attendance:create']
  });

  const [[a]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_LIMPIO]);
  const [[b]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_CON_HISTORIAL]);
  idLimpio = a.id;
  idConHistorial = b.id;

  await limpiar();

  // Al segundo usuario se le hace cargar una hora extra, para que quede
  // con actividad registrada a su nombre.
  const [emp] = await db.query(
    'INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)',
    [900760, 'Empleado Borrado (test)', TENANT]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)',
    [USERID_RELOJ, TENANT, '900760', 'Empleado Borrado']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)',
    [USERID_RELOJ, TENANT, emp.insertId, 'manual']);

  const res = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headersConHistorial, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: USERID_RELOJ,
      startDatetime: '2099-04-01 18:00:00',
      endDatetime: '2099-04-01 20:00:00',
      durationMinutes: 120,
      type: 'overtime'
    })
  });
  assert.equal(res.status, 200, 'el alta de prueba deberia funcionar');
});

after(async () => {
  await limpiar();
  await deleteTestUser(UID_ADMIN);
  await deleteTestUser(UID_LIMPIO);
  await deleteTestUser(UID_CON_HISTORIAL);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]);
  await closeDb();
});

test('dice de antemano si una cuenta se puede eliminar', async () => {
  const limpio = await (await fetch(`${BASE_URL}/api/app-users/${idLimpio}/eliminable`, { headers: headersAdmin })).json();
  assert.equal(limpio.eliminable, true);
  assert.equal(limpio.motivos.length, 0);

  const conHistorial = await (await fetch(`${BASE_URL}/api/app-users/${idConHistorial}/eliminable`, { headers: headersAdmin })).json();
  assert.equal(conHistorial.eliminable, false);
  assert.ok(conHistorial.motivos.length > 0, 'tiene que explicar POR QUE no se puede');
  assert.ok(
    conHistorial.motivos.some((m) => /horas/i.test(m.descripcion)),
    `los motivos deberian mencionar las horas cargadas: ${JSON.stringify(conHistorial.motivos)}`
  );
});

test('sin ?permanente sigue siendo deshabilitar, no borrar', async () => {
  const res = await fetch(`${BASE_URL}/api/app-users/${idConHistorial}`, { method: 'DELETE', headers: headersAdmin });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.accion, 'deshabilitado');

  const [[u]] = await db.query('SELECT is_active FROM app_users WHERE id = ?', [idConHistorial]);
  assert.equal(Number(u.is_active), 0, 'debe quedar deshabilitado');
  assert.ok(u !== undefined, 'pero la fila debe seguir existiendo');
});

test('NO deja borrar una cuenta con actividad registrada a su nombre', async () => {
  const res = await fetch(`${BASE_URL}/api/app-users/${idConHistorial}?permanente=1`, {
    method: 'DELETE', headers: headersAdmin
  });
  const json = await res.json();
  assert.equal(res.status, 409);
  assert.ok(json.motivos.length > 0);

  const [rows] = await db.query('SELECT id FROM app_users WHERE id = ?', [idConHistorial]);
  assert.equal(rows.length, 1, 'la cuenta NO debe haberse borrado');

  // Y lo que importa de verdad: el rastro de quien cargo esas horas sigue ahi.
  const [[log]] = await db.query('SELECT performed_by FROM manual_entry_log WHERE performed_by = ?', [idConHistorial]);
  assert.ok(log, 'el registro de auditoria debe seguir apuntando a esa cuenta');
});

test('SÍ borra de verdad una cuenta sin historial, con sus permisos', async () => {
  await db.query('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)', [idLimpio, 'employees:read']);

  const res = await fetch(`${BASE_URL}/api/app-users/${idLimpio}?permanente=1`, {
    method: 'DELETE', headers: headersAdmin
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.accion, 'eliminado');

  const [rows] = await db.query('SELECT id FROM app_users WHERE id = ?', [idLimpio]);
  assert.equal(rows.length, 0, 'la cuenta debe haber desaparecido');

  const [permisos] = await db.query('SELECT user_id FROM user_permissions WHERE user_id = ?', [idLimpio]);
  assert.equal(permisos.length, 0, 'sus permisos se van con ella');
});

test('nadie puede borrarse a sí mismo', async () => {
  const [[yo]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_ADMIN]);
  const res = await fetch(`${BASE_URL}/api/app-users/${yo.id}?permanente=1`, {
    method: 'DELETE', headers: headersAdmin
  });
  assert.equal(res.status, 400);

  const [rows] = await db.query('SELECT id FROM app_users WHERE id = ?', [yo.id]);
  assert.equal(rows.length, 1, 'la cuenta propia debe seguir existiendo');
});
