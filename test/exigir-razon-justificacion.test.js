// "Exigir razón al justificar" (opción por empresa, 2026-10-09).
// - Apagada por defecto: se puede justificar sin razón, como siempre.
// - Encendida: crear (un día o rango) o modificar sin razón -> 400; con razón, anda.
// - Es de cada empresa: prenderla en A no cambia nada en B.
// Requiere el backend local (puerto 3000). Tenants descartables 999903/999904.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999903;
const B = 999904;
const USER_A = 8890301;
const USER_B = 8890401;
const PERMS = ['exclusions:read', 'exclusions:create', 'exclusions:update', 'exclusions:delete', 'schedules:read', 'schedules:update'];
let hA; let hB;

const req = (h, method, url, body) => fetch(`${BASE_URL}${url}`, {
  method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

async function limpiar() {
  for (const t of [A, B]) {
    await db.query('DELETE FROM user_exclusion_log WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query("DELETE FROM app_settings WHERE tenant_id = ? AND name = 'exigirRazonJustificacion'", [t]).catch(() => {});
  }
}

before(async () => {
  for (const [id, code] of [[A, 'razon-a'], [B, 'razon-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `Razon ${code} (test)`, code]);
  }
  await limpiar();
  await db.query("INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '903001', 'Razon A'), (?, ?, '904001', 'Razon B')", [USER_A, A, USER_B, B]);
  hA = await getTestAuthHeaders('test-razon-a', { isSuperadmin: false, tenantId: A, permissions: PERMS });
  hB = await getTestAuthHeaders('test-razon-b', { isSuperadmin: false, tenantId: B, permissions: PERMS });
});

after(async () => {
  await limpiar();
  await deleteTestUser('test-razon-a');
  await deleteTestUser('test-razon-b');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('apagada por defecto: se justifica sin razón como siempre', async () => {
  const op = await (await req(hA, 'GET', '/config/exigir-razon-justificacion')).json();
  assert.equal(op.exigirRazonJustificacion, false);
  const r = await req(hA, 'POST', '/config/user-exclusions', { userId: USER_A, excDate: '2099-03-01', type: 'FULL_DAY' });
  assert.equal(r.status, 200, await r.clone().text());
});

test('encendida: sin razón se rechaza (día, rango y edición); con razón anda', async () => {
  assert.equal((await req(hA, 'POST', '/config/exigir-razon-justificacion', { exigirRazonJustificacion: true })).status, 200);
  assert.equal((await (await req(hA, 'GET', '/config/exigir-razon-justificacion')).json()).exigirRazonJustificacion, true);

  const sinRazon = await req(hA, 'POST', '/config/user-exclusions', { userId: USER_A, excDate: '2099-03-02', type: 'HALF_DAY', excTo: '08:30:00', reason: '   ' });
  assert.equal(sinRazon.status, 400);
  assert.match((await sinRazon.json()).error, /razón/);
  const rango = await req(hA, 'POST', '/config/user-exclusions/range', { userId: USER_A, dateFrom: '2099-03-03', dateTo: '2099-03-04', type: 'FULL_DAY' });
  assert.equal(rango.status, 400);
  const [[n]] = await db.query("SELECT COUNT(*) n FROM userexclusions WHERE tenant_id = ? AND excDate BETWEEN '2099-03-02' AND '2099-03-04'", [A]);
  assert.equal(n.n, 0, 'no se creó nada');

  // Editar la de antes (sin razón) exige agregarla.
  const [[vieja]] = await db.query("SELECT id FROM userexclusions WHERE tenant_id = ? AND excDate = '2099-03-01'", [A]);
  assert.equal((await req(hA, 'PUT', `/config/user-exclusions/${vieja.id}`, { type: 'FULL_DAY' })).status, 400);
  assert.equal((await req(hA, 'PUT', `/config/user-exclusions/${vieja.id}`, { type: 'FULL_DAY', reason: 'Turno médico' })).status, 200);

  const conRazon = await req(hA, 'POST', '/config/user-exclusions', { userId: USER_A, excDate: '2099-03-02', type: 'HALF_DAY', excTo: '08:30:00', reason: 'Corte de ruta' });
  assert.equal(conRazon.status, 200);
});

test('es de cada empresa: en B sigue apagada', async () => {
  assert.equal((await (await req(hB, 'GET', '/config/exigir-razon-justificacion')).json()).exigirRazonJustificacion, false);
  const r = await req(hB, 'POST', '/config/user-exclusions', { userId: USER_B, excDate: '2099-03-01', type: 'FULL_DAY' });
  assert.equal(r.status, 200);
});

test('apagarla vuelve a permitir sin razón', async () => {
  await req(hA, 'POST', '/config/exigir-razon-justificacion', { exigirRazonJustificacion: false });
  const r = await req(hA, 'POST', '/config/user-exclusions', { userId: USER_A, excDate: '2099-03-05', type: 'FULL_DAY' });
  assert.equal(r.status, 200);
});
