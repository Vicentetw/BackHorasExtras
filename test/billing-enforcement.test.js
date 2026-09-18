// Fase 9 (venta): las dos acciones que de verdad quedan bloqueadas cuando
// se vence el periodo de gracia -- subir fichajes (/import/checkins) y
// crear empleados (POST /api/employees), ni uno por uno ni por Excel (el
// import de Angular hace un POST por fila a esta misma ruta). Todo lo
// demas sigue andando en 'readonly'. Aparte, el corte MANUAL ('canceled')
// bloquea CUALQUIER ruta para esa empresa -- lo pone un superadmin a mano,
// nunca pasa solo.
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_B = 999995; // descartable, fuera de rango real
const UID_TENANT = 'test-billing-enforcement-tenant';
const UID_SUPERADMIN = 'test-billing-enforcement-superadmin';

let headersTenant;
let headersSuperadmin;
let planId;
let ciudadId, sucursalId;
const createdEmployeeIds = [];

async function setSubscriptionStatus(status, currentPeriodEnd) {
  await db.query(
    `UPDATE tenant_subscriptions SET status = ?, current_period_end = ? WHERE tenant_id = ?`,
    [status, currentPeriodEnd, TENANT_B]
  );
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Enforcement (test)', 'tenant-enforcement-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  headersTenant = await getTestAuthHeaders(UID_TENANT, { isSuperadmin: false, tenantId: TENANT_B });
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });

  // Pedido real: ciudad_id/sucursal_id son requeridos desde
  // 20260917_ciudades_sucursales.sql -- se insertan directo por SQL (no
  // hace falta pasar por la API para esto, mismo criterio que el resto de
  // los fixtures de este archivo).
  const [ciudadResult] = await db.query(`INSERT INTO ciudades (tenant_id, nombre) VALUES (?, 'Ciudad Enforcement (test)')`, [TENANT_B]);
  ciudadId = ciudadResult.insertId;
  const [sucursalResult] = await db.query(`INSERT INTO sucursales (tenant_id, ciudad_id, nombre) VALUES (?, ?, 'Sucursal Enforcement (test)')`, [TENANT_B, ciudadId]);
  sucursalId = sucursalResult.insertId;

  const planRes = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plan enforcement (test)', base_price_usd: 10, price_per_employee_usd: 1, min_billed_employees: 1 })
  });
  planId = (await planRes.json()).id;

  await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_B}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, status: 'active', current_period_end: '2099-01-01' })
  });
});

after(async () => {
  for (const id of createdEmployeeIds) {
    await db.query('DELETE FROM employees WHERE id = ?', [id]).catch(() => {});
  }
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = ?`, [TENANT_B]);
  await db.query(`DELETE FROM plans WHERE id = ?`, [planId]);
  await db.query(`DELETE FROM sucursales WHERE tenant_id = ?`, [TENANT_B]);
  await db.query(`DELETE FROM ciudades WHERE tenant_id = ?`, [TENANT_B]);
  await deleteTestUser(UID_TENANT);
  await deleteTestUser(UID_SUPERADMIN);
  await db.query(`DELETE FROM tenants WHERE id = ?`, [TENANT_B]);
  await closeDb();
});

test('en "active", puede crear empleados y subir fichajes normalmente', async () => {
  await setSubscriptionStatus('active', '2099-01-01');

  const empRes = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 888801, nombre: 'Empleado Enforcement Test', ciudad_id: ciudadId, sucursal_id: sucursalId })
  });
  assert.notEqual(empRes.status, 402);
  const empJson = await empRes.json();
  if (empJson.id) createdEmployeeIds.push(empJson.id);

  const checkinsRes = await fetch(`${BASE_URL}/import/checkins`, { method: 'POST', headers: headersTenant });
  assert.equal(checkinsRes.status, 400, 'pasa el chequeo de suscripcion y llega al handler (400 = sin archivo, no 402)');
});

test('vencido y pasado el periodo de gracia ("readonly"): no puede crear empleados ni subir fichajes', async () => {
  // Vencio hace mucho -- muy por fuera de cualquier periodo de gracia razonable.
  await setSubscriptionStatus('active', '2020-01-01');

  const empRes = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 888802, nombre: 'No Deberia Crearse' })
  });
  assert.equal(empRes.status, 402);

  const checkinsRes = await fetch(`${BASE_URL}/import/checkins`, { method: 'POST', headers: headersTenant });
  assert.equal(checkinsRes.status, 402);

  const [[row]] = await db.query('SELECT id FROM employees WHERE employee_id = 888802');
  assert.equal(row, undefined, 'el empleado NO debe haberse creado');
});

test('"readonly" no bloquea lectura -- GET /api/employees sigue funcionando', async () => {
  await setSubscriptionStatus('active', '2020-01-01');
  const res = await fetch(`${BASE_URL}/api/employees`, { headers: headersTenant });
  assert.equal(res.status, 200);
});

test('"grace" (vencido pero todavia dentro del periodo de gracia) sigue funcionando full, solo aviso', async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await setSubscriptionStatus('active', yesterday.toISOString().slice(0, 10));

  const empRes = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 888803, nombre: 'Deberia Crearse En Grace', ciudad_id: ciudadId, sucursal_id: sucursalId })
  });
  assert.notEqual(empRes.status, 402);
  const empJson = await empRes.json();
  if (empJson.id) createdEmployeeIds.push(empJson.id);
});

test('"canceled" (corte manual): bloquea CUALQUIER ruta, no solo alta', async () => {
  await setSubscriptionStatus('canceled', '2099-01-01');

  const readRes = await fetch(`${BASE_URL}/api/employees`, { headers: headersTenant });
  assert.equal(readRes.status, 403, 'incluso una simple lectura queda bloqueada en canceled');

  const empRes = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 888804, nombre: 'No Deberia Crearse' })
  });
  assert.equal(empRes.status, 403);
});

test('superadmin nunca se bloquea, sin importar el estado de la suscripcion', async () => {
  await setSubscriptionStatus('canceled', '2020-01-01');
  const res = await fetch(`${BASE_URL}/api/employees?limit=1`, { headers: headersSuperadmin });
  assert.equal(res.status, 200);
});

test('"free" (uso interno/particular, ej. AVP): nunca se bloquea aunque la fecha este vencida hace anios', async () => {
  await setSubscriptionStatus('free', '2020-01-01');

  const readRes = await fetch(`${BASE_URL}/api/employees`, { headers: headersTenant });
  assert.equal(readRes.status, 200);

  const empRes = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 888805, nombre: 'Deberia Crearse En Free', ciudad_id: ciudadId, sucursal_id: sucursalId })
  });
  assert.notEqual(empRes.status, 402);
  assert.notEqual(empRes.status, 403);
  const empJson = await empRes.json();
  if (empJson.id) createdEmployeeIds.push(empJson.id);

  const checkinsRes = await fetch(`${BASE_URL}/import/checkins`, { method: 'POST', headers: headersTenant });
  assert.equal(checkinsRes.status, 400, 'pasa el chequeo de suscripcion, llega al handler (400 = sin archivo, no 402)');
});
