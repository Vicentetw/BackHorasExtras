// Que un pago no se registre dos veces.
//
// EL PROBLEMA
// -----------
// MercadoPago REINTENTA los webhooks: si el servidor no contesta rápido, o
// contesta con error, manda la misma notificación otra vez. Sin protección,
// el mismo pago se registra dos veces y CADA REGISTRO EXTIENDE EL PERÍODO --
// el cliente queda pago hasta dentro de dos meses habiendo pagado uno.
//
// Reportado en la práctica: "probando, un cliente puede pagar varias veces y
// el botón para pagar sigue activo, no hay registro de pagado tampoco".
//
// Hay DOS redes, y las dos se prueban acá:
//   1. el registro de eventos del webhook (no se reprocesa lo ya procesado);
//   2. la clave única (method, reference) en payment_records.
//
// Dos y no una porque fallan distinto: la primera evita el trabajo y el
// aviso duplicado; la segunda es la que garantiza que el período no se
// extienda dos veces, aunque la primera falle.
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const eventsRepo = require('../motor-laboral/repositories/mercadopagoEventsRepository');
const { closeDb } = require('../test-helpers/firebaseTestAuth');

const TENANT_ID = 999937;
const REFERENCIA = 'mp-pago-de-prueba-1';

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Idempotencia (test)', 'tenant-idem-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT_ID]);
  await db.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_id, billing_period, status)
     SELECT ?, p.id, 'monthly', 'active' FROM plans p LIMIT 1
     ON DUPLICATE KEY UPDATE status = 'active'`, [TENANT_ID]);
});

beforeEach(async () => {
  await db.query('DELETE FROM mercadopago_events WHERE tenant_id = ? OR tenant_id IS NULL AND resource_id LIKE ?',
    [TENANT_ID, 'test-%']);
  await db.query('DELETE FROM payment_records WHERE tenant_id = ?', [TENANT_ID]);
});

after(async () => {
  await db.query('DELETE FROM mercadopago_events WHERE tenant_id = ? OR resource_id LIKE ?', [TENANT_ID, 'test-%']);
  await db.query('DELETE FROM payment_records WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenant_subscriptions WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]);
  await db.end().catch(() => {});
  await closeDb();
});

const pago = (periodStart, periodEnd) => ({
  tenantId: TENANT_ID, amountUsd: 100, amountLocal: 25000, localCurrency: 'ARS',
  method: 'mercadopago', reference: REFERENCIA, periodStart, periodEnd, recordedBy: null,
});

// ---------------------------------------------------------------------------
// Red 2: la clave única
// ---------------------------------------------------------------------------

test('el mismo pago dos veces deja UNA sola fila', async () => {
  const id1 = await billingRepo.recordPayment(pago('2026-09-01', '2026-10-01'), db);
  const id2 = await billingRepo.recordPayment(pago('2026-09-01', '2026-10-01'), db);

  const [filas] = await db.query(
    'SELECT id FROM payment_records WHERE tenant_id = ? AND reference = ?', [TENANT_ID, REFERENCIA]);
  assert.equal(filas.length, 1, 'una sola fila');
  assert.equal(id2, id1, 'y devuelve el id del pago que ya estaba, no null');
});

test('LO QUE MÁS IMPORTA: el período NO se extiende dos veces', async () => {
  // Este es el daño concreto. Registrar la fila dos veces sería feo; extender
  // el período dos veces es regalarle un mes al cliente.
  await billingRepo.recordPayment(pago('2026-09-01', '2026-10-01'), db);
  const [[despuesDelPrimero]] = await db.query(
    'SELECT current_period_end FROM tenant_subscriptions WHERE tenant_id = ?', [TENANT_ID]);

  // El reintento llega con un período más adelantado, como pasaría de verdad
  // si el cálculo se rehiciera sobre el período ya extendido.
  await billingRepo.recordPayment(pago('2026-10-01', '2026-11-01'), db);
  const [[despuesDelSegundo]] = await db.query(
    'SELECT current_period_end FROM tenant_subscriptions WHERE tenant_id = ?', [TENANT_ID]);

  assert.deepEqual(despuesDelSegundo.current_period_end, despuesDelPrimero.current_period_end,
    'el reintento no puede mover el vencimiento');
});

test('dos pagos DISTINTOS sí se registran los dos', async () => {
  // Que no se pase de celoso: un cliente puede pagar dos veces de verdad.
  await billingRepo.recordPayment({ ...pago('2026-09-01', '2026-10-01'), reference: 'mp-1' }, db);
  await billingRepo.recordPayment({ ...pago('2026-10-01', '2026-11-01'), reference: 'mp-2' }, db);

  const [filas] = await db.query(
    'SELECT id FROM payment_records WHERE tenant_id = ?', [TENANT_ID]);
  assert.equal(filas.length, 2);
});

test('los pagos manuales sin referencia no se estorban entre sí', async () => {
  // reference es NULL en un pago manual sin comprobante, y MySQL trata cada
  // NULL como distinto: la clave única no los agrupa. Si los agrupara, no se
  // podrían cargar dos pagos manuales seguidos.
  await billingRepo.recordPayment(
    { ...pago('2026-09-01', '2026-10-01'), method: 'manual', reference: null }, db);
  await billingRepo.recordPayment(
    { ...pago('2026-10-01', '2026-11-01'), method: 'manual', reference: null }, db);

  const [filas] = await db.query(
    "SELECT id FROM payment_records WHERE tenant_id = ? AND method = 'manual'", [TENANT_ID]);
  assert.equal(filas.length, 2, 'dos pagos manuales distintos');
});

test('la misma referencia pero de otro método no choca', async () => {
  // Un pago manual puede tener como referencia "12345" (un número de
  // transferencia) y coincidir con el id de un pago de MercadoPago. No son
  // lo mismo.
  await billingRepo.recordPayment({ ...pago('2026-09-01', '2026-10-01'), reference: '12345' }, db);
  await billingRepo.recordPayment(
    { ...pago('2026-10-01', '2026-11-01'), method: 'manual', reference: '12345' }, db);

  const [filas] = await db.query(
    'SELECT method FROM payment_records WHERE tenant_id = ? AND reference = ?', [TENANT_ID, '12345']);
  assert.equal(filas.length, 2);
});

// ---------------------------------------------------------------------------
// Red 1: el registro de eventos
// ---------------------------------------------------------------------------

test('el mismo evento dos veces se reconoce como ya procesado', async () => {
  const e1 = await eventsRepo.registrarRecepcion(
    { eventType: 'payment', resourceId: 'test-111', payload: { hola: 1 } }, db);
  assert.equal(e1.yaProcesado, false, 'la primera vez hay que procesarlo');
  await eventsRepo.marcarResultado(e1.id, { status: 'procesado', tenantId: TENANT_ID }, db);

  const e2 = await eventsRepo.registrarRecepcion(
    { eventType: 'payment', resourceId: 'test-111', payload: { hola: 1 } }, db);
  assert.equal(e2.id, e1.id, 'no se crea otra fila');
  assert.equal(e2.yaProcesado, true, 'la segunda vez no se reprocesa');

  const [[fila]] = await db.query('SELECT attempts FROM mercadopago_events WHERE id = ?', [e1.id]);
  assert.equal(fila.attempts, 2, 'pero queda anotado que MercadoPago reintentó');
});

test('un evento que quedó EN ERROR sí se reintenta', async () => {
  // Es la mitad que se olvida: si la primera vez falló, el reintento de
  // MercadoPago es la segunda oportunidad. Tratarlo como "ya procesado"
  // perdería el pago para siempre.
  const e1 = await eventsRepo.registrarRecepcion(
    { eventType: 'payment', resourceId: 'test-222', payload: {} }, db);
  await eventsRepo.marcarResultado(e1.id, { status: 'error', error: 'se cayó la red' }, db);

  const e2 = await eventsRepo.registrarRecepcion(
    { eventType: 'payment', resourceId: 'test-222', payload: {} }, db);
  assert.equal(e2.yaProcesado, false, 'un error anterior NO bloquea el reintento');
});

test('el payload crudo queda guardado, que es lo que se mira cuando algo no cierra', async () => {
  const e = await eventsRepo.registrarRecepcion({
    eventType: 'payment', resourceId: 'test-333',
    payload: { action: 'payment.created', data: { id: '999' } },
  }, db);

  const [[fila]] = await db.query('SELECT payload FROM mercadopago_events WHERE id = ?', [e.id]);
  const guardado = typeof fila.payload === 'string' ? JSON.parse(fila.payload) : fila.payload;
  assert.equal(guardado.data.id, '999');
});

test('eventos de distinto tipo sobre el mismo recurso son distintos', async () => {
  // Un pago genera 'payment.created' y después 'payment.updated' sobre el
  // mismo id. Son dos hechos, no un reintento.
  const a = await eventsRepo.registrarRecepcion(
    { eventType: 'payment', resourceId: 'test-444', payload: {} }, db);
  const b = await eventsRepo.registrarRecepcion(
    { eventType: 'subscription_preapproval', resourceId: 'test-444', payload: {} }, db);
  assert.notEqual(a.id, b.id);
});
