// Fase 10 (venta): panel de Pagos del cliente + baja autogestionada con
// aprobacion del superadmin. Cubre 3 cosas nuevas:
//   1. GET /api/app-users/me devuelve subscriptionStatus (usado por
//      permission-guard.ts en Angular para redirigir a /pagos).
//   2. appUserMiddleware deja pasar /api/app-users/me y /api/billing/* aunque
//      la empresa este 'canceled' (bug real encontrado: antes ni podia
//      cargar su propio perfil), pero sigue bloqueando cualquier otra ruta.
//   3. El flujo completo de pedir/retirar/aprobar la baja, con aislamiento
//      por tenant (canViewTenant) en las 3 rutas nuevas.
//
// Tenant descartable propio (999992), NUNCA AVP (id 4) -- ver el bug
// historico ya conocido de este proyecto (billing-routes.test.js).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_C = 999992; // descartable
const OTHER_TENANT = 999991; // descartable, para probar aislamiento
const UID_TENANT = 'test-billing-panel-tenant';
const UID_OTHER = 'test-billing-panel-other';
const UID_SUPERADMIN = 'test-billing-panel-superadmin';

let headersTenant;
let headersOther;
let headersSuperadmin;
let planId;

async function setSubscriptionStatus(status) {
  await db.query(`UPDATE tenant_subscriptions SET status = ? WHERE tenant_id = ?`, [status, TENANT_C]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Billing Panel (test)', 'tenant-billing-panel-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_C]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Billing Panel Otro (test)', 'tenant-billing-panel-otro-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [OTHER_TENANT]
  );

  headersTenant = await getTestAuthHeaders(UID_TENANT, { isSuperadmin: false, tenantId: TENANT_C });
  headersOther = await getTestAuthHeaders(UID_OTHER, { isSuperadmin: false, tenantId: OTHER_TENANT });
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });

  const planRes = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plan billing panel (test)', base_price_usd: 10, price_per_employee_usd: 1, min_billed_employees: 1 })
  });
  planId = (await planRes.json()).id;

  await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planId, status: 'active', current_period_end: '2099-01-01' })
  });
});

after(async () => {
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id IN (?, ?)`, [TENANT_C, OTHER_TENANT]);
  if (planId) await db.query(`DELETE FROM plans WHERE id = ?`, [planId]);
  await deleteTestUser(UID_TENANT);
  await deleteTestUser(UID_OTHER);
  await deleteTestUser(UID_SUPERADMIN);
  await db.query(`DELETE FROM tenants WHERE id IN (?, ?)`, [TENANT_C, OTHER_TENANT]);
  await closeDb();
});

test('GET /api/app-users/me: incluye subscriptionStatus para un tenant normal, null para superadmin', async () => {
  const meRes = await fetch(`${BASE_URL}/api/app-users/me`, { headers: headersTenant });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.subscriptionStatus, 'active');

  const meSuperRes = await fetch(`${BASE_URL}/api/app-users/me`, { headers: headersSuperadmin });
  const meSuper = await meSuperRes.json();
  assert.equal(meSuper.subscriptionStatus, null);
});

test('pedir el link de pago: queda constancia del pedido', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-payment-link`, {
    method: 'POST',
    headers: headersTenant
  });
  assert.equal(res.status, 200);

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  const sub = await subRes.json();
  assert.ok(sub.subscription.payment_requested_at, 'debe quedar la marca del pedido');
});

test('otro tenant no puede pedir el link de pago ajeno', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-payment-link`, {
    method: 'POST',
    headers: headersOther
  });
  assert.equal(res.status, 403);
});

test('generar el link de MercadoPago limpia el pedido de pago pendiente', async () => {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    console.log('  (saltado: MERCADOPAGO_ACCESS_TOKEN no configurado en este entorno)');
    return;
  }
  const testUserRes = await fetch('https://api.mercadopago.com/users/test_user', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: 'MLA' })
  });
  const testUser = await testUserRes.json();
  if (testUserRes.status !== 201) {
    console.log('  (saltado: no se pudo crear el comprador de prueba -- ' + JSON.stringify(testUser) + ')');
    return;
  }
  await new Promise((r) => setTimeout(r, 4000));

  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/mercadopago-checkout`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payer_email: testUser.email, monthly_amount: 1000, currency_id: 'ARS', billing_period: 'monthly' })
  });
  const json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  const sub = await subRes.json();
  assert.equal(sub.subscription.payment_requested_at, null, 'generar el link responde al pedido -- se limpia solo');
});

test('pedir la baja: queda pendiente, NO cambia el status todavia', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-cancellation`, {
    method: 'POST',
    headers: headersTenant
  });
  assert.equal(res.status, 200);

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  const sub = await subRes.json();
  assert.equal(sub.effectiveStatus, 'active', 'pedir la baja no bloquea nada todavia');
  assert.ok(sub.subscription.cancellation_requested_at, 'debe quedar la marca de pedido pendiente');
});

test('pedir la baja de nuevo mientras hay una pendiente: 409', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-cancellation`, {
    method: 'POST',
    headers: headersTenant
  });
  assert.equal(res.status, 409);
});

test('otro tenant no puede pedir ni retirar la baja ajena (aislamiento canViewTenant)', async () => {
  const reqRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-cancellation`, {
    method: 'POST',
    headers: headersOther
  });
  assert.equal(reqRes.status, 403);

  const delRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/cancellation-request`, {
    method: 'DELETE',
    headers: headersOther
  });
  assert.equal(delRes.status, 403);
});

test('retirar el pedido: limpia la marca, se puede volver a pedir despues', async () => {
  const delRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/cancellation-request`, {
    method: 'DELETE',
    headers: headersTenant
  });
  assert.equal(delRes.status, 200);

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  const sub = await subRes.json();
  assert.equal(sub.subscription.cancellation_requested_at, null);

  // se puede volver a pedir sin el 409 de "ya hay una pendiente"
  const res2 = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-cancellation`, {
    method: 'POST',
    headers: headersTenant
  });
  assert.equal(res2.status, 200);
});

test('solo superadmin puede aprobar la baja', async () => {
  const denied = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/approve-cancellation`, {
    method: 'POST',
    headers: headersTenant
  });
  assert.equal(denied.status, 403);
});

test('aprobar la baja: bloquea TODO, pero /pagos (GET subscription) y /api/app-users/me siguen andando', async () => {
  const approveRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/approve-cancellation`, {
    method: 'POST',
    headers: headersSuperadmin
  });
  assert.equal(approveRes.status, 200);

  // Bug real corregido en esta fase: antes esto daba 403 para un tenant
  // 'canceled' -- ni podia cargar su propio perfil.
  const meRes = await fetch(`${BASE_URL}/api/app-users/me`, { headers: headersTenant });
  assert.equal(meRes.status, 200, '/api/app-users/me debe seguir accesible aunque este cancelado');
  const me = await meRes.json();
  assert.equal(me.subscriptionStatus, 'canceled');

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  assert.equal(subRes.status, 200, '/api/billing/* debe seguir accesible para que /pagos funcione estando bloqueado');
  const sub = await subRes.json();
  assert.equal(sub.effectiveStatus, 'canceled');
  assert.ok(sub.subscription.cancellation_requested_at, 'la marca de pedido NO se limpia al aprobar -- se usa para el mensaje contextual en /pagos');

  // Cualquier otra ruta si sigue bloqueada -- el bloqueo de 'canceled'
  // (isFullyBlocked) sigue vigente para todo lo que no sea el panel de
  // Pagos, solo se abrio una excepcion puntual.
  const employeesRes = await fetch(`${BASE_URL}/api/employees`, { headers: headersTenant });
  assert.equal(employeesRes.status, 403, 'canceled sigue bloqueando el resto de las rutas');
});

test('el superadmin sigue pudiendo generar un checkout de MercadoPago con periodo trimestral/semestral/anual (sandbox real)', async () => {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    console.log('  (saltado: MERCADOPAGO_ACCESS_TOKEN no configurado en este entorno)');
    return;
  }
  // payer_email tiene que ser un comprador de prueba REAL de MercadoPago
  // (creado via POST /users/test_user) -- un email inventado da "User bad
  // request" para CUALQUIER frequency, incluida la mensual ya probada
  // antes (verificado: no es un problema del parametro nuevo, es que el
  // email no existe como test user).
  const testUserRes = await fetch('https://api.mercadopago.com/users/test_user', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: 'MLA' })
  });
  const testUser = await testUserRes.json();
  assert.equal(testUserRes.status, 201, `no se pudo crear el comprador de prueba: ${JSON.stringify(testUser)}`);

  // Un comprador de prueba recien creado no es utilizable al toque --
  // "eventual consistency" ya encontrado antes en esta misma integracion
  // (ver notas de la sesion de Fase 9b): la primera llamada da "User bad
  // request" y unos segundos despues ya funciona. Sin este delay este test
  // es intermitente.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  for (const period of ['quarterly', 'semiannual', 'annual']) {
    const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/mercadopago-checkout`, {
      method: 'POST',
      headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payer_email: testUser.email,
        monthly_amount: 1000,
        currency_id: 'ARS',
        billing_period: period
      })
    });
    const json = await res.json();
    assert.equal(res.status, 201, `MercadoPago debe aceptar frequency para '${period}': ${JSON.stringify(json)}`);
    assert.ok(json.checkoutUrl, `debe devolver un checkoutUrl para '${period}'`);

    // Se guarda el link y el periodo elegido -- lo nuevo de esta fase, para
    // que el cliente lo vea despues desde /pagos.
    const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersSuperadmin });
    const sub = await subRes.json();
    assert.equal(sub.subscription.billing_period, period);
    assert.equal(sub.subscription.last_checkout_url, json.checkoutUrl);
    assert.ok(sub.subscription.last_checkout_generated_at);
  }
});

test('mercadopago-checkout: rechaza un billing_period invalido', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/mercadopago-checkout`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payer_email: 'x@x.com', monthly_amount: 1000, billing_period: 'weekly' })
  });
  assert.equal(res.status, 400);
});
