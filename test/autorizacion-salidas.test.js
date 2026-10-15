// Autorización de salidas particulares (E1, 2026-10-15). Pedido del dueño:
// nadie puede salir en horario sin permiso (la aseguradora no responde si
// alguien "se escapa"), así que cada salida particular queda autorizada o no
// por alguien, con quién y cuándo. Es una OPCIÓN de cada empresa: apagada,
// nada cambia. Requiere el backend local (puerto 3000) y la migración 20261019.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { darHorarioDeEmpresa, quitarHorarioDeEmpresa } = require('../test-helpers/horarioDeEmpresa');
const autorizacion = require('../motor-laboral/services/autorizacionSalidas');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999973;
const B = 999974;
const UID_ADMIN = 'test-aut-salidas-admin';
const UID_ENCARGADO = 'test-aut-salidas-encargado';
const UID_LECTOR = 'test-aut-salidas-lector';
const UID_B = 'test-aut-salidas-b';
const LEGAJO = 973001;
const USERID = 9973001;
const M_SALIDA = 9973002;
const M_REGRESO = 9973003;
const LUNES = '2026-05-11';   // sale 10:00, vuelve 11:00
const VIERNES = '2026-05-15'; // entra tarde 09:00 con el marcador de permiso
let hAdmin; let hEncargado; let hLector; let hB;

const pedir = (h, m, url, body) => fetch(BASE_URL + url, { method: m, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const salidas = async (h = hAdmin) => (await pedir(h, 'GET', `/movements-range?from=2026-05-01&to=2026-05-31&category=PARTICULAR&groupBy=month`)).json();
const filaDe = (r, fecha) => r.rows.find((x) => x.date === fecha && String(x.employeeId) === String(LEGAJO));
const diaDetalle = async (fecha) => {
  const r = await (await pedir(hAdmin, 'GET', `/attendance-range?from=2026-05-01&to=2026-05-31&employeeId=${LEGAJO}`)).json();
  return r.data[0].days.find((d) => d.date === fecha);
};
const diaria = async (fecha) => {
  const r = await (await pedir(hAdmin, 'GET', `/api/labor-engine/attendance/${fecha}`)).json();
  return r.attendance.find((a) => String(a.employeeId) === String(LEGAJO));
};
const item = (fila) => ({ legajo: String(LEGAJO), fecha: fila.date, tipo: fila.autorizacion.tipo, hora: fila.autorizacion.hora });

before(async () => {
  for (const [id, code] of [[A, 'aut-salidas-a'], [B, 'aut-salidas-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  hAdmin = await getTestAuthHeaders(UID_ADMIN, { isSuperadmin: false, tenantId: A });
  hEncargado = await getTestAuthHeaders(UID_ENCARGADO, { isSuperadmin: false, tenantId: A, permissions: ['attendance:read', 'salidas:update'] });
  hLector = await getTestAuthHeaders(UID_LECTOR, { isSuperadmin: false, tenantId: A, permissions: ['attendance:read'] });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: B });
  await darHorarioDeEmpresa(db, A); // 07:00-13:40, lunes a viernes
  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, activo, exclude_from_report) VALUES (?, 'Permiso Test', ?, '2020-01-01', 1, 0)`, [LEGAJO, A]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID, A, String(LEGAJO), 'Permiso Test']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID, A, emp.insertId, 'test']);
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '5', 'Marcador Salida'), (?, ?, '6', 'Marcador Regreso')`, [M_SALIDA, A, M_REGRESO, A]);
  await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES
    (?, ?, '5', 'Marcador Salida', 'PARTICULAR', 'SALIDA', 1), (?, ?, '6', 'Marcador Regreso', 'PARTICULAR', 'REGRESO', 1)`, [M_SALIDA, A, M_REGRESO, A]);
  const fichar = (uid, cuando) => db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [uid, A, cuando]);
  // Lunes: entra, sale con permiso 10:00, vuelve 11:00, se va.
  await fichar(USERID, `${LUNES} 06:58:00`);
  await fichar(M_SALIDA, `${LUNES} 09:59:55`); await fichar(USERID, `${LUNES} 10:00:00`);
  await fichar(M_REGRESO, `${LUNES} 10:59:55`); await fichar(USERID, `${LUNES} 11:00:00`);
  await fichar(USERID, `${LUNES} 13:41:00`);
  // Viernes: entra tarde con el marcador de permiso.
  await fichar(M_REGRESO, `${VIERNES} 08:59:55`); await fichar(USERID, `${VIERNES} 09:00:00`);
  await fichar(USERID, `${VIERNES} 13:41:00`);
});

after(async () => {
  await db.query('DELETE FROM salidas_autorizaciones WHERE tenant_id IN (?, ?)', [A, B]).catch(() => {});
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [A, B]);
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [A]);
  await quitarHorarioDeEmpresa(db, A);
  for (const uid of [UID_ADMIN, UID_ENCARGADO, UID_LECTOR, UID_B]) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('identidad: cada tipo de salida se reconoce por su hora real', () => {
  const t = (h, m) => new Date(2026, 4, 11, h, m);
  assert.deepEqual(autorizacion.identidad({ hasReturn: true, timeOut: t(10, 0), timeIn: t(11, 0), salidaMarkerUserId: 5 }), { tipo: 'salida', hora: '10:00' });
  assert.deepEqual(autorizacion.identidad({ hasReturn: true, timeOut: t(7, 0), timeIn: t(9, 0), salidaMarkerUserId: null }), { tipo: 'entrada', hora: '09:00' });
  assert.deepEqual(autorizacion.identidad({ hasReturn: false, timeOut: t(12, 30), timeIn: null, salidaMarkerUserId: 5 }), { tipo: 'sin_regreso', hora: '12:30' });
});

test('apagada (por defecto): todo como siempre', async () => {
  const r = await salidas();
  assert.equal(r.requiereAutorizacion, false);
  assert.equal(filaDe(r, LUNES).autorizacion.estado, null);
  assert.equal((await diaDetalle(VIERNES)).status, 'Late');
  assert.equal((await diaDetalle(VIERNES)).entradaParticular, undefined);
  assert.equal((await diaria(VIERNES)).entradaParticular, undefined, 'la vista diaria tampoco cambia');
});

test('solo quien puede cambiar la configuración la activa', async () => {
  assert.equal((await pedir(hLector, 'PUT', '/config/salidas-autorizacion', { requiere: true })).status, 403);
  const r = await pedir(hAdmin, 'PUT', '/config/salidas-autorizacion', { requiere: true });
  assert.equal(r.status, 200);
  const cfg = await (await pedir(hAdmin, 'GET', '/config/salidas-autorizacion')).json();
  assert.deepEqual(cfg, { requiere: true, migracion: true });
  const deB = await (await pedir(hB, 'GET', '/config/salidas-autorizacion')).json();
  assert.equal(deB.requiere, false, 'la otra empresa no queda afectada');
});

test('activada: las dos salidas quedan pendientes, y la entrada tarde sigue Tarde', async () => {
  const r = await salidas();
  assert.equal(r.requiereAutorizacion, true);
  const lunes = filaDe(r, LUNES);
  const viernes = filaDe(r, VIERNES);
  assert.deepEqual([lunes.autorizacion.tipo, lunes.autorizacion.hora, lunes.autorizacion.estado], ['salida', '10:00', 'pendiente']);
  assert.deepEqual([viernes.autorizacion.tipo, viernes.autorizacion.hora, viernes.autorizacion.estado], ['entrada', '09:00', 'pendiente']);
  assert.equal(r.summary.find((s) => String(s.employeeId) === String(LEGAJO)).pendientesDeAutorizar, 2);
  const dia = await diaDetalle(VIERNES);
  assert.equal(dia.status, 'Late');
  assert.equal(dia.entradaParticular.estado, 'pendiente');
  assert.equal((await diaria(VIERNES)).status, 'Late');
});

test('autorizar la entrada: queda quién y cuándo, y deja de ser Tarde (detalle y vista diaria)', async () => {
  const viernes = filaDe(await salidas(), VIERNES);
  const r = await pedir(hEncargado, 'POST', '/salidas/autorizaciones', { items: [item(viernes)], estado: 'autorizada', nota: 'Turno médico' });
  assert.equal(r.status, 200, await r.clone().text());
  const despues = filaDe(await salidas(), VIERNES).autorizacion;
  assert.equal(despues.estado, 'autorizada');
  assert.equal(despues.por, `${UID_ENCARGADO}@test.local`);
  assert.equal(despues.nota, 'Turno médico');
  assert.ok(despues.en);
  const dia = await diaDetalle(VIERNES);
  assert.equal(dia.status, 'LateJustified');
  assert.equal(dia.eventTypeDescripcion, 'Salida particular autorizada');
  const d = await diaria(VIERNES);
  assert.equal(d.status, 'LateJustified', 'la vista diaria dice lo mismo que el detalle');
  assert.equal(d.entradaParticular.estado, 'autorizada');
});

test('no autorizar y volver a pendiente', async () => {
  const lunes = filaDe(await salidas(), LUNES);
  assert.equal((await pedir(hAdmin, 'POST', '/salidas/autorizaciones', { items: [item(lunes)], estado: 'no_autorizada' })).status, 200);
  let r = await salidas();
  assert.equal(filaDe(r, LUNES).autorizacion.estado, 'no_autorizada');
  assert.equal(r.summary.find((s) => String(s.employeeId) === String(LEGAJO)).noAutorizadas, 1);
  assert.equal((await pedir(hAdmin, 'POST', '/salidas/autorizaciones', { items: [item(lunes)], estado: 'pendiente' })).status, 200);
  r = await salidas();
  assert.equal(filaDe(r, LUNES).autorizacion.estado, 'pendiente');
});

test('permisos, datos y aislamiento', async () => {
  const lunes = filaDe(await salidas(), LUNES);
  assert.equal((await pedir(hLector, 'POST', '/salidas/autorizaciones', { items: [item(lunes)], estado: 'autorizada' })).status, 403, 'solo mirar no alcanza');
  assert.equal((await pedir(hB, 'POST', '/salidas/autorizaciones', { items: [item(lunes)], estado: 'autorizada' })).status, 404, 'otra empresa no puede tocar a esta persona');
  assert.equal((await pedir(hAdmin, 'POST', '/salidas/autorizaciones', { items: [{ ...item(lunes), hora: '10' }], estado: 'autorizada' })).status, 400);
  assert.equal((await pedir(hAdmin, 'POST', '/salidas/autorizaciones', { items: [item(lunes)], estado: 'quizas' })).status, 400);
  assert.equal((await pedir(hAdmin, 'POST', '/salidas/autorizaciones', { items: [], estado: 'autorizada' })).status, 400);
});
