// Aprobar una baja tiene que cancelar el débito automático EN MercadoPago.
//
// EL HUECO (2026-09-23)
// ---------------------
// `approve-cancellation` solo ponía status='canceled' en NUESTRA base. A
// MercadoPago nunca se le avisaba, así que el débito automático seguía
// corriendo: al cliente le seguían cobrando todos los meses después de
// haberse dado de baja, y en la pantalla figuraba como dado de baja.
//
// Pregunta textual de quien opera el sistema: "no sé si yo al darle aprobar
// a la baja, le da la baja a esa suscripción a mercadopago".
//
// EL ORDEN IMPORTA, Y ES LO QUE MÁS CUIDAN ESTOS TESTS
// -----------------------------------------------------
// Primero se cancela en MercadoPago y recién después se marca acá. Si fuera
// al revés y MercadoPago fallara, la pantalla diría "dada de baja" mientras
// al cliente le siguen debitando -- el mismo problema de antes, pero ahora
// invisible porque la pantalla afirma que está resuelto.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mp = require('../motor-laboral/services/mercadopagoService');

test('cancelar manda PUT con status cancelled', async () => {
  let recibido = null;
  const r = await mp.cancelPreapproval({
    accessToken: 'token-de-prueba',
    preapprovalId: 'abc123',
    fetchImpl: async (url, opts) => {
      recibido = { url, method: opts.method, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
      return { ok: true, json: async () => ({ status: 'cancelled' }) };
    },
  });

  assert.equal(r.ok, true);
  assert.equal(recibido.method, 'PUT');
  assert.match(recibido.url, /preapproval\/abc123$/);
  // Con dos eles: así lo escribe MercadoPago.
  assert.equal(recibido.body.status, 'cancelled');
  assert.equal(recibido.auth, 'Bearer token-de-prueba');
});

test('que YA esté cancelada no es un error', async () => {
  // Si el cliente la canceló desde la app de MercadoPago y después se aprueba
  // la baja acá, el resultado buscado ya se cumplió: no hay que frenar la
  // baja por eso.
  const r = await mp.cancelPreapproval({
    accessToken: 'token-de-prueba',
    preapprovalId: 'abc123',
    fetchImpl: async () => ({
      ok: false, status: 400,
      json: async () => ({ message: 'The preapproval is already cancelled' }),
    }),
  });

  assert.equal(r.ok, true);
  assert.equal(r.yaEstaba, true);
});

test('un error de verdad SÍ tira, para que la baja no se marque igual', async () => {
  // Este es el punto: si MercadoPago no pudo cancelar, el endpoint tiene que
  // cortar y NO marcar la baja. Preferible que la pantalla diga "no se pudo"
  // a que diga "dada de baja" mientras le siguen cobrando.
  await assert.rejects(
    mp.cancelPreapproval({
      accessToken: 'token-de-prueba',
      preapprovalId: 'abc123',
      fetchImpl: async () => ({
        ok: false, status: 401,
        json: async () => ({ message: 'invalid access token' }),
      }),
    }),
    (err) => {
      assert.match(err.message, /invalid access token/);
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test('si MercadoPago responde algo que no es JSON, igual tira con algo legible', async () => {
  await assert.rejects(
    mp.cancelPreapproval({
      accessToken: 'token-de-prueba',
      preapprovalId: 'abc123',
      fetchImpl: async () => ({
        ok: false, status: 502,
        json: async () => { throw new Error('no es json'); },
      }),
    }),
    (err) => {
      assert.match(err.message, /cancelando la suscripción/i);
      return true;
    }
  );
});
