// Usuarios limitados a algunas áreas (2026-10-26, punto Q; alcance.js).
// Requiere la migración 20261025_areas y el backend local (puerto 3000).
// Una empresa descartable (998103) con tres personas: dos en "Depósito" y una
// en "Ventas". El supervisor ve solo Depósito: en NINGUNA pantalla tiene que
// aparecer la de Ventas (marca única ZZVENTAS), y no la puede tocar.
// Un usuario sin áreas (y el administrador) siguen viendo a todos.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 998103;
const DIA = '2026-05-04'; // lunes
const MES = '2026-05';
const UIDS = ['aa-admin', 'aa-supervisor', 'aa-sin-areas'];
const SUPERVISOR = ['attendance:read', 'attendance:create', 'employees:read', 'schedules:read', 'exclusions:read', 'exclusions:create',
  'exclusions:update', 'leaves:read', 'leaves:create', 'leaves:update', 'holidays:read', 'salidas:update'];
// [legajo, nombre, USERID, área]
const PERSONAS = [[99810301, 'DEPOSITO UNO', 99810301, 'Depósito'], [99810302, 'DEPOSITO DOS', 99810302, 'Depósito'], [99810303, 'ZZVENTAS TRES', 99810303, 'Ventas']];
let hAdmin; let hSup; let hSinAreas; let area = {}; let emp = {};

const pedir = (h, metodo, ruta, body) => fetch(`${URL}${ruta}`, {
  method: metodo, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const idDe = async (uid) => (await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [uid]))[0][0].id;

async function limpiar() {
  await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM employee_events WHERE employee_id IN (SELECT id FROM employees WHERE tenant_id = ?)', [T]);
  await db.query('DELETE FROM employee_leave_balances WHERE employee_id IN (SELECT id FROM employees WHERE tenant_id = ?)', [T]);
  await db.query('DELETE FROM app_user_areas WHERE user_id IN (SELECT id FROM app_users WHERE tenant_id = ?)', [T]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM areas WHERE tenant_id = ?', [T]);
}

before(async () => {
  await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [T, 'Áreas (test)', 'alcance-areas-test']);
  await limpiar();
  for (const n of ['Depósito', 'Ventas']) area[n] = (await db.query('INSERT INTO areas (tenant_id, nombre) VALUES (?, ?)', [T, n]))[0].insertId;
  for (const [legajo, nombre, userId, a] of PERSONAS) {
    const [e] = await db.query('INSERT INTO employees (employee_id, nombre, documento, tenant_id, activo, fecha_alta, area_id) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [legajo, nombre, `DOC${legajo}`, T, '2020-01-01', area[a]]);
    emp[legajo] = e.insertId;
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, T, String(legajo), nombre]);
    await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [userId, T, e.insertId, 'manual']);
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)',
      [userId, T, `${DIA} 07:05:00`, userId, T, `${DIA} 10:00:00`, userId, T, `${DIA} 10:40:00`, userId, T, `${DIA} 15:10:00`]);
    await db.query('INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, ?)', [userId, T, DIA, `JUSTIF ${nombre}`, 'LLEGADA_TARDE']);
  }
  hAdmin = await getTestAuthHeaders('aa-admin', { isSuperadmin: false, tenantId: T });
  hSup = await getTestAuthHeaders('aa-supervisor', { isSuperadmin: false, tenantId: T, permissions: SUPERVISOR });
  hSinAreas = await getTestAuthHeaders('aa-sin-areas', { isSuperadmin: false, tenantId: T, permissions: SUPERVISOR });
  await db.query('INSERT INTO app_user_areas (user_id, area_id) VALUES (?, ?)', [await idDe('aa-supervisor'), area['Depósito']]);
});

after(async () => {
  await limpiar();
  for (const u of UIDS) await deleteTestUser(u);
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

// Todas las pantallas que un supervisor puede abrir, con lo que piden.
const LECTURAS = [
  '/api/employees?limit=0', '/api/employees/stats',
  `/attendance-range?from=${DIA}&to=${DIA}`, `/attendance-range?from=${DIA}&to=${DIA}&employeeId=99810303`,
  `/api/labor-engine/attendance/${DIA}`, `/api/fichajes-del-dia?fecha=${DIA}`,
  `/movements-range?from=${DIA}&to=${DIA}&category=PARTICULAR`, `/movements-range?from=${DIA}&to=${DIA}&category=OFICIAL&groupBy=month`,
  `/campana-range?from=${DIA}&to=${DIA}`, '/config/user-exclusions?limit=100', '/api/employee-events', `/api/leave-balances?year=2026`,
  `/api/liquidacion-horas-extra?periodo=${MES}`, `/api/horas-extra-revisar?from=${DIA}&to=${DIA}`,
  '/api/labor-engine/admin/employees', '/api/config-horas-extra/autorizados', '/api/manual-checkins', '/api/event-types/cupos/estado',
];

test('el supervisor limitado a Depósito no ve a nadie de Ventas en ninguna pantalla', async () => {
  for (const ruta of LECTURAS) {
    const r = await pedir(hSup, 'GET', ruta);
    const texto = await r.text();
    assert.ok(r.status === 200, `${ruta} respondió ${r.status}: ${texto.slice(0, 200)}`);
    assert.ok(!/ZZVENTAS|99810303/.test(texto), `${ruta} dejó ver a alguien de Ventas: ${texto.slice(0, 300)}`);
  }
});

test('sí ve a su gente, y los totales son solo de sus áreas', async () => {
  const empleados = await (await pedir(hSup, 'GET', '/api/employees?limit=0')).json();
  assert.deepEqual(empleados.data.map((e) => e.employee_id).sort(), [99810301, 99810302]);
  assert.equal(empleados.pagination.total, 2);
  assert.equal((await (await pedir(hSup, 'GET', '/api/employees/stats')).json()).total, 2);
  const dia = await (await pedir(hSup, 'GET', `/api/labor-engine/attendance/${DIA}`)).json();
  assert.equal(dia.attendance.length, 2);
  assert.equal(dia.summary.total, 2, 'el resumen del día cuenta solo a su gente');
  const mes = await (await pedir(hSup, 'GET', `/attendance-range?from=${DIA}&to=${DIA}`)).json();
  assert.equal(mes.data.length, 2);
  const just = await (await pedir(hSup, 'GET', '/config/user-exclusions?limit=100')).json();
  assert.equal(just.pagination.total, 2, 'la paginación de justificaciones cuenta solo las suyas');
});

test('sin áreas (y el administrador) se ve a todos, como siempre', async () => {
  for (const h of [hSinAreas, hAdmin]) {
    const empleados = await (await pedir(h, 'GET', '/api/employees?limit=0')).json();
    assert.equal(empleados.data.length, 3);
    const dia = await (await pedir(h, 'GET', `/api/labor-engine/attendance/${DIA}`)).json();
    assert.equal(dia.attendance.length, 3);
  }
});

test('no puede tocar a alguien de otra área; a los suyos sí', async () => {
  const ajeno = await pedir(hSup, 'POST', '/config/user-exclusions', { userId: 99810303, excDate: DIA, reason: 'x', type: 'LLEGADA_TARDE' });
  assert.equal(ajeno.status, 403);
  assert.equal((await ajeno.json()).codigo, 'AREA_AJENA');
  const propio = await pedir(hSup, 'POST', '/config/user-exclusions', { userId: 99810301, excDate: '2026-05-05', reason: 'turno médico', type: 'LLEGADA_TARDE' });
  assert.notEqual(propio.status, 403, await propio.text());
  const [[j]] = await db.query('SELECT id FROM userexclusions WHERE tenant_id = ? AND userId = 99810303', [T]);
  assert.equal((await pedir(hSup, 'DELETE', `/config/user-exclusions/${j.id}`)).status, 403);
  assert.equal((await pedir(hSup, 'GET', `/api/fichajes-persona?legajo=99810303&from=${DIA}&to=${DIA}`)).status, 403);
  assert.equal((await pedir(hSup, 'GET', `/api/fichajes-persona?legajo=99810301&from=${DIA}&to=${DIA}`)).status, 200);
  assert.equal((await pedir(hSup, 'POST', '/api/employee-events', { employeeId: emp[99810303], eventTypeId: 1, fechaDesde: DIA, fechaHasta: DIA })).status, 403);
  assert.equal((await pedir(hSup, 'POST', '/api/manual-checkins', { entries: [{ employeeId: 99810301 }, { employeeId: 99810303 }] })).status, 403,
    'si una sola persona del pedido es ajena, no se hace nada');
  assert.equal((await pedir(hSup, 'POST', '/salidas/autorizaciones', { items: [{ legajo: 99810303, fecha: DIA, tipo: 'PARTICULAR', hora: '10:00' }], estado: 'AUTORIZADA' })).status, 403);
});

test('lo que es de toda la empresa queda cerrado para un usuario limitado (lista blanca)', async () => {
  for (const [m, ruta] of [['GET', '/api/app-users'], ['GET', '/api/roles'], ['GET', '/config/excluded-users'], ['GET', '/config/special-users'],
    ['GET', '/api/labor-engine/admin/calendar-assignments/vigentes'], ['GET', '/api/matching/diagnosis/report'], ['POST', '/import/checkins'],
    ['POST', '/api/liquidacion-horas-extra/cierres'], ['POST', '/config/theme'], ['GET', '/api/registro-actividad'], ['GET', '/una/ruta/que/no/existe']]) {
    const r = await pedir(hSup, m, ruta, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 403, `${m} ${ruta} debería estar cerrada y respondió ${r.status}`);
  }
});

test('/me dice qué áreas ve', async () => {
  const yo = await (await pedir(hSup, 'GET', '/api/app-users/me')).json();
  assert.deepEqual(yo.areas.map((a) => a.nombre), ['Depósito']);
  assert.equal((await (await pedir(hSinAreas, 'GET', '/api/app-users/me')).json()).areas, null);
});

test('áreas: un administrador no se limita, y no se borra un área que limita a alguien', async () => {
  const idAdmin = await idDe('aa-admin');
  const r = await pedir(hAdmin, 'PUT', `/api/app-users/${await idDe('aa-sin-areas')}`, { areas: [area.Ventas] });
  assert.equal(r.status, 200, await r.text());
  const yo = await (await pedir(hSinAreas, 'GET', '/api/app-users/me')).json();
  assert.deepEqual(yo.areas.map((a) => a.nombre), ['Ventas']);
  assert.equal((await pedir(hAdmin, 'PUT', `/api/app-users/${await idDe('aa-sin-areas')}`, { areas: [] })).status, 200);

  // aa-admin tiene todos los permisos (incluye administrar usuarios).
  const otro = await pedir(hAdmin, 'PUT', `/api/app-users/${await idDe('aa-supervisor')}`, { areas: [area.Ventas], permissions: [...SUPERVISOR, 'users:update'] });
  assert.equal(otro.status, 400);
  assert.ok(idAdmin);

  const borrar = await pedir(hAdmin, 'DELETE', `/api/areas/${area['Depósito']}`);
  assert.equal(borrar.status, 409, 'el supervisor ve solo Depósito: borrarla le daría toda la empresa');
});

test('áreas: crear, renombrar y asignar empleados en bloque', async () => {
  const c = await pedir(hAdmin, 'POST', '/api/areas', { nombre: 'Logística' });
  assert.equal(c.status, 200);
  const { id } = await c.json();
  assert.equal((await pedir(hAdmin, 'POST', '/api/areas', { nombre: 'Logística' })).status, 409);
  assert.equal((await pedir(hAdmin, 'PUT', `/api/areas/${id}`, { nombre: 'Logística y envíos' })).status, 200);
  const a = await pedir(hAdmin, 'PUT', '/api/areas/asignar/empleados', { employeeIds: [emp[99810302]], areaId: id });
  assert.equal((await a.json()).actualizados, 1);
  const lista = await (await pedir(hAdmin, 'GET', '/api/areas')).json();
  assert.equal(lista.areas.find((x) => x.id === id).empleados, 1);
  // El supervisor (Depósito) ya no ve al que pasó a Logística.
  const empleados = await (await pedir(hSup, 'GET', '/api/employees?limit=0')).json();
  assert.deepEqual(empleados.data.map((e) => e.employee_id), [99810301]);
  // Ni las áreas las puede tocar un limitado.
  assert.equal((await pedir(hSup, 'POST', '/api/areas', { nombre: 'Mía' })).status, 403);
});
