// Avisos al superadmin (avisos.js): la campanita y el aviso por Telegram.
//
// Por que existe este archivo, y sobre todo por que el ultimo bloque:
// avisar() se llama JUSTO DESPUES de guardar el pedido de un cliente. Si
// avisar() llegara a tirar una excepcion, el endpoint responderia 500 y el
// cliente creeria que su pedido no se registro -- cuando en realidad SI se
// guardo. Peor todavia: reintentaria, y quedarian dos. O sea que un problema
// con Telegram (un token vencido, la API caida, un chat_id mal escrito) se
// transformaria en un problema de facturacion. Esa es la regla que estos
// tests cuidan: avisar NUNCA puede romper lo que lo disparo.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const avisos = require('../avisos');
const { closeDb } = require('../test-helpers/firebaseTestAuth');

const TENANT_A = 999931;
const TENANT_B = 999932;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES
       (?, 'Tenant Avisos A (test)', 'tenant-avisos-a-test'),
       (?, 'Tenant Avisos B (test)', 'tenant-avisos-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A, TENANT_B]
  );
});

after(async () => {
  await db.query('DELETE FROM plan_requests WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM tenant_subscriptions WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM app_settings WHERE name = ? AND tenant_id IS NULL', [avisos.CLAVE_TELEGRAM_DESTINO]);
  await db.end().catch(() => {});
  await closeDb();
});

// ---------------------------------------------------------------------------
// La campanita
// ---------------------------------------------------------------------------

test('cuenta por separado los tres tipos de pedido', async () => {
  const antes = await avisos.contarPendientes(db);

  await db.query(
    `INSERT INTO plan_requests (tenant_id, employee_count) VALUES (?, 12)`, [TENANT_A]);
  // Una suscripcion que pidio el link de pago Y la baja: son dos pendientes
  // distintos sobre la misma fila, y tienen que contarse los dos.
  await db.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_id, billing_period, status,
       payment_requested_at, cancellation_requested_at)
     SELECT ?, p.id, 'monthly', 'active', NOW(), NOW() FROM plans p LIMIT 1`, [TENANT_B]);

  const d = await avisos.contarPendientes(db);
  assert.equal(d.pedidosDePlan, antes.pedidosDePlan + 1);
  assert.equal(d.pedidosDeLinkDePago, antes.pedidosDeLinkDePago + 1);
  assert.equal(d.pedidosDeBaja, antes.pedidosDeBaja + 1);
  assert.equal(d.total, antes.total + 3, 'el total es la suma de los tres');
});

test('el detalle dice que empresa pidio que cosa, y lo mas viejo va primero', async () => {
  const filas = await avisos.listarPendientes(db);

  const plan = filas.find((f) => f.tenantId === TENANT_A && f.tipo === 'plan');
  assert.ok(plan, 'tiene que aparecer el pedido de plan');
  assert.equal(plan.empresa, 'Tenant Avisos A (test)', 'con el nombre de la empresa, no solo el id');
  assert.equal(plan.etiqueta, 'pidió un plan');

  const tipos = filas.filter((f) => f.tenantId === TENANT_B).map((f) => f.tipo).sort();
  assert.deepEqual(tipos, ['baja', 'pago'], 'los dos pendientes de la misma empresa aparecen separados');

  const fechas = filas.map((f) => new Date(f.fecha).getTime());
  assert.deepEqual(fechas, [...fechas].sort((a, b) => a - b),
    'ordenado de mas viejo a mas nuevo: lo que mas espera, primero');
});

// ---------------------------------------------------------------------------
// Destinatarios de Telegram
// ---------------------------------------------------------------------------

test('guardar los destinatarios y volver a leerlos', async () => {
  const guardados = await avisos.guardarDestinatariosTelegram(['123456', '-100999'], db);
  assert.deepEqual(guardados, ['123456', '-100999'], 'un grupo tiene chat_id negativo, tiene que aceptarse');
  assert.deepEqual(await avisos.destinatariosTelegram(db), ['123456', '-100999']);
});

test('guardar dos veces no deja dos filas', async () => {
  // La clave unica de app_settings va sobre una columna generada que
  // convierte NULL en -1 (ver 20260905b_app_settings_unique_key.sql). Sin
  // eso, MySQL trata cada NULL como distinto y el upsert insertaria una fila
  // nueva cada vez -- y despues el motor elegiria una al azar.
  await avisos.guardarDestinatariosTelegram(['111'], db);
  await avisos.guardarDestinatariosTelegram(['222'], db);
  const [filas] = await db.query(
    'SELECT COUNT(*) k FROM app_settings WHERE name = ? AND tenant_id IS NULL',
    [avisos.CLAVE_TELEGRAM_DESTINO]);
  assert.equal(filas[0].k, 1, 'una sola fila, con el ultimo valor');
  assert.deepEqual(await avisos.destinatariosTelegram(db), ['222']);
});

test('sin destinatarios configurados, la lista es vacia y no explota', async () => {
  await avisos.guardarDestinatariosTelegram([], db);
  assert.deepEqual(await avisos.destinatariosTelegram(db), []);
});

// ---------------------------------------------------------------------------
// El envio
// ---------------------------------------------------------------------------

test('manda un mensaje por cada destinatario', async () => {
  await avisos.guardarDestinatariosTelegram(['111', '222'], db);
  const tokenPrevio = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  const llamadas = [];
  try {
    const r = await avisos.enviarTelegram('hola', db, {
      fetchImpl: async (url, opts) => {
        llamadas.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200 };
      },
    });
    assert.equal(r.enviados, 2);
    assert.deepEqual(llamadas.map((l) => l.body.chat_id), ['111', '222']);
    assert.equal(llamadas[0].body.text, 'hola');
    assert.ok(llamadas[0].url.includes('token-de-prueba'), 'el token va en la URL del bot');
  } finally {
    if (tokenPrevio === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = tokenPrevio;
  }
});

test('sin token configurado no intenta nada y lo dice', async () => {
  const tokenPrevio = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const r = await avisos.enviarTelegram('hola', db, {
      fetchImpl: async () => { throw new Error('no se tendria que haber llamado'); },
    });
    assert.equal(r.enviados, 0);
    assert.match(r.motivo, /TELEGRAM_BOT_TOKEN/);
  } finally {
    if (tokenPrevio !== undefined) process.env.TELEGRAM_BOT_TOKEN = tokenPrevio;
  }
});

// ---------------------------------------------------------------------------
// LA REGLA DE ORO
// ---------------------------------------------------------------------------

test('avisar() no tira nunca, aunque Telegram falle de la peor manera', async () => {
  await avisos.guardarDestinatariosTelegram(['111'], db);
  const tokenPrevio = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  const fetchPrevio = global.fetch;
  try {
    // El peor caso: la red se cae en el medio.
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await avisos.avisar('pago', { empresa: 'Tenant Avisos A (test)' }, db);

    // Y el otro peor caso: la API responde un error.
    global.fetch = async () => ({ ok: false, status: 401 });
    await avisos.avisar('plan', { empresa: 'Tenant Avisos A (test)' }, db);

    // Si llegamos hasta aca sin excepcion, el endpoint que llamo a avisar()
    // va a poder responder 201 y el pedido del cliente queda guardado.
  } finally {
    global.fetch = fetchPrevio;
    if (tokenPrevio === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = tokenPrevio;
  }
});

test('avisar() con un tipo que no existe no hace nada ni rompe', async () => {
  await avisos.avisar('inventado', { empresa: 'X' }, db);
});
