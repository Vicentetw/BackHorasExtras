// "Eliminar empresa de prueba" (2026-10-14): borra la empresa con TODO lo
// suyo, en una transacciÃ³n, solo si no tiene fichajes ni pagos, y solo si se
// escribe su nombre. Ver motor-laboral/services/eliminarEmpresaPrueba.js.
// Requiere el backend local (puerto 3000).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
// API modular de firebase-admin (la 'getAuth()' vieja no existe desde la v14).

const { initializeApp, getApps, cert } = require('firebase-admin/app');

const { getAuth } = require('firebase-admin/auth');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PRUEBA = 999961; // empresa de prueba "llena"
const REAL = 999962;   // tiene un fichaje: no se puede borrar
const SUF = Date.now().toString(36);
const UID_SUPER = `elim-super-${SUF}`;
const UID_ADMIN = `elim-admin-${SUF}`;
const UID_REAL = `elim-real-${SUF}`;
const NOMBRE = 'Empresa para borrar (test)';
let hSuper; let leadId;

function initAdmin() {
  if (getApps().length) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  initializeApp({ credential: cert(json ? JSON.parse(json) : require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH))) });
}
const pedir = (m, url, body) => fetch(BASE_URL + url, { method: m, headers: { ...hSuper, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const cuenta = async (tabla, col, valor) => Number((await db.query(`SELECT COUNT(*) n FROM \`${tabla}\` WHERE \`${col}\` = ?`, [valor]))[0][0].n);

before(async () => {
  hSuper = await getTestAuthHeaders(UID_SUPER, { isSuperadmin: true });
  await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?), (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
    [PRUEBA, NOMBRE, `elim-prueba-${SUF}`, REAL, 'Empresa con fichajes (test)', `elim-real-${SUF}`]);

  // La empresa de prueba, con datos en muchas tablas y relaciones entre ellas.
  await getTestAuthHeaders(UID_ADMIN, { isSuperadmin: false, tenantId: PRUEBA }); // usuario + permisos + login real
  const [[adminId]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_ADMIN]);
  await db.query('INSERT INTO plan_requests (tenant_id, employee_count, requested_by) VALUES (?, 12, ?)', [PRUEBA, adminId.id]);
  await db.query(`INSERT INTO tenant_subscriptions (tenant_id, plan_id, billing_period, status) SELECT ?, p.id, 'monthly', 'trial' FROM plans p LIMIT 1`, [PRUEBA]);
  const [et] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'ELIM_TEST', 'Motivo (test)', 1)`, [PRUEBA]);
  await db.query(`INSERT INTO event_type_count_modes (event_type_id, modo, vigente_desde, created_by) VALUES (?, 'habiles', '2020-01-01', ?)`, [et.insertId, adminId.id]);
  const [pl] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Plantilla (test)', 'fixed', 1, 1)`, [PRUEBA]);
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'B', '07:00:00', '14:00:00', 'WORK', 1)`, [pl.insertId]);
  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, activo) VALUES (?, 'Empleado (test)', ?, '2020-01-01', 1)`, [961001, PRUEBA]);
  await db.query('INSERT INTO employee_leave_balances (employee_id, year, allotted_days) VALUES (?, 2026, 14)', [emp.insertId]);
  const [lead] = await db.query(`INSERT INTO signup_leads (name, company_name, email, status, tenant_id) VALUES ('Persona', ?, ?, 'provisioned', ?)`,
    [NOMBRE, `elim-${SUF}@test.example.com`, PRUEBA]);
  leadId = lead.insertId;

  // La "real": un fichaje alcanza para que no se pueda borrar desde acÃ¡.
  await getTestAuthHeaders(UID_REAL, { isSuperadmin: false, tenantId: REAL });
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (961999, ?, '2026-10-01 08:00:00', 'test')`, [REAL]);
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [REAL]);
  await db.query('DELETE FROM signup_leads WHERE id = ?', [leadId]).catch(() => {});
  for (const uid of [UID_ADMIN, UID_REAL, UID_SUPER]) await deleteTestUser(uid);
  // Si algo fallÃ³ a mitad, limpiar-datos-de-prueba.js termina de borrar (ids >= 999900).
  await db.query('DELETE FROM tenants WHERE id = ?', [REAL]).catch(() => {});
  await db.end().catch(() => {});
});

test('la revisiÃ³n muestra quÃ© tiene la empresa y que se puede borrar', async () => {
  const r = await pedir('GET', `/api/labor-engine/admin/tenants/${PRUEBA}/eliminacion`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.eliminable, true);
  assert.deepEqual(d.bloqueos, []);
  const tablas = d.contenido.map((c) => c.tabla);
  for (const t of ['app_users', 'plan_requests', 'tenant_subscriptions', 'event_types', 'work_schedule_templates', 'employees', 'signup_leads']) {
    assert.ok(tablas.includes(t), `falta ${t} en la revisiÃ³n`);
  }
  assert.equal(d.contenido.find((c) => c.tabla === 'signup_leads').seConserva, true);
  assert.ok(d.usuarios.length >= 1);
});

test('una empresa con fichajes NO se borra (bloqueo), aunque se escriba bien el nombre', async () => {
  const rev = await (await pedir('GET', `/api/labor-engine/admin/tenants/${REAL}/eliminacion`)).json();
  assert.equal(rev.eliminable, false);
  assert.equal(rev.bloqueos[0].que, 'fichajes');
  const r = await pedir('POST', `/api/labor-engine/admin/tenants/${REAL}/eliminar-prueba`, { nombre: 'Empresa con fichajes (test)' });
  assert.equal(r.status, 409);
  assert.equal(await cuenta('tenants', 'id', REAL), 1);
  assert.equal(await cuenta('app_users', 'firebase_uid', UID_REAL), 1);
});

test('con el nombre mal escrito no se borra nada', async () => {
  const r = await pedir('POST', `/api/labor-engine/admin/tenants/${PRUEBA}/eliminar-prueba`, { nombre: 'Empresa para borrar' });
  assert.equal(r.status, 400);
  assert.equal(await cuenta('tenants', 'id', PRUEBA), 1);
  assert.equal(await cuenta('employees', 'tenant_id', PRUEBA), 1);
});

test('un usuario de empresa (no superadmin) no puede ni revisar ni borrar', async () => {
  const h = await getTestAuthHeaders(UID_REAL, { isSuperadmin: false, tenantId: REAL });
  const r = await fetch(`${BASE_URL}/api/labor-engine/admin/tenants/${PRUEBA}/eliminar-prueba`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: NOMBRE }) });
  assert.equal(r.status, 403);
  assert.equal(await cuenta('tenants', 'id', PRUEBA), 1);
});

test('con el nombre correcto borra TODO, conserva la solicitud sin empresa y borra el login', async () => {
  const [[adminId]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_ADMIN]);
  const r = await pedir('POST', `/api/labor-engine/admin/tenants/${PRUEBA}/eliminar-prueba`, { nombre: ` ${NOMBRE} ` });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(await cuenta('tenants', 'id', PRUEBA), 0);
  // Nada con su tenant_id en ninguna tabla.
  const [tablas] = await db.query(`SELECT TABLE_NAME t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id'
                                    AND TABLE_NAME IN (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE')`);
  for (const { t } of tablas) assert.equal(await cuenta(t, 'tenant_id', PRUEBA), 0, `quedaron filas en ${t}`);
  // Ni sus hijas sin tenant_id.
  assert.equal(await cuenta('user_permissions', 'user_id', adminId.id), 0);
  assert.equal(await cuenta('event_type_count_modes', 'created_by', adminId.id), 0);
  // La solicitud de alta se conserva, sin empresa.
  const [[lead]] = await db.query('SELECT tenant_id FROM signup_leads WHERE id = ?', [leadId]);
  assert.equal(lead.tenant_id, null);
  // Y la cuenta de login de su usuario ya no existe.
  initAdmin();
  await assert.rejects(getAuth().getUser(UID_ADMIN), (e) => e.code === 'auth/user-not-found');
  assert.ok(d.loginsBorrados >= 1);
  // La otra empresa, intacta.
  assert.equal(await cuenta('tenants', 'id', REAL), 1);
  // Y queda en el registro de actividad, con el nombre de la empresa borrada
  // (se guarda al terminar la respuesta: se espera un momento).
  await new Promise((r) => setTimeout(r, 800));
  const [[act]] = await db.query('SELECT descripcion, detalle FROM registro_actividad WHERE ruta = ? ORDER BY id DESC LIMIT 1',
    [`/api/labor-engine/admin/tenants/${PRUEBA}/eliminar-prueba`]);
  assert.match(act.descripcion, /Eliminó una empresa de prueba/);
  assert.ok(String(act.detalle).includes(NOMBRE), `el registro no tiene el nombre: ${act.detalle}`);
});
