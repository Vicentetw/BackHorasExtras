// Superadmin "trabajando en una empresa" (modo soporte) + registro de
// actividad + feriado en varias empresas (2026-10-09).
//
// Lo que se prueba:
//  - con la cabecera X-Empresa-Trabajo el superadmin ve y toca SOLO esa
//    empresa (empleados, feriados), como un administrador de ella;
//  - lo que crea queda en ESA empresa (no global, no en otra);
//  - la cabecera no le sirve de nada a un usuario común;
//  - en modo soporte no puede usar lo de plataforma (crear empresas);
//  - todo cambio queda en el registro de actividad con su autor, y si fue
//    "como soporte"; cada empresa ve solo su registro;
//  - el feriado en varias empresas crea una copia en cada una, saltea la que
//    ya tenía ese día, y deja el registro en cada empresa.
// Requiere el backend local (puerto 3000). Tenants descartables 999901/999902, NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999901;
const B = 999902;
let hSuper; let hAdminA; let hAdminB; let hayTabla;

const req = (h, method, url, body, extra = {}) => fetch(`${BASE_URL}${url}`, {
  method, headers: { ...h, ...extra, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const enA = { 'X-Empresa-Trabajo': String(A) };

async function limpiar() {
  for (const t of [A, B]) {
    await db.query('DELETE FROM holidays WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM registro_actividad WHERE tenant_id = ?', [t]).catch(() => {});
  }
}

before(async () => {
  for (const [id, code] of [[A, 'soporte-a'], [B, 'soporte-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `Soporte ${code} (test)`, code]);
  }
  await limpiar();
  hSuper = await getTestAuthHeaders('test-soporte-super', { isSuperadmin: true });
  hAdminA = await getTestAuthHeaders('test-soporte-admin-a', { isSuperadmin: false, tenantId: A });
  hAdminB = await getTestAuthHeaders('test-soporte-admin-b', { isSuperadmin: false, tenantId: B });
  await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (901001, 'Empleada de A (test)', ?, '2020-01-01', 0, 1), (902001, 'Empleado de B (test)', ?, '2020-01-01', 0, 1)", [A, B]);
  hayTabla = (await db.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'registro_actividad'"))[0][0].n > 0;
});

after(async () => {
  await limpiar();
  for (const u of ['test-soporte-super', 'test-soporte-admin-a', 'test-soporte-admin-b']) await deleteTestUser(u);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

// El registro se guarda al terminar la respuesta: se espera un instante.
const esperarRegistro = () => new Promise((r) => setTimeout(r, 300));

test('/me en modo soporte: es administrador de A, no superadmin, y lo sabe', async () => {
  const me = await (await req(hSuper, 'GET', '/api/app-users/me', null, enA)).json();
  assert.equal(me.tenantId, A);
  assert.equal(me.isSuperadmin, false);
  assert.equal(me.superadminReal, true);
  assert.equal(me.soporte.empresaId, A);
  assert.ok(me.permissions.includes('holidays:create'));
  const sin = await (await req(hSuper, 'GET', '/api/app-users/me')).json();
  assert.equal(sin.isSuperadmin, true);
  assert.equal(sin.soporte, null);
});

test('en modo soporte ve SOLO los empleados de A', async () => {
  const r = await req(hSuper, 'GET', '/api/employees?limit=500', null, enA);
  assert.equal(r.status, 200);
  const texto = await r.text();
  assert.match(texto, /Empleada de A/);
  assert.doesNotMatch(texto, /Empleado de B/);
  // Aunque pida ?tenantId= de otra empresa, manda la empresa de trabajo.
  const otra = await (await req(hSuper, 'GET', `/api/employees?limit=500&tenantId=${B}`, null, enA)).text();
  assert.doesNotMatch(otra, /Empleado de B/);
});

test('un feriado creado en modo soporte queda en A (sin elegir nada) y B no lo ve', async () => {
  const r = await req(hSuper, 'POST', '/api/holidays', { date: '2026-11-20', name: 'Feriado soporte (test)' }, enA);
  assert.equal(r.status, 200, await r.clone().text());
  const [[h]] = await db.query("SELECT tenant_id FROM holidays WHERE name = 'Feriado soporte (test)'");
  assert.equal(h.tenant_id, A);
  const deB = await (await req(hAdminB, 'GET', '/api/holidays?year=2026')).text();
  assert.doesNotMatch(deB, /Feriado soporte/);
  // Aunque mande tenant_id de B en el cuerpo, queda en A.
  await req(hSuper, 'POST', '/api/holidays', { date: '2026-11-21', name: 'Intento a B (test)', tenant_id: B }, enA);
  const [[h2]] = await db.query("SELECT tenant_id FROM holidays WHERE name = 'Intento a B (test)'");
  assert.equal(h2.tenant_id, A);
});

test('la cabecera no le sirve a un usuario común', async () => {
  const me = await (await req(hAdminB, 'GET', '/api/app-users/me', null, enA)).json();
  assert.equal(me.tenantId, B);
  assert.equal(me.soporte, null);
  const emp = await (await req(hAdminB, 'GET', '/api/employees?limit=500', null, enA)).text();
  assert.doesNotMatch(emp, /Empleada de A/);
});

test('empresa de trabajo inexistente: 400, no cae en modo plataforma', async () => {
  const r = await req(hSuper, 'GET', '/api/employees', null, { 'X-Empresa-Trabajo': '987654321' });
  assert.equal(r.status, 400);
  const basura = await req(hSuper, 'GET', '/api/employees', null, { 'X-Empresa-Trabajo': 'abc' });
  assert.equal(basura.status, 400);
});

test('en modo soporte no se usa lo de plataforma; sin la cabecera, sí', async () => {
  const r = await req(hSuper, 'GET', '/api/labor-engine/admin/tenants', null, enA);
  assert.equal(r.status, 403);
  const ok = await req(hSuper, 'GET', '/api/labor-engine/admin/tenants');
  assert.equal(ok.status, 200);
});

test('registro de actividad: autor, empresa y "como soporte"; cada empresa ve lo suyo', async (t) => {
  if (!hayTabla) {
    // Sin la migración: la pantalla avisa, no falla.
    const r = await (await req(hAdminA, 'GET', '/api/registro-actividad')).json();
    assert.equal(r.faltaMigracion, true);
    return t.skip('falta la migración 20261017 en la base local');
  }
  await req(hAdminA, 'POST', '/api/holidays', { date: '2026-11-23', name: 'Feriado del admin (test)' });
  await esperarRegistro();
  const [filas] = await db.query("SELECT email, como_soporte, descripcion, estado, detalle FROM registro_actividad WHERE tenant_id = ? AND ruta = '/api/holidays' ORDER BY id", [A]);
  const soporte = filas.find((f) => /Feriado soporte/.test(f.detalle));
  assert.ok(soporte, 'quedó registrado el feriado del soporte');
  assert.equal(soporte.como_soporte, 1);
  assert.equal(soporte.email, 'test-soporte-super@test.local');
  assert.equal(soporte.descripcion, 'Creó/cargó un feriado');
  assert.equal(soporte.estado, 200);
  const admin = filas.find((f) => /Feriado del admin/.test(f.detalle));
  assert.equal(admin.como_soporte, 0);
  assert.equal(admin.email, 'test-soporte-admin-a@test.local');

  // El admin de A lo ve (incluido lo del soporte); el de B no ve nada de A.
  const deA = await (await req(hAdminA, 'GET', '/api/registro-actividad?soloSoporte=1')).json();
  assert.ok(deA.filas.length >= 1);
  assert.ok(deA.filas.every((f) => f.tenant_id === A && f.como_soporte === 1));
  const deB = await (await req(hAdminB, 'GET', '/api/registro-actividad')).json();
  assert.ok(deB.filas.every((f) => f.tenant_id === B));
  assert.doesNotMatch(JSON.stringify(deB), /Feriado soporte|Feriado del admin/);
});

test('el registro no guarda contraseñas ni tokens', async (t) => {
  if (!hayTabla) return t.skip('falta la migración 20261017 en la base local');
  await req(hAdminA, 'POST', '/api/holidays', { date: '2026-11-24', name: 'Con secreto (test)', password: 'NoDebeQuedar123', token: 'tok-secreto' });
  await esperarRegistro();
  const [[f]] = await db.query("SELECT detalle FROM registro_actividad WHERE tenant_id = ? AND detalle LIKE '%Con secreto%'", [A]);
  assert.ok(f);
  assert.doesNotMatch(f.detalle, /NoDebeQuedar123|tok-secreto/);
  assert.match(f.detalle, /\[oculto\]/);
});

test('feriado en varias empresas: una copia en cada una, saltea la que ya lo tenía', async (t) => {
  await db.query("INSERT INTO holidays (tenant_id, date, year, name, type) VALUES (?, '2026-12-07', 2026, 'Ya estaba (test)', 'NATIONAL')", [B]);
  const r = await req(hSuper, 'POST', '/api/holidays/varias-empresas', { date: '2026-12-07', name: 'Puente (test)', tenantIds: [A, B, 987654321] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.creados.map((c) => c.tenantId), [A]);
  assert.deepEqual(j.salteados.map((s) => s.tenantId).sort(), [B, 987654321].sort());
  const [filas] = await db.query("SELECT tenant_id FROM holidays WHERE name = 'Puente (test)'");
  assert.deepEqual(filas.map((f) => f.tenant_id), [A]);

  // Solo el superadmin en modo plataforma; ni un admin ni el soporte.
  assert.equal((await req(hAdminA, 'POST', '/api/holidays/varias-empresas', { date: '2026-12-08', name: 'x', tenantIds: [A, B] })).status, 403);
  assert.equal((await req(hSuper, 'POST', '/api/holidays/varias-empresas', { date: '2026-12-08', name: 'x', tenantIds: [A, B] }, enA)).status, 403);

  if (!hayTabla) return t.skip('falta la migración 20261017: no se revisa el registro');
  const deA = await (await req(hAdminA, 'GET', '/api/registro-actividad?texto=Puente')).json();
  assert.equal(deA.filas.length, 1);
  assert.match(deA.filas[0].descripcion, /superadmin en varias empresas/);
  assert.equal(deA.filas[0].email, 'test-soporte-super@test.local');
  assert.equal(deA.filas[0].como_soporte, 1);
  // La hora viaja en UTC (con Z), para que cada pantalla la muestre en su hora local.
  assert.match(deA.filas[0].creado_en, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const segundos = Math.abs(Date.now() - Date.parse(deA.filas[0].creado_en)) / 1000;
  assert.ok(segundos < 120, `la hora registrada está corrida ${segundos}s`);
});
