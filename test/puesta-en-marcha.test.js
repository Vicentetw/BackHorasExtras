// Guía de puesta en marcha (routes/puestaEnMarcha.js): el avance se calcula
// con los datos de CADA empresa, y una empresa no ve los datos ni los tildes
// manuales de otra.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999911/999912), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const URL = `${BASE_URL}/api/puesta-en-marcha`;
const A = 999911;
const B = 999912;
const UID_A = 'test-puesta-a';
const UID_B = 'test-puesta-b';
const UID_LECTOR = 'test-puesta-lector';
let hA; let hB; let hLector;

const pedir = (h, method = 'GET', body) => fetch(URL + (method === 'PUT' ? '/manual' : ''), {
  method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString().slice(0, 19).replace('T', ' ');

async function cleanup() {
  for (const t of [A, B]) {
    for (const tabla of ['Checkins', 'user_employee_map', 'specialusers', 'users', 'employees', 'agent_sync_status']) {
      await db.query(`DELETE FROM ${tabla} WHERE tenant_id = ?`, [t]);
    }
    await db.query("DELETE FROM app_settings WHERE name = 'puestaEnMarchaManual' AND tenant_id = ?", [t]);
  }
}

before(async () => {
  for (const [id, code] of [[A, 'puesta-a'], [B, 'puesta-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await cleanup();
  hA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: A, permissions: ['settings:update', 'matching:read'] });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: B, permissions: ['settings:update'] });
  hLector = await getTestAuthHeaders(UID_LECTOR, { isSuperadmin: false, tenantId: A, permissions: ['attendance:read'] });

  // Empresa A: un empleado vinculado que ficha, una persona del reloj que
  // ficha y no está vinculada, un marcador (no cuenta), y alguien sin
  // vincular que fichó hace mucho (no cuenta: fuera de los 30 días).
  // El marcador tiene un número grande a propósito: antes solo se
  // descartaban los números del 1 al 10 y este aparecía como persona.
  const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (901911, 'Vinculado (test)', ?, '2020-01-01', 0, 1)`, [A]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
    [8891911, A, '901911', 'Vinculado (test)', 8891912, A, '8891912', 'Sin vincular (test)', 8891913, A, '8891913', 'Viejo (test)',
      8891914, A, '8891914', 'Marcador (test)']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [8891911, A, e.insertId]);
  await db.query("INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, isActive) VALUES (8891914, ?, '8891914', 'Marcador (test)', 'HE', 1)", [A]);
  for (const [u, d] of [[8891911, 2], [8891912, 3], [8891914, 1], [8891913, 90]]) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [u, A, hace(d)]);
  }
});

after(async () => {
  await cleanup();
  for (const uid of [UID_A, UID_B, UID_LECTOR]) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('el avance sale de los datos de la empresa: fichajes, empleados, y quién falta vincular', async () => {
  const r = await pedir(hA);
  assert.equal(r.status, 200);
  const { empresa, pasos } = await r.json();
  assert.equal(empresa, true);
  assert.equal(pasos.relojes.hecho, true, 'tiene fichajes');
  assert.equal(pasos.empleados.activos, 1);
  assert.equal(pasos.vincular.pendientes, 1, 'solo la persona que fichó hace poco y no está vinculada (ni el marcador ni la de hace 90 días)');
  assert.equal(pasos.vincular.hecho, false);
  assert.equal(pasos.horarios.sinHorario, 1);
});

test('Matching: un usuario cargado en Marcadores no es una persona, aunque su número sea grande', async () => {
  const aviso = await (await fetch(`${BASE_URL}/api/matching/punching-not-listed?dias=30`, { headers: hA })).json();
  assert.deepEqual(aviso.items.map((i) => i.clockUserId), [8891912], 'el aviso: solo la persona sin vincular');
  const sinAsociar = await (await fetch(`${BASE_URL}/api/matching/unmatched`, { headers: hA })).json();
  assert.deepEqual(sinAsociar.map((u) => u.USERID).sort(), [8891912, 8891913], '"Asociar a mano": sin el marcador');
  const diag = await (await fetch(`${BASE_URL}/api/matching/diagnosis/report`, { headers: hA })).json();
  assert.equal(diag.summary.total_users, 3, 'el resumen no cuenta al marcador');
  assert.equal(diag.summary.unmatched_users, 2);
});

test('aislamiento: la empresa B no ve nada de la A', async () => {
  const { pasos } = await (await pedir(hB)).json();
  assert.equal(pasos.relojes.hecho, false);
  assert.equal(pasos.empleados.activos, 0);
  assert.equal(pasos.vincular.pendientes, 0);
  assert.equal(pasos.vincular.hecho, false, 'sin fichajes ni empleados no puede estar "hecho"');
});

test('tildes manuales: se guardan por empresa, se pueden sacar, y solo pasos conocidos', async () => {
  let r = await pedir(hA, 'PUT', { paso: 'feriados', hecho: true });
  assert.equal(r.status, 200);
  assert.equal((await (await pedir(hA)).json()).pasos.feriados.hecho, true);
  assert.equal((await (await pedir(hB)).json()).pasos.feriados.hecho, false, 'el tilde de A no vale para B');

  r = await pedir(hA, 'PUT', { paso: 'feriados', hecho: false });
  assert.equal(r.status, 200);
  assert.equal((await (await pedir(hA)).json()).pasos.feriados.hecho, false);

  assert.equal((await pedir(hA, 'PUT', { paso: 'cualquiera', hecho: true })).status, 400);
});

test('marcar un paso pide permiso de configuración; ver el avance no', async () => {
  assert.equal((await pedir(hLector)).status, 200);
  assert.equal((await pedir(hLector, 'PUT', { paso: 'motivos', hecho: true })).status, 403);
});
