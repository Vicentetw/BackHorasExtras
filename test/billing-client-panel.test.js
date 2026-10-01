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
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_C = 999992; // descartable
const OTHER_TENANT = 999991; // descartable, para probar aislamiento
const UID_TENANT = 'test-billing-panel-tenant';
const UID_OTHER = 'test-billing-panel-other';
const UID_SUPERADMIN = 'test-billing-panel-superadmin';
// Otro administrador de la MISMA empresa que no es el titular (20261011).
const UID_TENANT_ADMIN2 = 'test-billing-panel-admin2';

let headersTenant;
let headersOther;
let headersSuperadmin;
let headersAdmin2;
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
  headersAdmin2 = await getTestAuthHeaders(UID_TENANT_ADMIN2, { isSuperadmin: false, tenantId: TENANT_C });
  await db.query('UPDATE tenants SET titular_email = NULL WHERE id = ?', [TENANT_C]);

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
  // El nuevo test de "pago manual" (Fase 13) inserta una fila real en
  // payment_records -- sin borrarla primero, el DELETE de tenants de abajo
  // rompe por la foreign key (fk_payment_records_tenant).
  await db.query(`DELETE FROM payment_records WHERE tenant_id IN (?, ?)`, [TENANT_C, OTHER_TENANT]);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id IN (?, ?)`, [TENANT_C, OTHER_TENANT]);
  if (planId) await db.query(`DELETE FROM plans WHERE id = ?`, [planId]);
  await deleteTestUser(UID_TENANT);
  await deleteTestUser(UID_OTHER);
  await deleteTestUser(UID_SUPERADMIN);
  await deleteTestUser(UID_TENANT_ADMIN2);
  // La cuenta creada por "agregar un titular nuevo".
  const [[nuevo]] = await db.query('SELECT id, firebase_uid FROM app_users WHERE email = ?', ['titular-nuevo-999992@example.com']);
  if (nuevo) {
    await db.query('DELETE FROM user_permissions WHERE user_id = ?', [nuevo.id]);
    await db.query('DELETE FROM app_users WHERE id = ?', [nuevo.id]);
    await require('firebase-admin').auth().deleteUser(nuevo.firebase_uid).catch(() => {});
  }
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

test('activar la suscripcion (webhook de MercadoPago autorizado) limpia el link de pago pendiente', async () => {
  // Bug real encontrado probando de punta a punta: antes esto solo tocaba
  // `status` -- el cliente seguia viendo "Pagar ahora con MercadoPago" en
  // /pagos DESPUES de haber pagado, pudiendo autorizar la misma suscripcion
  // mas de una vez. mercadopagoWebhook.js llama a esta misma funcion cuando
  // MercadoPago avisa que la suscripcion quedo 'authorized'.
  await db.query(`UPDATE tenant_subscriptions SET last_checkout_url = 'https://mp.example/fake-checkout' WHERE tenant_id = ?`, [TENANT_C]);
  await billingRepo.updateSubscriptionStatus(TENANT_C, 'active', db);

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  const sub = await subRes.json();
  assert.equal(sub.subscription.last_checkout_url, null, 'al activarse, el link ya cumplio su proposito -- se limpia solo');
  assert.equal(sub.subscription.status, 'active');
});

test('registrar un pago manual tambien limpia el pedido de pago pendiente', async () => {
  // Bug real encontrado revisando el circuito con el superadmin: antes solo
  // se limpiaba al generar el link de MercadoPago -- si el pago se registra
  // a mano (transferencia/efectivo, la opcion mas comun), el indicador
  // "Pidio el link de pago" quedaba prendido para siempre.
  await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-payment-link`, {
    method: 'POST',
    headers: headersTenant
  });

  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/payments`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_local: 1000, local_currency: 'ARS', reference: 'transferencia-test' })
  });
  assert.equal(res.status, 201);

  const subRes = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant });
  const sub = await subRes.json();
  assert.equal(sub.subscription.payment_requested_at, null, 'registrar un pago manual tambien responde al pedido -- se limpia solo');
});

// El cliente tiene que poder ver SU historial de pagos: es lo que le permite
// comprobar que lo que pago quedo registrado, sin depender de preguntarlo.
// La ruta ya existia y ya usaba canViewTenant, pero nadie verificaba ninguna
// de las dos mitades: ni que lo dejara entrar, ni -- lo que importa de
// verdad -- que no le mostrara los pagos de otra empresa. Dado el historial
// de fugas de tenant_id de este proyecto, se prueban las dos.
test('el cliente ve el historial de pagos de SU empresa, y ninguno ajeno', async () => {
  // Un pago de la otra empresa, para que haya algo concreto que se pueda
  // filtrar mal. Sin esto el test pasaria igual con la base vacia.
  await db.query(
    `INSERT INTO payment_records (tenant_id, amount_usd, amount_local, local_currency, method, reference, period_start, period_end)
     VALUES (?, 10, 7777, 'ARS', 'manual', 'pago-de-la-otra-empresa', '2026-01-01', '2026-02-01')`,
    [OTHER_TENANT]
  );

  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/payments`, { headers: headersTenant });
  assert.equal(res.status, 200, 'un admin de empresa tiene que poder leer su propio historial');
  const pagos = await res.json();

  assert.ok(pagos.length >= 1, 'debe ver el pago manual que registro el test anterior');
  assert.ok(pagos.every((p) => p.tenant_id === TENANT_C), 'ni una sola fila puede ser de otra empresa');
  assert.ok(
    !pagos.some((p) => p.reference === 'pago-de-la-otra-empresa'),
    'el pago de la otra empresa no puede aparecer en el historial de esta'
  );
});

test('el cliente no puede leer el historial de pagos de otra empresa (aislamiento canViewTenant)', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${OTHER_TENANT}/payments`, { headers: headersTenant });
  assert.equal(res.status, 403);
});

test('sin titular registrado, nadie de la empresa puede pedir la baja', async () => {
  const res = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-cancellation`, { method: 'POST', headers: headersTenant });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /titular registrado/);
});

const titularUrl = `${BASE_URL}/api/labor-engine/admin/tenants/${TENANT_C}/titular`;
const nombrarTitular = (email, headers = headersSuperadmin) => fetch(titularUrl, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
});
const EMAIL_NUEVO_TITULAR = 'titular-nuevo-999992@example.com';

test('titular: solo el superadmin lo designa; no puede ser un usuario de otra empresa', async () => {
  assert.equal((await nombrarTitular(`${UID_TENANT}@test.local`, headersTenant)).status, 403, 'un admin de la empresa no se nombra titular a si mismo');
  assert.equal((await nombrarTitular(`${UID_OTHER}@test.local`)).status, 409, 'usuario de otra empresa');
  assert.equal((await nombrarTitular('no-es-mail')).status, 400);
  const usuarios = await (await fetch(`${BASE_URL}/api/labor-engine/admin/tenants/${TENANT_C}/usuarios`, { headers: headersSuperadmin })).json();
  assert.ok(usuarios.usuarios.some((u) => u.email === `${UID_TENANT}@test.local`), 'lista los usuarios de la empresa para elegir');
});

test('titular: un mail que no es usuario no se nombra (se crea antes en Usuarios y Roles)', async () => {
  const r = await nombrarTitular(EMAIL_NUEVO_TITULAR);
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /Usuarios y Roles/);
  const [[u]] = await db.query('SELECT COUNT(*) AS n FROM app_users WHERE email = ?', [EMAIL_NUEVO_TITULAR]);
  assert.equal(u.n, 0, 'no se crea ninguna cuenta por esta via');
});

test('titular: se elige uno de la empresa, y solo el titular puede pedir o retirar la baja', async () => {
  const put = await nombrarTitular(`  ${UID_TENANT.toUpperCase()}@test.local `);
  assert.equal(put.status, 200, await put.clone().text());
  const [[t]] = await db.query('SELECT titular_email FROM tenants WHERE id = ?', [TENANT_C]);
  assert.equal(t.titular_email, `${UID_TENANT}@test.local`, 'se guarda normalizado');

  // Otro admin de la MISMA empresa: no puede, y el mensaje dice quien si.
  const otro = await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/request-cancellation`, { method: 'POST', headers: headersAdmin2 });
  assert.equal(otro.status, 403);
  assert.match((await otro.json()).error, /t\*\*\*@test\.local/);
  assert.equal((await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}/cancellation-request`, { method: 'DELETE', headers: headersAdmin2 })).status, 403);

  const vista = await (await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersAdmin2 })).json();
  assert.equal(vista.esTitular, false);
  assert.equal(vista.titular, 't***@test.local');
  assert.equal((await (await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_C}`, { headers: headersTenant })).json()).esTitular, true);
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
  // MercadoPago limita la cantidad de "test users" por aplicacion de
  // prueba (~10) y este test crea uno nuevo por corrida -- despues de
  // varias corridas da 403 "maximum quantity of test user reached". NO es
  // un problema del codigo de checkout (eso lo cubren los unit tests de
  // mercadopago-service.test.js con fetch mockeado): es cupo del sandbox
  // externo. Se saltea con un mensaje accionable en vez de marcar rojo.
  if (testUserRes.status === 403 && /maximum quantity of test user/i.test(JSON.stringify(testUser))) {
    console.log('  (saltado: se llego al tope de test users del sandbox de MercadoPago -- borralos desde el panel de MP para volver a correr este test end-to-end)');
    return;
  }
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
