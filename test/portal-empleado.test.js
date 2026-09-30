// Portal del empleado (etapa 1, solo lectura): /api/mi y /api/portal-empleados.
// Migracion 20261010. Lo que se prueba es sobre todo SEGURIDAD:
//   - una cuenta de empleado ve SOLO lo suyo, aunque pida el legajo de otro;
//   - queda encerrada en su portal aunque por error tenga TODOS los permisos
//     (lista blanca en appUserMiddleware.js), incluida facturacion;
//   - la respuesta no trae lo interno del motor;
//   - otra empresa no puede invitar ni tocar empleados ajenos.
// Requiere el backend local corriendo. Tenants descartables (999979/999980).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999979;
const OTRA = 999980;
const A = { uid: 'test-portal-a', legajo: 900901, userId: 8890201 };
const B = { uid: 'test-portal-b', legajo: 900902, userId: 8890202 };
const ADMIN = 'test-portal-admin';
const ADMIN_OTRA = 'test-portal-admin-otra';
const EMAIL_INVITADO = 'portal-invitado-900903@example.com';
let hA, hB, hAdmin, hAdminOtra, idA, idB, idC;

const get = (ruta, h) => fetch(`${URL}${ruta}`, { headers: h });
const send = (metodo, ruta, body, h) => fetch(`${URL}${ruta}`, { method: metodo, headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function borrarCuentaInvitada() {
  const [[u]] = await db.query('SELECT firebase_uid FROM app_users WHERE email = ?', [EMAIL_INVITADO]);
  if (u) {
    await db.query('DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM app_users WHERE email = ?)', [EMAIL_INVITADO]);
    await db.query('DELETE FROM app_users WHERE email = ?', [EMAIL_INVITADO]);
  }
  try { const fu = await admin.auth().getUserByEmail(EMAIL_INVITADO); await admin.auth().deleteUser(fu.uid); } catch { /* no existia */ }
}

async function cleanup() {
  await db.query('UPDATE app_users SET employee_id = NULL WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await borrarCuentaInvitada();
  for (const t of [T, OTRA]) {
    await db.query('DELETE FROM overtime_period_adjustments WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_period_results WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_period_closings WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [t]);
    const [tpls] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ?', [t]);
    for (const { id } of tpls) await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [id]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
    for (const x of ['Checkins', 'user_employee_map', 'users', 'employees']) await db.query(`DELETE FROM ${x} WHERE tenant_id = ?`, [t]);
  }
}

before(async () => {
  for (const [id, n] of [[T, 'Portal (test)'], [OTRA, 'Portal otra (test)']]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, n, `portal-${id}-test`]);
  }
  // Las cuentas de empleado se crean CON TODOS LOS PERMISOS (el default del
  // helper) a proposito: tienen que quedar encerradas igual.
  hA = await getTestAuthHeaders(A.uid, { isSuperadmin: false, tenantId: T });
  hB = await getTestAuthHeaders(B.uid, { isSuperadmin: false, tenantId: T });
  hAdmin = await getTestAuthHeaders(ADMIN, { isSuperadmin: false, tenantId: T });
  hAdminOtra = await getTestAuthHeaders(ADMIN_OTRA, { isSuperadmin: false, tenantId: OTRA });
  await cleanup();

  const [tpl] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, '7-14 (test)', 'FIXED', 1, 0, 'legacy')`, [T]);
  for (let dow = 1; dow <= 5; dow++) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Jornada', '07:00:00', '14:00:00', 'WORK', 1)`, [tpl.insertId, dow]);
  }
  const ids = [];
  for (const [p, nombre] of [[A, 'Portal A (test)'], [B, 'Portal B (test)']]) {
    const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, ?, ?, 1, '2020-01-01', 0)`, [p.legajo, nombre, T]);
    ids.push(e.insertId);
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`, [p.userId, T, String(p.legajo), nombre]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [p.userId, T, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2025-01-01', NULL)`, [e.insertId, T, tpl.insertId]);
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [p.userId, T, '2026-06-01 06:58:00', '10.0.3.1', p.userId, T, p === A ? '2026-06-01 14:05:00' : '2026-06-01 18:30:00', '10.0.3.1']);
  }
  [idA, idB] = ids;
  const [c] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, exclude_from_report) VALUES (900903, 'Portal C sin cuenta (test)', ?, 1, 0)`, [T]);
  idC = c.insertId;
  await db.query('UPDATE app_users SET employee_id = ? WHERE firebase_uid = ?', [idA, A.uid]);
  await db.query('UPDATE app_users SET employee_id = ? WHERE firebase_uid = ?', [idB, B.uid]);
});

after(async () => {
  await cleanup();
  for (const uid of [A.uid, B.uid, ADMIN, ADMIN_OTRA]) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

test('mi perfil: cada uno ve el suyo, y /me dice que es cuenta de empleado sin permisos', async () => {
  assert.deepEqual(await (await get('/api/mi/perfil', hA)).json(), { legajo: A.legajo, nombre: 'Portal A (test)', empresa: 'Portal (test)' });
  assert.equal((await (await get('/api/mi/perfil', hB)).json()).legajo, B.legajo);
  const me = await (await get('/api/app-users/me', hA)).json();
  assert.equal(me.employeeId, idA);
  assert.deepEqual(me.permissions, [], 'aunque la fila tenga todos los permisos, una cuenta de empleado no hereda ninguno');
  assert.equal(me.isSuperadmin, false);
});

test('mi mes: solo lo propio, aunque se pida el legajo de otro', async () => {
  const mio = await (await get('/api/mi/mes?periodo=2026-06', hA)).json();
  const dia = mio.dias.find((d) => d.fecha === '2026-06-01');
  assert.deepEqual(dia.fichajes, ['06:58', '14:05']);
  // Intento de ver a B: el parametro se ignora, el legajo sale del token.
  const trampa = await (await get(`/api/mi/mes?periodo=2026-06&employeeId=${B.legajo}&tenantId=${OTRA}`, hA)).json();
  assert.deepEqual(trampa.dias.find((d) => d.fecha === '2026-06-01').fichajes, ['06:58', '14:05']);
  const deB = await (await get('/api/mi/mes?periodo=2026-06', hB)).json();
  assert.deepEqual(deB.dias.find((d) => d.fecha === '2026-06-01').fichajes, ['06:58', '18:30']);
  assert.equal((await get('/api/mi/mes?periodo=2026-13', hA)).status, 400);
});

test('mi mes: la respuesta no trae lo interno del motor', async () => {
  const texto = await (await get('/api/mi/mes?periodo=2026-06', hA)).text();
  for (const interno of ['shadowResult', 'engineExplanation', 'manualEntries', 'possibleJustification', 'overtimeSource', 'userId', 'badge']) {
    assert.ok(!texto.includes(interno), `no deberia salir "${interno}"`);
  }
});

test('una cuenta de empleado queda encerrada en su portal (incluida facturacion)', async () => {
  const cerradas = [
    ['GET', '/attendance-range?from=2026-06-01&to=2026-06-30'],
    ['GET', '/api/employees'],
    ['GET', '/api/app-users'],
    ['GET', `/api/billing/subscriptions/${T}`],
    ['POST', `/api/billing/subscriptions/${T}/request-cancellation`],
    ['POST', `/api/billing/subscriptions/${T}/request-payment-link`],
    ['GET', '/api/liquidacion-horas-extra?periodo=2026-06'],
    ['GET', '/api/fichajes-del-dia?fecha=2026-06-01'],
    ['GET', '/api/portal-empleados'],
    ['POST', '/api/portal-empleados/invitar'],
    ['GET', '/config/payroll-regime'],
    ['GET', '/api/labor-engine/admin/conventions'],
  ];
  for (const [metodo, ruta] of cerradas) {
    const r = metodo === 'GET' ? await get(ruta, hA) : await send(metodo, ruta, {}, hA);
    assert.equal(r.status, 403, `${metodo} ${ruta} tendria que estar cerrada para un empleado (dio ${r.status})`);
  }
});

test('un administrador no usa /api/mi, y un legajo dado de baja pierde el acceso', async () => {
  assert.equal((await get('/api/mi/perfil', hAdmin)).status, 403);
  await db.query('UPDATE employees SET activo = 0 WHERE id = ?', [idB]);
  assert.equal((await get('/api/mi/perfil', hB)).status, 403);
  await db.query('UPDATE employees SET activo = 1 WHERE id = ?', [idB]);
  assert.equal((await get('/api/mi/perfil', hB)).status, 200);
});

test('mes cerrado: el empleado ve lo que se le liquido, con los ajustes', async () => {
  const [c] = await db.query(`INSERT INTO overtime_period_closings (tenant_id, periodo, accion) VALUES (?, '2026-06', 'CERRAR')`, [T]);
  await db.query(`INSERT INTO overtime_period_results (closing_id, tenant_id, periodo, employee_id, legajo, nombre, a_liquidar, por_recargo) VALUES (?, ?, '2026-06', ?, ?, 'x', 600, '{"50%":600}'), (?, ?, '2026-06', ?, ?, 'y', 999, '{}')`,
    [c.insertId, T, idA, A.legajo, c.insertId, T, idB, B.legajo]);
  await db.query(`INSERT INTO overtime_period_adjustments (closing_id, tenant_id, periodo, periodo_origen, employee_id, legajo, minutos) VALUES (?, ?, '2026-06', '2026-05', ?, ?, -60)`, [c.insertId, T, idA, A.legajo]);
  const { liquidado } = await (await get('/api/mi/mes?periodo=2026-06', hA)).json();
  assert.equal(liquidado.delMesMinutos, 600);
  assert.deepEqual(liquidado.ajustes, [{ periodo: '2026-05', minutos: -60 }]);
  assert.equal(liquidado.totalMinutos, 540, 'lo de B (999) no se mezcla');
  assert.equal((await (await get('/api/mi/mes?periodo=2026-05', hA)).json()).liquidado, null, 'mes abierto: todavia no hay liquidado');
});

test('admin: mail, invitacion y corte de acceso; otra empresa no toca empleados ajenos', async () => {
  const lista = (await (await get('/api/portal-empleados', hAdmin)).json()).empleados;
  assert.equal(lista.find((e) => e.id === idA).cuenta, 'ACTIVA');
  assert.equal(lista.find((e) => e.id === idC).cuenta, 'SIN_EMAIL');

  assert.equal((await send('PUT', `/api/portal-empleados/${idC}/email`, { email: 'no-es-un-mail' }, hAdmin)).status, 400);
  assert.equal((await send('PUT', `/api/portal-empleados/${idC}/email`, { email: EMAIL_INVITADO }, hAdminOtra)).status, 404);
  assert.equal((await send('PUT', `/api/portal-empleados/${idC}/email`, { email: EMAIL_INVITADO }, hAdmin)).status, 200);
  assert.equal((await send('PUT', `/api/portal-empleados/${idA}/email`, { email: 'otro@example.com' }, hAdmin)).status, 409, 'con cuenta, el mail de ingreso no se cambia en silencio');

  const otra = await (await send('POST', '/api/portal-empleados/invitar', { employeeIds: [idC] }, hAdminOtra)).json();
  assert.equal(otra.invitados, 0);
  const inv = await (await send('POST', '/api/portal-empleados/invitar', { employeeIds: [idC, idA] }, hAdmin)).json();
  assert.equal(inv.invitados, 1);
  assert.equal(inv.resultados.find((r) => r.id === idA).error, 'Ya tiene cuenta');
  const [[cuenta]] = await db.query('SELECT employee_id, tenant_id, is_superadmin FROM app_users WHERE email = ?', [EMAIL_INVITADO]);
  assert.deepEqual({ ...cuenta }, { employee_id: idC, tenant_id: T, is_superadmin: 0 });

  assert.equal((await send('POST', `/api/portal-empleados/${idA}/desactivar`, {}, hAdminOtra)).status, 404);
  assert.equal((await send('POST', `/api/portal-empleados/${idA}/desactivar`, {}, hAdmin)).status, 200);
  assert.equal((await get('/api/mi/perfil', hA)).status, 403, 'desactivada, no entra');
  assert.equal((await send('POST', `/api/portal-empleados/${idA}/reactivar`, {}, hAdmin)).status, 200);
  assert.equal((await get('/api/mi/perfil', hA)).status, 200);
});
