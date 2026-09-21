// Aislamiento del horario de empresa (`companyschedule`).
//
// POR QUE ESTE ARCHIVO EXISTE
// ---------------------------
// Hasta la migracion 20260928, `companyschedule` no tenia `tenant_id` y su
// clave unica era `scheduleDate` A SECAS. Consecuencias:
//
//   1. el horario de una empresa lo leian todas las demas;
//   2. como la fecha era unica globalmente, si la empresa A guardaba el
//      horario del 15/03, la empresa B NO podia tener uno distinto: el
//      ON DUPLICATE KEY UPDATE del endpoint le pisaba el de A.
//
// Y no es cosmetico: `/attendance-range` usa esta tabla como respaldo cuando
// un empleado no tiene plantilla, asi que alimenta el calculo de asistencia
// y de horas extra. Con un solo cliente no se notaba; con dos, una empresa
// le cambia las liquidaciones a la otra.
//
// Era el ultimo bloqueante identificado para poder vender el sistema a mas
// de una empresa.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999925;
const TENANT_B = 999926;
const UID_A = 'test-company-schedule-a';
const UID_B = 'test-company-schedule-b';
const UID_SIN_PERMISO = 'test-company-schedule-sin-permiso';
const FECHA = '2099-06-15';

let headersA, headersB, headersSinPermiso;

async function cleanup() {
  await db.query('DELETE FROM companyschedule WHERE scheduleDate = ?', [FECHA]);
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_A, 'Tenant Schedule A (test)', 'tenant-schedule-a-test'],
    [TENANT_B, 'Tenant Schedule B (test)', 'tenant-schedule-b-test']
  ]) {
    await db.query(
      'INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [id, name, code]
    );
  }
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B });
  headersSinPermiso = await getTestAuthHeaders(UID_SIN_PERMISO, {
    isSuperadmin: false, tenantId: TENANT_A, permissions: []
  });
  await cleanup();
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await deleteTestUser(UID_SIN_PERMISO);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('leer el horario exige permiso', async () => {
  // Antes esta ruta no tenia ningun requirePermission: cualquier usuario
  // logueado, sin permisos, podia leer la configuracion de la empresa.
  const res = await fetch(`${BASE_URL}/config/schedule/${FECHA}`, { headers: headersSinPermiso });
  assert.equal(res.status, 403);
});

test('dos empresas pueden tener horarios DISTINTOS para el mismo día', async () => {
  // Esto era directamente imposible antes: la clave unica era la fecha sola.
  const guardarA = await fetch(`${BASE_URL}/config/schedule`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduleDate: FECHA, timeEntrance: '08:00:00', timeExit: '16:00:00', isWorkDay: 1, description: 'Horario de A' })
  });
  assert.equal(guardarA.status, 200, JSON.stringify(await guardarA.clone().json()));

  const guardarB = await fetch(`${BASE_URL}/config/schedule`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduleDate: FECHA, timeEntrance: '06:00:00', timeExit: '14:00:00', isWorkDay: 1, description: 'Horario de B' })
  });
  assert.equal(guardarB.status, 200, JSON.stringify(await guardarB.clone().json()));

  const [filas] = await db.query('SELECT tenant_id, timeEntrance FROM companyschedule WHERE scheduleDate = ? ORDER BY tenant_id', [FECHA]);
  assert.equal(filas.length, 2, 'cada empresa debe tener su propia fila');
});

test('cada empresa lee SU horario, no el de la otra', async () => {
  const a = await (await fetch(`${BASE_URL}/config/schedule/${FECHA}`, { headers: headersA })).json();
  const b = await (await fetch(`${BASE_URL}/config/schedule/${FECHA}`, { headers: headersB })).json();

  assert.equal(a.timeEntrance, '08:00:00');
  assert.equal(a.description, 'Horario de A');
  assert.equal(b.timeEntrance, '06:00:00');
  assert.equal(b.description, 'Horario de B');
});

test('guardar de nuevo pisa SOLO la fila propia', async () => {
  // El caso concreto del bug viejo: A volvia a guardar y le cambiaba el
  // horario a B, porque el ON DUPLICATE KEY UPDATE daba contra la misma fila.
  const res = await fetch(`${BASE_URL}/config/schedule`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduleDate: FECHA, timeEntrance: '09:30:00', timeExit: '17:30:00', isWorkDay: 1, description: 'A corregido' })
  });
  assert.equal(res.status, 200);

  const a = await (await fetch(`${BASE_URL}/config/schedule/${FECHA}`, { headers: headersA })).json();
  const b = await (await fetch(`${BASE_URL}/config/schedule/${FECHA}`, { headers: headersB })).json();
  assert.equal(a.timeEntrance, '09:30:00', 'A debe ver su cambio');
  assert.equal(b.timeEntrance, '06:00:00', 'B NO debe haberse modificado');

  const [filas] = await db.query('SELECT id FROM companyschedule WHERE scheduleDate = ?', [FECHA]);
  assert.equal(filas.length, 2, 'debe seguir habiendo una fila por empresa');
});

test('una empresa sin horario propio cae en el valor por defecto', async () => {
  const otraFecha = '2099-06-16';
  const res = await fetch(`${BASE_URL}/config/schedule/${otraFecha}`, { headers: headersA });
  const json = await res.json();
  assert.equal(res.status, 200);
  // Sin fila propia ni global, responde el default histórico del endpoint.
  assert.equal(json.timeEntrance, '07:00:00');
});

test('el tema también exige permiso ahora', async () => {
  const leer = await fetch(`${BASE_URL}/config/theme`, { headers: headersSinPermiso });
  assert.equal(leer.status, 403);

  const guardar = await fetch(`${BASE_URL}/config/theme`, {
    method: 'POST',
    headers: { ...headersSinPermiso, 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' })
  });
  assert.equal(guardar.status, 403);
});
