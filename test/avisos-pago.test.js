// Aviso cuando entra un pago por MercadoPago.
//
// POR QUE ESTE ES DISTINTO A LOS OTROS AVISOS
// --------------------------------------------
// Los otros tres (pedido de plan, de link de pago, de baja) los dispara
// alguien apretando un boton. Este no: el cobro por MercadoPago entra SOLO,
// por webhook, sin que nadie toque nada. Hasta ahora quedaba unicamente en un
// log del servidor -- o sea que un cliente podia pagar y nadie enterarse.
//
// Y por eso mismo la regla de oro importa el doble aca: si el aviso fallara y
// tirara, el webhook responderia con error y MercadoPago lo reintentaria; el
// pago se registraria DOS VECES. Un problema de Telegram se convertiria en un
// problema de facturacion.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const avisos = require('../avisos');
const { closeDb } = require('../test-helpers/firebaseTestAuth');

const TENANT_ID = 999936;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Panaderia La Esquina (test)', 'tenant-avisos-pago-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_ID]);
});

after(async () => {
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]);
  await db.query('DELETE FROM app_settings WHERE name = ? AND tenant_id IS NULL',
    [avisos.CLAVE_TELEGRAM_DESTINO]);
  await db.end().catch(() => {});
  await closeDb();
});

test('el aviso dice el NOMBRE de la empresa, no el numero', async () => {
  // "Empresa 6 pagó" no sirve para nada: hay que poder leerlo de un vistazo
  // en el celular y saber de quien se trata.
  assert.equal(await avisos.nombreDeEmpresa(TENANT_ID, db), 'Panaderia La Esquina (test)');
});

test('si no se puede leer el nombre, igual se avisa con algo', async () => {
  // Un problema para leer el nombre no puede impedir el aviso de un pago.
  assert.equal(await avisos.nombreDeEmpresa(999999999, db), 'Empresa 999999999');

  const dbRoto = { query: async () => { throw new Error('base caida'); } };
  assert.equal(await avisos.nombreDeEmpresa(7, dbRoto), 'Empresa 7');
});

test('el mensaje de cobro incluye el monto y hasta cuando queda paga', async () => {
  await avisos.guardarDestinatariosTelegram(['111'], db);
  const tokenPrevio = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  const enviados = [];
  const fetchPrevio = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      enviados.push(JSON.parse(opts.body).text);
      return { ok: true, status: 200 };
    };
    await avisos.avisar('cobrado', {
      empresa: 'Panaderia La Esquina (test)',
      detalle: 'ARS 25000 · período hasta 2026-10-23',
    }, db);
  } finally {
    global.fetch = fetchPrevio;
    if (tokenPrevio === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = tokenPrevio;
  }

  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /pagó/);
  assert.match(enviados[0], /Panaderia La Esquina/);
  assert.match(enviados[0], /ARS 25000/);
  assert.match(enviados[0], /2026-10-23/);
  assert.match(enviados[0], /facturacion/, 'con el link para ir a ver');
});

test('LA REGLA DE ORO, que acá pesa el doble: avisar no puede tirar nunca', async () => {
  // Si tirara, el webhook devolveria error, MercadoPago reintentaria y el
  // pago se registraria dos veces.
  await avisos.guardarDestinatariosTelegram(['111'], db);
  const tokenPrevio = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  const fetchPrevio = global.fetch;
  try {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await avisos.avisar('cobrado', { empresa: 'X', detalle: 'ARS 1' }, db);

    global.fetch = async () => ({ ok: false, status: 500 });
    await avisos.avisar('suscripcion', { empresa: 'X', detalle: 'authorized' }, db);
    // Llegar hasta aca sin excepcion es el test.
  } finally {
    global.fetch = fetchPrevio;
    if (tokenPrevio === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = tokenPrevio;
  }
});

test('el cambio de estado de la suscripción también avisa', async () => {
  await avisos.guardarDestinatariosTelegram(['111'], db);
  const tokenPrevio = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  const enviados = [];
  const fetchPrevio = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      enviados.push(JSON.parse(opts.body).text);
      return { ok: true, status: 200 };
    };
    await avisos.avisar('suscripcion', {
      empresa: 'Panaderia La Esquina (test)',
      detalle: 'MercadoPago dice: cancelled → queda en "canceled".',
    }, db);
  } finally {
    global.fetch = fetchPrevio;
    if (tokenPrevio === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = tokenPrevio;
  }

  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /cancelled/, 'tiene que decir qué pasó, no solo que algo cambió');
});
