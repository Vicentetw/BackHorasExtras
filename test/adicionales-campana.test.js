// Adicionales de campaña (2026-10-13): módulo por empresa que prende el
// superadmin; noches en campaña y "más de 12 noches en 30 días corridos"
// (CCT 572/09 art. 33 B), con los números configurables por la empresa.
// Unidad (sin servidor) + extremo a extremo (backend local, tenant 999910).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const a = require('../motor-laboral/services/adicionalesCampana');

const d = (s) => new Date(s.replace(' ', 'T'));

test('noches: de lunes a viernes son 4; el mismo día, 0; sin regreso, hasta el día anterior al fin del período', () => {
  assert.equal(a.nochesDeCampana(d('2026-06-22 08:00'), d('2026-06-26 18:00'), '2026-06-30').length, 4);
  assert.equal(a.nochesDeCampana(d('2026-06-22 08:00'), d('2026-06-22 18:00'), '2026-06-30').length, 0);
  assert.deepEqual(a.nochesDeCampana(d('2026-06-28 08:00'), null, '2026-06-30'), ['2026-06-28', '2026-06-29']);
});

test('dedicación funcional: MÁS de 12 noches en 30 días corridos (12 no alcanza, 13 sí)', () => {
  const cfg = a.normalizarConfig({});
  const r = a.resumirNoches([
    { employeeId: '1', timeOut: d('2026-03-02 08:00'), timeIn: d('2026-03-15 18:00') }, // 13 noches
    { employeeId: '2', timeOut: d('2026-03-02 08:00'), timeIn: d('2026-03-14 18:00') }, // 12 noches
  ], '2026-03-01', '2026-03-31', cfg);
  const de = (id) => r.find((x) => x.employeeId === id);
  assert.equal(de('1').maxNochesEnVentana, 13);
  assert.equal(de('1').dedicacionFuncional, true);
  assert.equal(de('2').maxNochesEnVentana, 12);
  assert.equal(de('2').dedicacionFuncional, false);
});

test('la ventana es de días CORRIDOS y cruza meses: 7 noches a fin de mes + 7 al principio del siguiente = 14', () => {
  const cfg = a.normalizarConfig({});
  const r = a.resumirNoches([
    { employeeId: '1', timeOut: d('2026-03-24 08:00'), timeIn: d('2026-03-31 18:00') },
    { employeeId: '1', timeOut: d('2026-04-01 08:00'), timeIn: d('2026-04-08 18:00') },
  ], '2026-04-01', '2026-04-30', cfg);
  assert.equal(r[0].maxNochesEnVentana, 14);
  assert.equal(r[0].nochesEnPeriodo, 7, 'en abril, 7 noches');
  assert.equal(r[0].dedicacionFuncional, true);
});

test('los números son de cada empresa (y valores fuera de rango vuelven al de por defecto)', () => {
  assert.equal(a.normalizarConfig({ nochesParaDedicacion: 15, ventanaDias: 30, diasParaDesarraigoMayor: 20 }).nochesParaDedicacion, 15);
  assert.equal(a.normalizarConfig({ nochesParaDedicacion: 0 }).nochesParaDedicacion, 12);
});

// --- extremo a extremo ---
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999910;
const U = 8891000;
let hAdmin; let hSuper;
const req = (h, m, url, body) => fetch(BASE_URL + url, { method: m, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

async function limpiar() {
  for (const t of ['Checkins', 'specialusers', 'user_employee_map', 'users', 'employees']) await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [T]);
  await db.query("DELETE FROM app_settings WHERE tenant_id = ? AND name IN ('modulo_adicionales_campana', 'campanaAdicionales')", [T]);
}

before(async () => {
  await db.query("INSERT INTO tenants (id, name, code) VALUES (?, 'Adicionales campaña (test)', 'adicionales-campana') ON DUPLICATE KEY UPDATE name = VALUES(name)", [T]);
  await limpiar();
  for (const [leg, nombre] of [[1, 'Trece noches'], [2, 'Doce noches']]) {
    const [e] = await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, ?, ?, 1, '2020-01-01', 0)", [leg, nombre, T]);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [U + leg, T, String(leg), nombre]);
    await db.query("INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')", [U + leg, T, e.insertId]);
  }
  for (const [uid, badge, dir] of [[U + 98, '98', 'SALIDA'], [U + 97, '97', 'REGRESO']]) {
    await db.query("INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')", [uid, T, badge]);
    await db.query("INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', 'CAMPANA', ?, 1)", [uid, T, badge, dir]);
  }
  // Cada persona en su reloj ('a' y 'b'), para que nadie se lleve el marcador del otro.
  const f = (uid, t, ip) => [uid, T, t, ip];
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES ?', [[
    f(U + 98, '2026-03-02 07:59:55', 'a'), f(U + 1, '2026-03-02 08:00:00', 'a'),
    f(U + 97, '2026-03-15 17:59:55', 'a'), f(U + 1, '2026-03-15 18:00:00', 'a'),
    f(U + 98, '2026-03-02 08:00:05', 'b'), f(U + 2, '2026-03-02 08:00:10', 'b'),
    f(U + 97, '2026-03-14 17:59:50', 'b'), f(U + 2, '2026-03-14 18:00:00', 'b'),
  ]]);
  hAdmin = await getTestAuthHeaders('test-adic-camp-admin', { isSuperadmin: false, tenantId: T, permissions: ['attendance:read', 'schedules:read', 'schedules:update'] });
  hSuper = await getTestAuthHeaders('test-adic-camp-super', { isSuperadmin: true });
});

after(async () => {
  await limpiar();
  await deleteTestUser('test-adic-camp-admin');
  await deleteTestUser('test-adic-camp-super');
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

test('módulo apagado (por defecto): el reporte no agrega nada y el administrador no lo puede configurar', async () => {
  const r = await (await req(hAdmin, 'GET', '/campana-range?from=2026-03-01&to=2026-03-31')).json();
  assert.equal(r.adicionales, null);
  assert.ok(r.rows.length >= 2, 'las campañas igual se ven');
  assert.equal((await req(hAdmin, 'POST', '/config/campana-adicionales', { nochesParaDedicacion: 12, ventanaDias: 30, diasParaDesarraigoMayor: 20 })).status, 403);
  assert.equal((await (await req(hAdmin, 'GET', '/config/campana-adicionales')).json()).habilitado, false);
});

test('el administrador NO puede prender el módulo; el superadmin sí', async () => {
  assert.equal((await req(hAdmin, 'PUT', `/api/labor-engine/admin/tenants/${T}/modulos`, { adicionalesCampana: true })).status, 403);
  assert.equal((await req(hSuper, 'PUT', `/api/labor-engine/admin/tenants/${T}/modulos`, { adicionalesCampana: true })).status, 200);
});

test('módulo prendido: 13 noches -> dedicación funcional; 12 no. Y la empresa puede cambiar el número', async () => {
  const r = await (await req(hAdmin, 'GET', '/campana-range?from=2026-03-01&to=2026-03-31')).json();
  const de = (leg) => r.adicionales.porEmpleado.find((x) => String(x.employeeId) === String(leg));
  assert.equal(de(1).maxNochesEnVentana, 13);
  assert.equal(de(1).dedicacionFuncional, true);
  assert.equal(de(2).maxNochesEnVentana, 12);
  assert.equal(de(2).dedicacionFuncional, false);
  assert.equal((await req(hAdmin, 'POST', '/config/campana-adicionales', { nochesParaDedicacion: 11, ventanaDias: 30, diasParaDesarraigoMayor: 20 })).status, 200);
  const r2 = await (await req(hAdmin, 'GET', '/campana-range?from=2026-03-01&to=2026-03-31')).json();
  assert.equal(r2.adicionales.porEmpleado.find((x) => String(x.employeeId) === '2').dedicacionFuncional, true, 'con 11, las 12 noches ya alcanzan');
});
