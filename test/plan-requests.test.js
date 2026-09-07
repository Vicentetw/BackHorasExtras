// Fase 17 -- bug real reportado por el superadmin: una empresa CON tenant
// pero SIN ninguna suscripcion armada (ni un trial -- ej. un usuario dado
// de alta a mano sin asignarle plan) caia en /acceso-denegado con un
// mensaje tecnico incomprensible, sin ninguna forma de pedir un plan.
//
// Tenant descartable propio (999998), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_NOPLAN = 999998; // descartable, sin suscripcion a proposito
const UID_TENANT = 'test-plan-request-tenant';
const UID_SUPERADMIN = 'test-plan-request-superadmin';

let headersTenant;
let headersSuperadmin;
let planId;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Sin Plan (test)', 'tenant-sin-plan-req-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_NOPLAN]
  );
  headersTenant = await getTestAuthHeaders(UID_TENANT, { isSuperadmin: false, tenantId: TENANT_NOPLAN });
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
});

after(async () => {
  await db.query(`DELETE FROM plan_requests WHERE tenant_id = ?`, [TENANT_NOPLAN]);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = ?`, [TENANT_NOPLAN]);
  if (planId) await db.query(`DELETE FROM plans WHERE id = ?`, [planId]);
  await deleteTestUser(UID_TENANT);
  await deleteTestUser(UID_SUPERADMIN);
  await db.query(`DELETE FROM tenants WHERE id = ?`, [TENANT_NOPLAN]);
  await closeDb();
});

test('GET /api/app-users/me: subscriptionStatus es "none" para un tenant sin suscripcion (no "trial", no null)', async () => {
  const res = await fetch(`${BASE_URL}/api/app-users/me`, { headers: headersTenant });
  const json = await res.json();
  assert.equal(json.subscriptionStatus, 'none');
});

test('POST /api/billing/plan-requests: queda constancia del pedido, tenantId sale del usuario logueado', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/plan-requests`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '2804123456', contact_preference: 'whatsapp', employee_count: 20, clock_count: 2 })
  });
  assert.equal(res.status, 201);

  const mine = await fetch(`${BASE_URL}/api/billing/plan-requests`, { headers: headersTenant });
  const mineJson = await mine.json();
  assert.equal(mineJson.employee_count, 20);
  assert.equal(mineJson.status, 'pending');
});

test('POST /api/billing/plan-requests: pedirlo dos veces da 409 (ya hay uno pendiente)', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/plan-requests`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_count: 5 })
  });
  assert.equal(res.status, 409);
});

test('GET /api/billing/plan-requests?all=1: solo superadmin, y lo ve con el nombre del tenant', async () => {
  const denied = await fetch(`${BASE_URL}/api/billing/plan-requests?all=1`, { headers: headersTenant });
  assert.equal(denied.status, 403);

  const res = await fetch(`${BASE_URL}/api/billing/plan-requests?all=1`, { headers: headersSuperadmin });
  const rows = await res.json();
  const mine = rows.find((r) => r.tenant_id === TENANT_NOPLAN);
  assert.ok(mine, 'el pedido de este tenant debe aparecer en la lista del superadmin');
  assert.equal(mine.tenant_name, 'Tenant Sin Plan (test)');
  assert.equal(mine.employee_count, 20);
});

test('asignarle un plan de verdad resuelve el pedido pendiente solo', async () => {
  const planRes = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plan plan-request (test)', base_price_usd: 10, price_per_employee_usd: 1, min_billed_employees: 1 })
  });
  planId = (await planRes.json()).id;

  await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_NOPLAN}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, status: 'trial' })
  });

  const mine = await fetch(`${BASE_URL}/api/billing/plan-requests`, { headers: headersTenant });
  const mineJson = await mine.json();
  assert.equal(mineJson, null, 'ya no deberia haber ningun pedido pendiente');

  const meRes = await fetch(`${BASE_URL}/api/app-users/me`, { headers: headersTenant });
  const me = await meRes.json();
  assert.equal(me.subscriptionStatus, 'trial', 'ahora que tiene plan, subscriptionStatus deja de ser "none"');
});
