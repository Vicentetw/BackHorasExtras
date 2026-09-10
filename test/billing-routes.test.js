// Fase 9 (venta): integracion de /api/billing/* contra la base real --
// crea un plan de prueba, arma una suscripcion para una empresa
// DESCARTABLE (con 2 empleados propios, insertados aca), registra un pago
// manual y verifica el estado resultante. Requiere el backend local
// corriendo (node horasdedica2.js).
//
// OJO: usa un tenant_id descartable a proposito, NUNCA una empresa real
// (ni AVP) -- una version anterior de este archivo reusaba el tenant AVP
// (id 4) como fixture y su cleanup (`DELETE FROM tenant_subscriptions
// WHERE tenant_id = 4` sin restaurar nada) termino borrando la
// suscripcion 'free' real que se le habia configurado a mano. Con un
// tenant propio, borrar todo en el after() es siempre seguro.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999994; // descartable, fuera de rango real
const OTHER_TENANT = 999993; // descartable, para probar aislamiento
const UID_SUPERADMIN = 'test-billing-superadmin';
const UID_TENANT_A = 'test-billing-tenant-a';
const UID_OTHER_TENANT = 'test-billing-other-tenant';

let headersSuperadmin;
let headersTenantA;
let headersOtherTenant;
let planId;
const createdEmployeeIds = [];

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Billing Routes (test)', 'tenant-billing-routes-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Billing Routes Otro (test)', 'tenant-billing-routes-otro-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [OTHER_TENANT]
  );
  // 2 empleados propios de TENANT_A -- para que employeeCount de verdad
  // salga de `employees` (no de `users`, ver billingCalculations.js).
  for (const [employeeId, nombre] of [[999994001, 'Empleado Billing Test 1'], [999994002, 'Empleado Billing Test 2']]) {
    const [result] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, ?, ?, 0)`,
      [employeeId, nombre, TENANT_A]
    );
    createdEmployeeIds.push(result.insertId);
  }

  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
  headersTenantA = await getTestAuthHeaders(UID_TENANT_A, { isSuperadmin: false, tenantId: TENANT_A });
  headersOtherTenant = await getTestAuthHeaders(UID_OTHER_TENANT, { isSuperadmin: false, tenantId: OTHER_TENANT });
});

after(async () => {
  await db.query(`DELETE FROM payment_records WHERE tenant_id = ?`, [TENANT_A]);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id IN (?, ?)`, [TENANT_A, OTHER_TENANT]);
  if (planId) await db.query(`DELETE FROM plans WHERE id = ?`, [planId]);
  for (const id of createdEmployeeIds) {
    await db.query('DELETE FROM employees WHERE id = ?', [id]).catch(() => {});
  }
  await deleteTestUser(UID_SUPERADMIN);
  await deleteTestUser(UID_TENANT_A);
  await deleteTestUser(UID_OTHER_TENANT);
  await db.query(`DELETE FROM tenants WHERE id IN (?, ?)`, [TENANT_A, OTHER_TENANT]);
  await closeDb();
});

test('POST /api/billing/plans: solo superadmin puede crear un plan', async () => {
  const denied = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersTenantA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', base_price_usd: 1, price_per_employee_usd: 1, min_billed_employees: 1 })
  });
  assert.equal(denied.status, 403);

  const res = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Plan de prueba',
      base_price_usd: 18,
      price_per_employee_usd: 2.2,
      min_billed_employees: 5,
      is_default: false
    })
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  planId = json.id;
  assert.ok(planId);
});

test('GET /api/billing/plans: cualquier usuario logueado puede consultar los planes activos', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/plans`, { headers: headersTenantA });
  assert.equal(res.status, 200);
  const plans = await res.json();
  assert.ok(plans.some((p) => p.id === planId));
});

test('POST /api/billing/subscriptions/:tenantId: asigna el plan (solo superadmin)', async () => {
  const denied = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, {
    method: 'POST',
    headers: { ...headersTenantA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId })
  });
  assert.equal(denied.status, 403);

  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, billing_period: 'monthly', status: 'trial' })
  });
  assert.equal(res.status, 200);
});

test('GET /api/billing/subscriptions/:tenantId: el propio tenant ve su suscripcion y el conteo real de empleados (de employees, no de users)', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, { headers: headersTenantA });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.employeeCount, 2, 'esta empresa de prueba tiene exactamente 2 empleados en `employees`');
  assert.equal(json.effectiveStatus, 'trial');
  assert.equal(json.invoicePreview.billedEmployees, 5, 'por debajo del minimo del plan, se factura al piso');

  // Primer mes gratis: al no mandar fechas explicitas en el alta, el
  // backend arma un periodo de ~1 mes arrancando hoy.
  const start = new Date(json.subscription.current_period_start);
  const end = new Date(json.subscription.current_period_end);
  const expectedEnd = new Date(start);
  expectedEnd.setMonth(expectedEnd.getMonth() + 1);
  assert.equal(end.toISOString().slice(0, 10), expectedEnd.toISOString().slice(0, 10), 'el primer periodo debe durar 1 mes exacto');
});

test('GET /api/billing/subscriptions/:tenantId: otra empresa no puede ver la suscripcion ajena', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, { headers: headersOtherTenant });
  assert.equal(res.status, 403);
});

test('POST /api/billing/subscriptions/:tenantId/payments: registrar un pago manual activa la suscripcion y fija el proximo vencimiento', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}/payments`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: 'transferencia de prueba' })
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.ok(json.invoice.totalUsd > 0);

  const statusRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, { headers: headersTenantA });
  const statusJson = await statusRes.json();
  assert.equal(statusJson.effectiveStatus, 'active');
  assert.equal(statusJson.subscription.current_period_end, json.periodEnd);

  const historyRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}/payments`, { headers: headersTenantA });
  const history = await historyRes.json();
  assert.equal(history.length, 1);
  assert.equal(history[0].reference, 'transferencia de prueba');
});

test('POST /api/billing/subscriptions/:tenantId: rechaza un status invalido (grace/readonly no se eligen a mano, se calculan)', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, status: 'readonly' })
  });
  assert.equal(res.status, 400);
});

test('POST /api/billing/subscriptions/:tenantId: status "free" (uso interno/particular, ej. AVP) se puede asignar y nunca se bloquea', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, status: 'free' })
  });
  assert.equal(res.status, 200);

  const statusRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_A}`, { headers: headersTenantA });
  const statusJson = await statusRes.json();
  assert.equal(statusJson.effectiveStatus, 'free');
});

test('empresa sin suscripcion configurada: responde 200 con subscription null y effectiveStatus "none" (no bloquea, pero tampoco finge un trial)', async () => {
  // OJO: este test decia effectiveStatus === 'trial' -- quedo desactualizado.
  // En Fase 17 se cambio A PROPOSITO: una empresa SIN suscripcion configurada
  // devuelve 'none' ("sin configurar"), no 'trial' -- fingir un trial que
  // nadie armo era un bug real (routes/billing.js:120-127). 'none' igual NO
  // bloquea el uso del sistema (isWriteBlocked/isFullyBlocked solo miran
  // grace/readonly/canceled), solo informa el estado honesto.
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${OTHER_TENANT}`, { headers: headersOtherTenant });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.subscription, null);
  assert.equal(json.effectiveStatus, 'none');
});
