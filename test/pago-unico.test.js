// Link de pago ÚNICO (no suscripción).
//
// Pedido real: "por si quieren pagar todo el año o ir pagando mensual pero no
// suscripción". Hay clientes que no quieren dejar la tarjeta para un débito
// automático y prefieren pagar cuando les toca.
//
// Es OTRA API de MercadoPago: /checkout/preferences, no /preapproval. La
// diferencia de fondo es que no deja nada vivo después del pago -- se cobra
// una vez y se termina. No hay nada que cancelar después, que es justamente
// lo que el cliente quiere evitar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mp = require('../motor-laboral/services/mercadopagoService');

const base = {
  accessToken: 'token-de-prueba',
  tenantId: 6,
  tenantName: 'AVP',
  amount: 25000,
  currencyId: 'ARS',
  backUrl: 'https://horasdedicacionavp.web.app/facturacion',
};

test('va a /checkout/preferences, no a /preapproval', async () => {
  let recibido = null;
  await mp.createOneTimePaymentLink({
    ...base,
    fetchImpl: async (url, opts) => {
      recibido = { url, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ id: 'pref-1', init_point: 'https://mp/pagar' }) };
    },
  });

  assert.match(recibido.url, /checkout\/preferences$/);
  assert.doesNotMatch(recibido.url, /preapproval/,
    'un pago único NO puede crear una suscripción recurrente');
  // Ni rastro de auto_recurring: eso es lo que hace que sea recurrente.
  assert.equal(recibido.body.auto_recurring, undefined);
});

test('manda el tenant como external_reference, que es lo que el webhook usa', async () => {
  let body = null;
  await mp.createOneTimePaymentLink({
    ...base,
    fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 'pref-1', init_point: 'https://mp/pagar' }) };
    },
  });

  assert.equal(body.external_reference, '6');
  assert.equal(body.items[0].unit_price, 25000);
  assert.equal(body.items[0].currency_id, 'ARS');
});

test('cuántos meses cubre viaja en metadata, no se deduce del monto', async () => {
  // Deducirlo del monto sería la clase de suposición que termina en un
  // período mal extendido: el precio cambia, hay descuentos, el plan se
  // renegocia. El dato tiene que viajar explícito.
  let body = null;
  const r = await mp.createOneTimePaymentLink({
    ...base, amount: 270000, mesesQueCubre: 12,
    fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 'pref-1', init_point: 'https://mp/pagar' }) };
    },
  });

  assert.equal(body.metadata.meses_que_cubre, 12);
  assert.equal(body.metadata.tenant_id, '6');
  assert.equal(r.mesesQueCubre, 12);
  assert.match(body.items[0].title, /12 meses/, 'el cliente tiene que ver qué está pagando');
});

test('un mes se escribe en singular', async () => {
  let body = null;
  await mp.createOneTimePaymentLink({
    ...base, mesesQueCubre: 1,
    fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 'pref-1', init_point: 'https://mp/pagar' }) };
    },
  });
  assert.match(body.items[0].title, /1 mes -/);
});

test('el título se recorta si el nombre de la empresa es largo', async () => {
  // MercadoPago rechaza títulos demasiado largos. Mismo cuidado que ya se
  // había tenido con `reason` en la suscripción.
  let body = null;
  await mp.createOneTimePaymentLink({
    ...base, tenantName: 'X'.repeat(400),
    fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 'pref-1', init_point: 'https://mp/pagar' }) };
    },
  });
  assert.ok(body.items[0].title.length <= 250);
});

test('devuelve el link para copiarle al cliente', async () => {
  const r = await mp.createOneTimePaymentLink({
    ...base,
    fetchImpl: async () => ({
      ok: true, json: async () => ({ id: 'pref-99', init_point: 'https://mp/pagar/99' }),
    }),
  });
  assert.equal(r.initPoint, 'https://mp/pagar/99');
  assert.equal(r.id, 'pref-99');
});

test('si MercadoPago rechaza, se propaga el motivo', async () => {
  await assert.rejects(
    mp.createOneTimePaymentLink({
      ...base,
      fetchImpl: async () => ({
        ok: false, status: 400,
        json: async () => ({ message: 'invalid unit_price' }),
      }),
    }),
    (err) => {
      assert.match(err.message, /invalid unit_price/);
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('el email del pagador es opcional', async () => {
  let body = null;
  await mp.createOneTimePaymentLink({
    ...base,
    fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 'p', init_point: 'u' }) };
    },
  });
  assert.equal(body.payer, undefined,
    'a diferencia de la suscripción, acá no hace falta: cualquiera puede pagar el link');

  await mp.createOneTimePaymentLink({
    ...base, payerEmail: 'cliente@ejemplo.com',
    fetchImpl: async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: 'p', init_point: 'u' }) };
    },
  });
  assert.equal(body.payer.email, 'cliente@ejemplo.com', 'pero si se pasa, se precarga');
});
