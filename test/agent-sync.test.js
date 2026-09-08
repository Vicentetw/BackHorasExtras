// Fase 18 -- agente de sincronizacion de relojes (descarga-fichaje-py
// corriendo desatendido en la PC de cada sitio, sin sesion de Firebase).
// Cubre: administracion de claves (generar/pausar/revocar, solo
// superadmin), autenticacion por clave en /api/agent/*, y que
// checkins/users terminen en las mismas tablas que ya usa el import
// manual (Checkins/users), con el mismo dedupe.
//
// Tenant descartable propio (999999), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_AGENT = 999999;
const UID_SUPERADMIN = 'test-agent-sync-superadmin';
const UID_TENANT = 'test-agent-sync-tenant';

let headersSuperadmin;
let headersTenant;
let agentKeyId;
let agentKeyPlaintext;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Agente (test)', 'tenant-agente-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_AGENT]
  );
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
  headersTenant = await getTestAuthHeaders(UID_TENANT, { isSuperadmin: false, tenantId: TENANT_AGENT });
});

after(async () => {
  await db.query(`DELETE FROM Checkins WHERE USERID IN (SELECT USERID FROM users WHERE Badgenumber LIKE 'agent-test-%')`).catch(() => {});
  await db.query(`DELETE FROM users WHERE Badgenumber LIKE 'agent-test-%'`);
  await db.query(`DELETE FROM Checkins WHERE USERID BETWEEN 970000 AND 970100`);
  // Fase 18 (continuacion) -- subir fichajes via el agente ahora tambien
  // registra agent_sync_status por reloj; sin borrarlo primero, el DELETE
  // de tenants de abajo rompe por la foreign key.
  await db.query(`DELETE FROM agent_sync_status WHERE tenant_id = ?`, [TENANT_AGENT]);
  await db.query(`DELETE FROM tenant_agent_keys WHERE tenant_id = ?`, [TENANT_AGENT]);
  await deleteTestUser(UID_SUPERADMIN);
  await deleteTestUser(UID_TENANT);
  await db.query(`DELETE FROM tenants WHERE id = ?`, [TENANT_AGENT]);
  await closeDb();
});

test('POST /api/agent-keys: solo superadmin puede generar una clave', async () => {
  const denied = await fetch(`${BASE_URL}/api/agent-keys`, {
    method: 'POST',
    headers: { ...headersTenant, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_AGENT, label: 'test' })
  });
  assert.equal(denied.status, 403);

  const res = await fetch(`${BASE_URL}/api/agent-keys`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_AGENT, label: 'Escuela de prueba' })
  });
  const json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));
  assert.match(json.key, /^hda_[0-9a-f]{12}_[0-9a-f]{64}$/);
  agentKeyId = json.id;
  agentKeyPlaintext = json.key;
});

test('GET /api/agent-keys?tenantId=: la lista NO trae la clave en texto plano', async () => {
  const res = await fetch(`${BASE_URL}/api/agent-keys?tenantId=${TENANT_AGENT}`, { headers: headersSuperadmin });
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  assert.ok(!('key_hash' in rows[0]), 'el hash no deberia viajar al frontend');
  assert.ok(!JSON.stringify(rows[0]).includes(agentKeyPlaintext), 'la clave real nunca debe volver a aparecer');
});

test('POST /api/agent/checkins: sin clave o con clave invalida, 401', async () => {
  const sinClave = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [] })
  });
  assert.equal(sinClave.status, 401);

  const claveInvalida = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': 'hda_000000000000_' + '0'.repeat(64) },
    body: JSON.stringify({ records: [] })
  });
  assert.equal(claveInvalida.status, 401);
});

test('POST /api/agent/checkins: con la clave real, inserta y dedupea igual que el import manual', async () => {
  const records = [
    { USERID: '970001', CHECKTIME: '2026-09-13 08:00:00', MACHINE_IP: '192.168.1.10', MACHINE_SN: 'ZK001' },
    { USERID: '970001', CHECKTIME: '2026-09-13 17:00:00', MACHINE_IP: '192.168.1.10', MACHINE_SN: 'ZK001' }
  ];
  const res = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKeyPlaintext },
    body: JSON.stringify({ records })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.inserted, 2);

  // Reintento del MISMO lote (simula un corte de red justo despues de que
  // el servidor ya proceso el primer envio) -- no debe duplicar nada.
  const retryRes = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKeyPlaintext },
    body: JSON.stringify({ records })
  });
  assert.equal(retryRes.status, 200);

  const [[{ c }]] = await db.query(`SELECT COUNT(*) AS c FROM Checkins WHERE USERID = 970001`);
  assert.equal(c, 2, 'el reintento no debe haber duplicado los fichajes');
});

test('POST /api/agent/checkins: un lote mas grande que el limite se rechaza con 413', async () => {
  const records = Array.from({ length: 5001 }, (_, i) => ({ USERID: String(970002), CHECKTIME: '2026-09-13 08:00:00' }));
  const res = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKeyPlaintext },
    body: JSON.stringify({ records })
  });
  assert.equal(res.status, 413);
});

test('POST /api/agent/users: upsert de usuarios del reloj vía agente', async () => {
  const res = await fetch(`${BASE_URL}/api/agent/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKeyPlaintext },
    body: JSON.stringify({ records: [{ USERID: 970050, Badgenumber: 'agent-test-1', Name: 'Empleado Agente' }] })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.upserted, 1);

  const [[row]] = await db.query(`SELECT Name FROM users WHERE Badgenumber = 'agent-test-1'`);
  assert.equal(row.Name, 'Empleado Agente');
});

test('pausar la clave: el agente deja de poder sincronizar', async () => {
  const pause = await fetch(`${BASE_URL}/api/agent-keys/${agentKeyId}/status`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'paused' })
  });
  assert.equal(pause.status, 200);

  const res = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKeyPlaintext },
    body: JSON.stringify({ records: [{ USERID: '970099', CHECKTIME: '2026-09-13 08:00:00' }] })
  });
  assert.equal(res.status, 401, 'una clave pausada no debe poder sincronizar');

  const [[{ c }]] = await db.query(`SELECT COUNT(*) AS c FROM Checkins WHERE USERID = 970099`);
  assert.equal(c, 0);
});

test('revocar la clave: tampoco puede sincronizar (y no se puede "despausar" a revocada por error)', async () => {
  await fetch(`${BASE_URL}/api/agent-keys/${agentKeyId}/status`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'revoked' })
  });

  const res = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKeyPlaintext },
    body: JSON.stringify({ records: [{ USERID: '970099', CHECKTIME: '2026-09-13 08:00:00' }] })
  });
  assert.equal(res.status, 401);
});
