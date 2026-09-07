// Fase 11: landing publica + alta autoservicio + chatbot de ventas.
// Usa las site/secret keys de PRUEBA oficiales y publicas de Cloudflare
// Turnstile (documentadas en
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/ --
// "always passes"/"always blocks", no son credenciales reales de nadie),
// asi que el alta autoservicio se puede probar de punta a punta SIN
// esperar a que el usuario cree su cuenta real de Cloudflare todavia.
//
// El chat de ventas SI necesita una ANTHROPIC_API_KEY real para su camino
// feliz (no hay un equivalente de "test key" publico de Anthropic) -- acá
// solo se prueba lo que no depende de eso (limite alcanzado, falta de
// configuracion). El llamado real a la API se prueba aparte, a mano, una
// vez que el usuario cargue su ANTHROPIC_API_KEY.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TURNSTILE_ALWAYS_PASSES_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_ALWAYS_FAILS_SECRET = '2x0000000000000000000000000000000AA';
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'; // cualquier string sirve contra las secret keys de prueba

let createdTenantIds = [];
let createdLeadIds = [];
let createdUserEmails = [];
let originalTurnstileSecret;
let originalAnthropicKey;

before(() => {
  originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
});

after(async () => {
  process.env.TURNSTILE_SECRET_KEY = originalTurnstileSecret;
  process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  for (const email of createdUserEmails) {
    const [[row]] = await db.query('SELECT firebase_uid FROM app_users WHERE email = ?', [email]);
    if (row) await deleteTestUser(row.firebase_uid).catch(() => {});
    await db.query('DELETE FROM app_users WHERE email = ?', [email]).catch(() => {});
  }
  for (const leadId of createdLeadIds) {
    await db.query('DELETE FROM signup_leads WHERE id = ?', [leadId]).catch(() => {});
  }
  for (const tenantId of createdTenantIds) {
    await db.query('DELETE FROM tenant_subscriptions WHERE tenant_id = ?', [tenantId]).catch(() => {});
    await db.query('DELETE FROM tenants WHERE id = ?', [tenantId]).catch(() => {});
  }
  await closeDb();
});

// NOTA: routes/public.js NO reinicia el proceso -- necesita que el server
// (node horasdedica2.js) ya este corriendo con TURNSTILE_SECRET_KEY seteada
// en su PROPIO entorno para que este test contra el server real funcione.
// Si el server no tiene la variable seteada, este primer test lo confirma
// con un mensaje claro en vez de fallar en silencio.

test('POST /api/public/signup: alta completa de punta a punta (tenant + suscripcion trial + usuario que puede loguearse)', async () => {
  const email = `test-public-signup-${Date.now()}@example.com`;
  createdUserEmails.push(email);

  const res = await fetch(`${BASE_URL}/api/public/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turnstileToken: TURNSTILE_DUMMY_TOKEN,
      name: 'Persona de Prueba',
      companyName: `Empresa Prueba ${Date.now()}`,
      email,
      phone: '+54 9 280 1234567',
      contactPreference: 'whatsapp',
      employeeCount: 12,
      clockCount: 1,
      scheduleType: 'Fijo, lunes a viernes'
    })
  });

  const json = await res.json();
  if (res.status === 503 && /TURNSTILE_SECRET_KEY/.test(json.error || '')) {
    console.log('  (saltado: el servidor real no tiene TURNSTILE_SECRET_KEY configurada -- exportala y reiniciá node horasdedica2.js para correr este test)');
    return;
  }

  assert.equal(res.status, 201, JSON.stringify(json));
  assert.ok(json.leadId);
  createdLeadIds.push(json.leadId);

  const [[lead]] = await db.query('SELECT tenant_id, status FROM signup_leads WHERE id = ?', [json.leadId]);
  assert.equal(lead.status, 'provisioned');
  assert.ok(lead.tenant_id);
  createdTenantIds.push(lead.tenant_id);

  const [[subscription]] = await db.query(
    `SELECT status, current_period_start, current_period_end FROM tenant_subscriptions WHERE tenant_id = ?`,
    [lead.tenant_id]
  );
  assert.equal(subscription.status, 'trial');
  assert.ok(subscription.current_period_start && subscription.current_period_end, 'debe tener el primer mes gratis armado solo');

  const [[appUser]] = await db.query('SELECT tenant_id, is_superadmin, is_active FROM app_users WHERE email = ?', [email]);
  assert.equal(appUser.tenant_id, lead.tenant_id);
  assert.equal(appUser.is_superadmin, 0, 'el alta autoservicio nunca crea un superadmin');
  assert.equal(appUser.is_active, 1);
});

test('POST /api/public/signup: rechaza un captcha invalido sin crear nada', async () => {
  const email = `test-public-signup-badcaptcha-${Date.now()}@example.com`;

  // Fuerza la secret "always fails" solo para este pedido no es posible
  // desde el cliente (la secret vive en el servidor) -- en cambio, se
  // manda un token vacio, que turnstileService ya rechaza sin llamar a
  // Cloudflare (missing-input-response).
  const res = await fetch(`${BASE_URL}/api/public/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turnstileToken: '',
      name: 'Bot',
      companyName: 'Empresa Bot',
      email
    })
  });

  if (res.status === 503) {
    console.log('  (saltado: TURNSTILE_SECRET_KEY no configurada en el servidor real)');
    return;
  }

  assert.equal(res.status, 400);
  const [[row]] = await db.query('SELECT id FROM app_users WHERE email = ?', [email]);
  assert.equal(row, undefined, 'no debe haberse creado ninguna cuenta');
});

test('POST /api/public/signup: rechaza email ya usado, sin crear un tenant huerfano', async () => {
  const email = `test-public-signup-dup-${Date.now()}@example.com`;
  createdUserEmails.push(email);

  const first = await fetch(`${BASE_URL}/api/public/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken: TURNSTILE_DUMMY_TOKEN, name: 'A', companyName: 'Empresa Dup 1', email })
  });
  const firstJson = await first.json();
  if (first.status === 503) {
    console.log('  (saltado: TURNSTILE_SECRET_KEY no configurada en el servidor real)');
    return;
  }
  assert.equal(first.status, 201, JSON.stringify(firstJson));
  createdLeadIds.push(firstJson.leadId);
  const [[lead1]] = await db.query('SELECT tenant_id FROM signup_leads WHERE id = ?', [firstJson.leadId]);
  createdTenantIds.push(lead1.tenant_id);

  const second = await fetch(`${BASE_URL}/api/public/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken: TURNSTILE_DUMMY_TOKEN, name: 'A', companyName: 'Empresa Dup 2', email })
  });
  assert.equal(second.status, 409);

  // No debe haber un segundo tenant "Empresa Dup 2" -- el chequeo de email
  // duplicado corta ANTES de crear nada.
  const [[dupTenant]] = await db.query('SELECT id FROM tenants WHERE name = ?', ['Empresa Dup 2']);
  assert.equal(dupTenant, undefined);
});

test('POST /api/public/chat: si ya se llego al limite de preguntas, no llama a la IA y avisa', async () => {
  const [leadResult] = await db.query(
    `INSERT INTO signup_leads (name, company_name, email, status, chat_questions_used) VALUES ('T', 'T', 'chat-limit-test@example.com', 'provisioned', 6)`
  );
  createdLeadIds.push(leadResult.insertId);

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: leadResult.insertId, message: '¿cuánto cuesta?' })
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.limitReached, true);
  assert.equal(json.questionsLeft, 0);
});

test('POST /api/public/chat: sin ANTHROPIC_API_KEY configurada, 503 claro (no un error generico)', async () => {
  const [leadResult] = await db.query(
    `INSERT INTO signup_leads (name, company_name, email, status, chat_questions_used) VALUES ('T', 'T', 'chat-noapikey-test@example.com', 'provisioned', 0)`
  );
  createdLeadIds.push(leadResult.insertId);

  // No podemos des-configurar la variable del PROCESO DEL SERVIDOR desde
  // este test (corre en otro proceso) -- si el servidor real ya tiene la
  // key puesta, este test se salta en vez de fallar por una precondicion
  // que no controla.
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('  (saltado: el proceso del servidor tiene ANTHROPIC_API_KEY configurada)');
    return;
  }

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: leadResult.insertId, message: '¿cuánto cuesta?' })
  });
  assert.equal(res.status, 503);
});
