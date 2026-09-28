// Cupo por motivo, de punta a punta por la API: configurar el tope, ver el
// consumo, y que la carga de justificaciones y licencias lo respete.
// Las reglas finas del calculo estan en cupo-motivos.test.js.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999961/999962), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999961;
const OTRA = 999962;
const UID = 'test-cupo-motivos';
const UID_OTRA = 'test-cupo-motivos-otra';
const USERID = 8890111;
const LEGAJO = 900811;

// Lunes a viernes de la primera semana de marzo 2099 (fuera de cualquier dato real).
const D1 = '2099-03-02';
const D2_FICHO = '2099-03-03';
const D3 = '2099-03-04';
const D4 = '2099-03-05';

let headers;
let headersOtra;
let empId;
let art55;

const json = (method, body, h = headers) => ({ method, headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const justificar = (fecha) => fetch(`${BASE_URL}/config/user-exclusions`, json('POST', { userId: USERID, excDate: fecha, type: 'FULL_DAY', eventTypeId: art55 }));
const consumo = async (qs = '') => (await fetch(`${BASE_URL}/api/event-types/${art55}/consumo?employeeId=${empId}&fecha=${D1}${qs}`, { headers })).json();

async function cleanup() {
  await db.query('DELETE FROM user_exclusion_log WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE ee FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE e.tenant_id = ?', [TENANT]);
  await db.query('DELETE q FROM event_type_quotas q WHERE q.tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM event_types WHERE tenant_id = ?', [TENANT]);
  for (const t of ['Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [TENANT]);
  }
}

before(async () => {
  for (const [id, code] of [[TENANT, 'tenant-cupo-motivos-test'], [OTRA, 'tenant-cupo-motivos-otra-test']]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, `${code} (test)`, code]);
  }
  const permisos = ['exclusions:read', 'exclusions:create', 'exclusions:update', 'leaves:read', 'leaves:create', 'settings:update'];
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: TENANT, permissions: permisos });
  headersOtra = await getTestAuthHeaders(UID_OTRA, { isSuperadmin: false, tenantId: OTRA, permissions: permisos });
  await cleanup();

  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta) VALUES (?, 'Cupo Test', ?, 1, '2020-01-01')`, [LEGAJO, TENANT]);
  empId = emp.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Cupo Test')`, [USERID, TENANT, String(LEGAJO)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [USERID, TENANT, empId]);
  // D2: tiene el articulo 55 cargado, pero vino a trabajar.
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`,
    [USERID, TENANT, `${D2_FICHO} 07:00:00`, USERID, TENANT, `${D2_FICHO} 14:00:00`]);
  const [et] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'ART55_TEST', 'Artículo 55 (test)', 1)`, [TENANT]);
  art55 = et.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await deleteTestUser(UID_OTRA);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT, OTRA]);
  await closeDb();
});

test('sin cupo configurado: se informa el consumo, sin tope ni bloqueo', async () => {
  const c = await consumo();
  assert.equal(c.cupo, null);
  assert.equal(c.usados, 0);
  assert.deepEqual(c.periodo, { desde: '2099-01-01', hasta: '2099-12-31' });
});

test('configurar el cupo valida los datos y queda con autor', async () => {
  const mal = await fetch(`${BASE_URL}/api/event-types/${art55}/cupos`, json('POST', { maxDiasAnio: -1, vigenteDesde: '2020-01-01' }));
  assert.equal(mal.status, 400);
  const ok = await fetch(`${BASE_URL}/api/event-types/${art55}/cupos`, json('POST', { maxDiasAnio: 2, alExceder: 'bloquear', vigenteDesde: '2020-01-01' }));
  assert.equal(ok.status, 200, await ok.text());
  const { cupos } = await (await fetch(`${BASE_URL}/api/event-types/${art55}/cupos`, { headers })).json();
  assert.equal(cupos.length, 1);
  assert.equal(cupos[0].periodo, 'calendario', 'default: año calendario');
  assert.ok(cupos[0].created_by_email);
});

test('otra empresa no ve ni configura el cupo ni el consumo', async () => {
  assert.equal((await fetch(`${BASE_URL}/api/event-types/${art55}/cupos`, { headers: headersOtra })).status, 404);
  assert.equal((await fetch(`${BASE_URL}/api/event-types/${art55}/consumo?employeeId=${empId}`, { headers: headersOtra })).status, 404);
  const r = await fetch(`${BASE_URL}/api/event-types/${art55}/cupos`, json('POST', { maxDiasAnio: 99, vigenteDesde: '2021-01-01' }, headersOtra));
  assert.equal(r.status, 404);
});

test('las justificaciones consumen; la de un dia que FICHÓ no', async () => {
  assert.equal((await justificar(D1)).status, 200);
  assert.equal((await justificar(D2_FICHO)).status, 200);
  const c = await consumo();
  assert.equal(c.usados, 1, 'D2 tiene fichajes: no gasta cupo');
  assert.equal(c.detalle.find((d) => d.fecha === D2_FICHO).porQueNo, 'fichó ese día');
});

test('el preview de una carga nueva anticipa el exceso', async () => {
  assert.equal((await justificar(D3)).status, 200); // 2 de 2
  const c = await consumo(`&desde=${D4}&hasta=${D4}`);
  assert.equal(c.usados, 2);
  assert.equal(c.usadosConNuevo, 3);
  assert.equal(c.accion, 'bloquear');
  assert.deepEqual(c.excesos, ['supera el tope anual: quedaría en 3 de 2']);
});

test('con "bloquear", pasarse del cupo se rechaza, sea justificacion o licencia', async () => {
  const j = await justificar(D4);
  assert.equal(j.status, 409);
  assert.match((await j.json()).error, /Artículo 55 \(test\): supera el tope anual/);
  const l = await fetch(`${BASE_URL}/api/employee-events`, json('POST', { employeeId: empId, eventTypeId: art55, fechaDesde: D4, fechaHasta: D4 }));
  assert.equal(l.status, 409);
});

test('un permiso horario (no dia completo) no gasta cupo ni se bloquea', async () => {
  const r = await fetch(`${BASE_URL}/config/user-exclusions`, json('POST', { userId: USERID, excDate: D4, type: 'HALF_DAY', excTo: '09:00', eventTypeId: art55 }));
  assert.equal(r.status, 200, await r.text());
  await db.query(`DELETE FROM userexclusions WHERE tenant_id = ? AND excDate = ?`, [TENANT, D4]);
});

test('con "avisar" (nueva vigencia), se guarda y la respuesta trae el aviso', async () => {
  const v = await fetch(`${BASE_URL}/api/event-types/${art55}/cupos`, json('POST', { maxDiasAnio: 2, alExceder: 'avisar', vigenteDesde: '2099-01-01' }));
  assert.equal(v.status, 200);
  const l = await fetch(`${BASE_URL}/api/employee-events`, json('POST', { employeeId: empId, eventTypeId: art55, fechaDesde: D4, fechaHasta: D4 }));
  const body = await l.json();
  assert.equal(l.status, 200, JSON.stringify(body));
  assert.match(body.avisoCupo, /supera el tope anual: quedaría en 3 de 2/);
  assert.equal((await consumo()).usados, 3);
});
