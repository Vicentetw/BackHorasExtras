// Fase 19: prueba de punta a punta del escenario real que motivo la
// migracion 20260909 -- "si una segunda empresa nueva sincroniza su
// reloj y este numera sus usuarios empezando tambien desde 1/2/3 (lo mas
// comun), su agente pisaria en silencio el nombre de un empleado de la
// primera empresa, y sus fichajes quedarian mezclados sin forma de
// separarlos". Dos agentes reales (tenant_agent_keys), DOS empresas
// distintas, mandando el MISMO USERID crudo -- confirma que ya no se
// pisan ni se mezclan.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { closeDb } = require('../test-helpers/firebaseTestAuth');
const agentKeyRepository = require('../motor-laboral/repositories/agentKeyRepository');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999960;
const TENANT_B = 999961;
// El MISMO USERID crudo para las dos empresas a proposito -- es el caso
// real que rompia antes de la migracion 20260909 (numeracion por defecto
// del reloj, empieza de 1/2/3 en cualquier sitio nuevo).
const SHARED_USERID = 8890040;

let keyA, keyB;

async function cleanup() {
  await db.query('DELETE FROM Checkins WHERE USERID = ? AND tenant_id IN (?, ?)', [SHARED_USERID, TENANT_A, TENANT_B]);
  await db.query('DELETE FROM users WHERE USERID = ? AND tenant_id IN (?, ?)', [SHARED_USERID, TENANT_A, TENANT_B]);
  await db.query('DELETE FROM tenant_agent_keys WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  // El endpoint real /api/agent/checkins registra agent_sync_status de
  // paso (ver routes/agent.js) -- hay que limpiarlo tambien antes de
  // poder borrar la fila de tenants (FK real).
  await db.query('DELETE FROM agent_sync_status WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Agent Collision A (test)', 'tenant-agent-collision-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Agent Collision B (test)', 'tenant-agent-collision-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  await cleanup();

  keyA = (await agentKeyRepository.createAgentKey({ tenantId: TENANT_A, label: 'Test A' }, db)).plaintext;
  keyB = (await agentKeyRepository.createAgentKey({ tenantId: TENANT_B, label: 'Test B' }, db)).plaintext;
});

after(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('dos agentes de empresas distintas sincronizando el MISMO USERID crudo no se pisan', async () => {
  // 1. La empresa A sincroniza su usuario.
  const resA = await fetch(`${BASE_URL}/api/agent/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': keyA },
    body: JSON.stringify({ records: [{ USERID: SHARED_USERID, Badgenumber: '1', Name: 'Empleado Empresa A' }] }),
  });
  assert.equal(resA.status, 200, JSON.stringify(await resA.json()));

  // 2. La empresa B sincroniza SU PROPIO usuario, mismo USERID crudo --
  // antes de la migracion esto pisaba el nombre de la empresa A.
  const resB = await fetch(`${BASE_URL}/api/agent/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': keyB },
    body: JSON.stringify({ records: [{ USERID: SHARED_USERID, Badgenumber: '1', Name: 'Empleado Empresa B' }] }),
  });
  assert.equal(resB.status, 200, JSON.stringify(await resB.json()));

  // 3. Las dos filas coexisten, cada una con su propio nombre -- NO se pisaron.
  const [rows] = await db.query(
    'SELECT tenant_id, Name FROM users WHERE USERID = ? ORDER BY tenant_id',
    [SHARED_USERID]
  );
  assert.equal(rows.length, 2, 'deben existir DOS filas independientes, una por empresa');
  const nameByTenant = Object.fromEntries(rows.map((r) => [r.tenant_id, r.Name]));
  assert.equal(nameByTenant[TENANT_A], 'Empleado Empresa A', 'el nombre de la empresa A no debe haberse pisado');
  assert.equal(nameByTenant[TENANT_B], 'Empleado Empresa B');

  // 4. Cada empresa ficha con el mismo USERID crudo, mismo instante --
  // antes se hubiera perdido uno (uq_checkin era (USERID, CHECKTIME) sin
  // tenant_id, INSERT IGNORE se comía el segundo).
  const checktime = '2099-03-01 08:00:00';
  const checkinResA = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': keyA },
    body: JSON.stringify({ records: [{ USERID: SHARED_USERID, CHECKTIME: checktime }] }),
  });
  assert.equal(checkinResA.status, 200);
  const checkinResB = await fetch(`${BASE_URL}/api/agent/checkins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': keyB },
    body: JSON.stringify({ records: [{ USERID: SHARED_USERID, CHECKTIME: checktime }] }),
  });
  assert.equal(checkinResB.status, 200);

  const [checkins] = await db.query(
    'SELECT tenant_id FROM Checkins WHERE USERID = ? AND CHECKTIME = ? ORDER BY tenant_id',
    [SHARED_USERID, checktime]
  );
  assert.equal(checkins.length, 2, 'el fichaje de la empresa B NO debe perderse por chocar con el de la empresa A');
  assert.deepEqual(checkins.map((c) => c.tenant_id), [TENANT_A, TENANT_B]);
});

test('insertCheckinsBatch/upsertUsersBatch exigen tenantId -- no dejan insertar sin saber de que empresa es', async () => {
  const { insertCheckinsBatch, upsertUsersBatch } = require('../motor-laboral/services/checkinsIngestService');
  await assert.rejects(
    () => insertCheckinsBatch([{ USERID: SHARED_USERID, CHECKTIME: '2099-03-01 09:00:00' }], db, null),
    /tenantId/
  );
  await assert.rejects(
    () => upsertUsersBatch([{ USERID: SHARED_USERID, Badgenumber: '1', Name: 'X' }], db, undefined),
    /tenantId/
  );
});
