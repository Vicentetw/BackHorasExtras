// Fase 18 (continuacion) -- "hasta cuando esta actualizado cada reloj",
// pedido real para mostrar en Presentismo/Asistencia. Cubre: se registra
// al subir fichajes via el agente (agrupado por reloj), se puede leer por
// un usuario normal de la empresa (no la clave de agente), y aislamiento
// entre empresas.
//
// Tenant descartable propio (999990), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_SYNC = 999990;
const OTHER_TENANT = 999989;
const UID_SUPERADMIN = 'test-sync-status-superadmin';
const UID_TENANT = 'test-sync-status-tenant';
const UID_OTHER = 'test-sync-status-other';

let headersSuperadmin;
let headersTenant;
let headersOther;
let agentKey;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Sync Status (test)', 'tenant-sync-status-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_SYNC]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Sync Status Otro (test)', 'tenant-sync-status-otro-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [OTHER_TENANT]
  );
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
  headersTenant = await getTestAuthHeaders(UID_TENANT, { isSuperadmin: false, tenantId: TENANT_SYNC });
  headersOther = await getTestAuthHeaders(UID_OTHER, { isSuperadmin: false, tenantId: OTHER_TENANT });

  const keyRes = await fetch(`${BASE_URL}/api/agent-keys`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_SYNC, label: 'test-sync-status' })
  });
  agentKey = (await keyRes.json()).key;
});

after(async () => {
  await db.query(`DELETE FROM Checkins WHERE USERID BETWEEN 980000 AND 980100`);
  await db.query(`DELETE FROM agent_sync_status WHERE tenant_id IN (?, ?)`, [TENANT_SYNC, OTHER_TENANT]);
  await db.query(`DELETE FROM tenant_agent_keys WHERE tenant_id = ?`, [TENANT_SYNC]);
  await deleteTestUser(UID_SUPERADMIN);
  await deleteTestUser(UID_TENANT);
  await deleteTestUser(UID_OTHER);
  await db.query(`DELETE FROM tenants WHERE id IN (?, ?)`, [TENANT_SYNC, OTHER_TENANT]);
  await closeDb();
});

test('subir fichajes via el agente registra el estado por reloj (agrupado por MACHINE_IP)', async () => {
  const records = [
    { USERID: '980001', CHECKTIME: '2026-09-14 08:00:00', MACHINE_IP: '192.168.9.10', MACHINE_SN: 'ZKA' },
    { USERID: '980001', CHECKTIME: '2026-09-14 17:00:00', MACHINE_IP: '192.168.9.10', MACHINE_SN: 'ZKA' },
    { USERID: '980002', CHECKTIME: '2026-09-14 08:05:00', MACHINE_IP: '192.168.9.20', MACHINE_SN: 'ZKB' },
  ];
  const res = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
    body: JSON.stringify({ records })
  });
  assert.equal(res.status, 200);

  const statusRes = await fetch(`${BASE_URL}/api/sync-status`, { headers: headersTenant });
  const rows = await statusRes.json();
  assert.equal(rows.length, 2, 'debe haber una fila por reloj distinto');

  const relojA = rows.find((r) => r.machine_ip === '192.168.9.10');
  assert.equal(relojA.fichajes_ultima_subida, 2);
  assert.equal(relojA.last_checktime, '2026-09-14 17:00:00');

  const relojB = rows.find((r) => r.machine_ip === '192.168.9.20');
  assert.equal(relojB.fichajes_ultima_subida, 1);
});

test('una subida posterior actualiza last_synced_at del mismo reloj (no duplica la fila)', async () => {
  await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': agentKey },
    body: JSON.stringify({ records: [{ USERID: '980003', CHECKTIME: '2026-09-14 18:00:00', MACHINE_IP: '192.168.9.10', MACHINE_SN: 'ZKA' }] })
  });

  const statusRes = await fetch(`${BASE_URL}/api/sync-status`, { headers: headersTenant });
  const rows = await statusRes.json();
  const filasDeEseReloj = rows.filter((r) => r.machine_ip === '192.168.9.10');
  assert.equal(filasDeEseReloj.length, 1, 'debe seguir siendo UNA fila, no una nueva por cada subida');
  assert.equal(filasDeEseReloj[0].last_checktime, '2026-09-14 18:00:00', 'se actualiza al ultimo checktime de esta subida');
});

test('otra empresa no ve el estado de sincronizacion ajeno (aislamiento)', async () => {
  const res = await fetch(`${BASE_URL}/api/sync-status`, { headers: headersOther });
  const rows = await res.json();
  assert.equal(rows.length, 0);
});

test('superadmin puede consultar el estado de cualquier empresa via ?tenantId=', async () => {
  const res = await fetch(`${BASE_URL}/api/sync-status?tenantId=${TENANT_SYNC}`, { headers: headersSuperadmin });
  const rows = await res.json();
  assert.ok(rows.length >= 2);
});
