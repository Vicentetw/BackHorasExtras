// Fase 9b (MercadoPago): funciones puras/inyectables de mercadopagoService.js
// -- sin credenciales reales, se testea con un fetchImpl falso y la formula
// de firma HMAC computada a mano (misma formula que usa MercadoPago de
// verdad, verificada contra la documentacion oficial).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createSubscriptionCheckout,
  getPreapproval,
  getPayment,
  mapPreapprovalStatus,
  verifyWebhookSignature
} = require('../motor-laboral/services/mercadopagoService');

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fn.calls = calls;
  return fn;
}

test('createSubscriptionCheckout: manda el body correcto y devuelve id/initPoint', async () => {
  const fetchImpl = fakeFetch({ id: 'mp-123', init_point: 'https://mp.example/checkout/123', status: 'pending' });
  const result = await createSubscriptionCheckout({
    accessToken: 'TOKEN',
    tenantId: 4,
    tenantName: 'AVP2',
    payerEmail: 'admin@avp2.com',
    transactionAmount: 29,
    currencyId: 'ARS',
    backUrl: 'https://miapp.com/facturacion',
    fetchImpl
  });

  assert.equal(result.id, 'mp-123');
  assert.equal(result.initPoint, 'https://mp.example/checkout/123');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.mercadopago.com/preapproval');
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, 'Bearer TOKEN');
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.external_reference, '4', 'el tenantId va como external_reference para poder identificarlo en el webhook');
  assert.equal(body.status, 'pending');
  assert.equal(body.auto_recurring.frequency, 1, 'sin billingPeriod, default a mensual (1 mes) -- compatibilidad con el flujo superadmin existente');
  assert.equal(body.auto_recurring.frequency_type, 'months');
  assert.equal(body.auto_recurring.transaction_amount, 29);
  assert.equal(body.auto_recurring.currency_id, 'ARS');
});

// Fase 10: el superadmin ahora puede elegir el periodo al generar el link
// (antes frequency estaba hardcodeado a 1 mes) -- verifica que cada
// billingPeriod mapea a la cantidad de meses correcta (misma tabla que
// billingCalculations.js, no un mapeo duplicado con otros valores).
test('createSubscriptionCheckout: billingPeriod mapea a frequency en meses (quarterly=3, semiannual=6, annual=12)', async () => {
  const cases = [['quarterly', 3], ['semiannual', 6], ['annual', 12]];
  for (const [billingPeriod, expectedFrequency] of cases) {
    const fetchImpl = fakeFetch({ id: 'mp-1', init_point: 'https://mp.example/x', status: 'pending' });
    await createSubscriptionCheckout({
      accessToken: 'TOKEN',
      tenantId: 4,
      tenantName: 'AVP2',
      payerEmail: 'admin@avp2.com',
      transactionAmount: 100,
      currencyId: 'ARS',
      backUrl: 'https://miapp.com/facturacion',
      billingPeriod,
      fetchImpl
    });
    const body = JSON.parse(fetchImpl.calls[0].options.body);
    assert.equal(body.auto_recurring.frequency, expectedFrequency, `billingPeriod '${billingPeriod}' debe mapear a ${expectedFrequency} meses`);
    assert.equal(body.auto_recurring.frequency_type, 'months');
  }
});

// Dos restricciones REALES de MercadoPago sobre "reason", encontradas
// probando contra su sandbox con credenciales de prueba reales (no estan
// documentadas explicitamente): maximo 60 caracteres, y el doble guion
// "--" dispara su filtro de contenido ("invalid_field_content"). El
// primer intento de este archivo (con " -- " y sin truncar) fallo con
// esos dos errores reales antes de este fix.
test('createSubscriptionCheckout: "reason" nunca lleva doble guion "--" (MercadoPago lo rechaza como contenido invalido)', async () => {
  const fetchImpl = fakeFetch({ id: 'mp-1', init_point: 'https://mp.example/x', status: 'pending' });
  await createSubscriptionCheckout({
    accessToken: 'TOKEN', tenantId: 4, tenantName: 'AVP2', payerEmail: 'a@b.com',
    transactionAmount: 29, currencyId: 'ARS', backUrl: 'https://x.com', fetchImpl
  });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.ok(!body.reason.includes('--'), `reason no debe tener doble guion: "${body.reason}"`);
});

test('createSubscriptionCheckout: "reason" nunca supera 60 caracteres (MercadoPago lo rechaza) aunque el nombre de la empresa sea largo', async () => {
  const fetchImpl = fakeFetch({ id: 'mp-1', init_point: 'https://mp.example/x', status: 'pending' });
  await createSubscriptionCheckout({
    accessToken: 'TOKEN', tenantId: 4,
    tenantName: 'Una Empresa Con Un Nombre Comercial Extremadamente Largo Y Detallado S.A.',
    payerEmail: 'a@b.com', transactionAmount: 29, currencyId: 'ARS', backUrl: 'https://x.com', fetchImpl
  });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.ok(body.reason.length <= 60, `reason tiene ${body.reason.length} caracteres, el maximo es 60: "${body.reason}"`);
});

test('createSubscriptionCheckout: si MercadoPago responde con error, lo propaga con detalle', async () => {
  const fetchImpl = fakeFetch({ message: 'invalid payer_email' }, { ok: false, status: 400 });
  await assert.rejects(
    () => createSubscriptionCheckout({
      accessToken: 'TOKEN', tenantId: 4, tenantName: 'AVP2', payerEmail: 'malo',
      transactionAmount: 29, currencyId: 'ARS', backUrl: 'https://x.com', fetchImpl
    }),
    /invalid payer_email/
  );
});

test('getPreapproval: pide el recurso por id con el token correcto', async () => {
  const fetchImpl = fakeFetch({ id: 'mp-123', status: 'authorized' });
  const result = await getPreapproval({ accessToken: 'TOKEN', preapprovalId: 'mp-123', fetchImpl });
  assert.equal(result.status, 'authorized');
  assert.equal(fetchImpl.calls[0].url, 'https://api.mercadopago.com/preapproval/mp-123');
});

test('getPayment: pide el pago por id', async () => {
  const fetchImpl = fakeFetch({ id: 999, status: 'approved', transaction_amount: 29 });
  const result = await getPayment({ accessToken: 'TOKEN', paymentId: 999, fetchImpl });
  assert.equal(result.status, 'approved');
  assert.equal(fetchImpl.calls[0].url, 'https://api.mercadopago.com/v1/payments/999');
});

test('mapPreapprovalStatus: "authorized" mapea a "active", el resto no cambia nada solo', () => {
  assert.equal(mapPreapprovalStatus('authorized'), 'active');
  assert.equal(mapPreapprovalStatus('pending'), null);
  assert.equal(mapPreapprovalStatus('paused'), null);
  assert.equal(mapPreapprovalStatus('cancelled'), null);
});

// Firma de webhook: misma formula que la documentacion oficial de
// MercadoPago -- manifest "id:{id};request-id:{req};ts:{ts};", HMAC-SHA256
// hex con el secret, mandado como header x-signature "ts=...,v1=...".
function signManifest(dataId, requestId, ts, secret) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return crypto.createHmac('sha256', secret).update(manifest).digest('hex');
}

test('verifyWebhookSignature: firma correcta -> true', () => {
  const secret = 'mi-secreto-de-prueba';
  const ts = '1700000000000';
  const v1 = signManifest('mp-123', 'req-1', ts, secret);
  const ok = verifyWebhookSignature({
    xSignature: `ts=${ts},v1=${v1}`,
    xRequestId: 'req-1',
    dataId: 'mp-123',
    secret
  });
  assert.equal(ok, true);
});

test('verifyWebhookSignature: secret incorrecto -> false', () => {
  const ts = '1700000000000';
  const v1 = signManifest('mp-123', 'req-1', ts, 'secret-real');
  const ok = verifyWebhookSignature({
    xSignature: `ts=${ts},v1=${v1}`,
    xRequestId: 'req-1',
    dataId: 'mp-123',
    secret: 'secret-equivocado'
  });
  assert.equal(ok, false);
});

test('verifyWebhookSignature: dataId manipulado (no coincide con el firmado) -> false', () => {
  const secret = 'mi-secreto-de-prueba';
  const ts = '1700000000000';
  const v1 = signManifest('mp-123', 'req-1', ts, secret);
  const ok = verifyWebhookSignature({
    xSignature: `ts=${ts},v1=${v1}`,
    xRequestId: 'req-1',
    dataId: 'mp-999', // alguien intento reusar la firma para OTRO recurso
    secret
  });
  assert.equal(ok, false);
});

test('verifyWebhookSignature: faltan headers o secret -> false, no explota', () => {
  assert.equal(verifyWebhookSignature({ xSignature: null, xRequestId: 'r', dataId: 'd', secret: 's' }), false);
  assert.equal(verifyWebhookSignature({ xSignature: 'ts=1,v1=abc', xRequestId: null, dataId: 'd', secret: 's' }), false);
  assert.equal(verifyWebhookSignature({ xSignature: 'ts=1,v1=abc', xRequestId: 'r', dataId: 'd', secret: null }), false);
  assert.equal(verifyWebhookSignature({ xSignature: 'formato-invalido', xRequestId: 'r', dataId: 'd', secret: 's' }), false);
});
