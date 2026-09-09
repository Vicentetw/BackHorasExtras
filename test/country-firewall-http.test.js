// Fase 19: firewall por pais/IP -- prueba de punta a punta contra el
// server real (routes/public.js -> countryFirewallMiddleware ->
// app_settings). Usa /api/public/chat con un lead que ya alcanzo el
// limite de preguntas (chat_questions_used=6): eso da una respuesta
// 200/limitReached DETERMINISTICA sin depender de ANTHROPIC_API_KEY --
// alcanza para distinguir "el firewall lo dejo pasar" (200) de "el
// firewall lo bloqueo" (403), que es lo unico que este archivo prueba.
//
// IMPORTANTE: esto pisa la config REAL de firewall del sistema mientras
// corre -- se guarda el valor original en before() y se restaura en
// after(), pase lo que pase, para no dejar el sistema bloqueado despues
// de correr los tests.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, closeDb } = require('../test-helpers/firebaseTestAuth');
const { resolveCountry } = require('../motor-laboral/services/countryFirewallService');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-country-firewall-http';
// IP publica real y estable (DNS de Google) -- sirve para tener una IP
// que geoip-lite pueda resolver de verdad, sin depender de que el que
// corre el test tenga una IP publica conocida.
const KNOWN_PUBLIC_IP = '8.8.8.8';

let headers;
let originalSettings;
let leadId;
let realCountry;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true });

  const getRes = await fetch(`${BASE_URL}/api/labor-engine/admin/system/firewall-settings`, { headers });
  originalSettings = await getRes.json();

  realCountry = resolveCountry(KNOWN_PUBLIC_IP);

  const [leadResult] = await db.query(
    `INSERT INTO signup_leads (name, company_name, email, status, chat_questions_used) VALUES ('T', 'T', ?, 'provisioned', 6)`,
    [`test-firewall-http-${Date.now()}@example.com`]
  );
  leadId = leadResult.insertId;
});

after(async () => {
  await fetch(`${BASE_URL}/api/labor-engine/admin/system/firewall-settings`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      allowedCountries: originalSettings.allowedCountries,
      allowedIps: originalSettings.allowedIps
    })
  });
  await db.query('DELETE FROM signup_leads WHERE id = ?', [leadId]).catch(() => {});
  await closeDb();
});

async function setFirewall({ allowedCountries = [], allowedIps = [] }) {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/system/firewall-settings`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowedCountries, allowedIps })
  });
  assert.equal(res.status, 200, 'no se pudo configurar el firewall para el test');
}

async function chatFromIp(ip) {
  return fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ leadId, message: 'hola' })
  });
}

test('GET /system/firewall-settings: solo superadmin', async () => {
  const noAuthRes = await fetch(`${BASE_URL}/api/labor-engine/admin/system/firewall-settings`);
  assert.equal(noAuthRes.status, 401);
});

test('PUT /system/firewall-settings: rechaza un codigo de pais invalido, no guarda nada', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/admin/system/firewall-settings`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowedCountries: ['Argentina'], allowedIps: [] })
  });
  assert.equal(res.status, 400);
});

test('firewall desactivado (sin paises configurados): deja pasar cualquier IP', async () => {
  await setFirewall({ allowedCountries: [] });
  const res = await chatFromIp(KNOWN_PUBLIC_IP);
  assert.notEqual(res.status, 403);
  const json = await res.json();
  assert.equal(json.limitReached, true);
});

test('firewall activado con el pais real de la IP: deja pasar', async () => {
  if (!realCountry) {
    console.log(`  (saltado: geoip-lite no resolvio pais para ${KNOWN_PUBLIC_IP} en esta instalacion)`);
    return;
  }
  await setFirewall({ allowedCountries: [realCountry] });
  const res = await chatFromIp(KNOWN_PUBLIC_IP);
  assert.notEqual(res.status, 403);
});

test('firewall activado SIN el pais de la IP en la lista: bloquea con 403', async () => {
  // 'ZZ' no es un codigo ISO real -- por construccion nunca puede
  // coincidir con el pais verdadero de ninguna IP.
  await setFirewall({ allowedCountries: ['ZZ'] });
  const res = await chatFromIp(KNOWN_PUBLIC_IP);
  assert.equal(res.status, 403);
});

test('una IP en la lista de excepciones pasa aunque su pais este bloqueado', async () => {
  await setFirewall({ allowedCountries: ['ZZ'], allowedIps: [KNOWN_PUBLIC_IP] });
  const res = await chatFromIp(KNOWN_PUBLIC_IP);
  assert.notEqual(res.status, 403);
});

test('una IP privada/no resoluble nunca se bloquea (fail-open)', async () => {
  await setFirewall({ allowedCountries: ['ZZ'] });
  const res = await chatFromIp('127.0.0.1');
  assert.notEqual(res.status, 403);
});
