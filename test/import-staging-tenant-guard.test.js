// Bug real de seguridad encontrado en una auditoria general (no un reporte
// de un usuario): staging_employees (donde queda "flotando" un import de
// Excel antes de confirmarlo) no tenia tenant_id -- el batchId es solo
// Date.now().toString() (milisegundos), sin dueño registrado en ningun
// lado. GET /employees/preview/:batchId y POST /employees/confirm/:batchId
// no podian verificar "¿este lote es tuyo?". Ver migracion
// 20260915_staging_employees_tenant_id.sql y routes/import.routes.js.
//
// Tenants descartables propios (999965/999966), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999965;
const TENANT_B = 999966;
const UID_A = 'test-import-staging-guard-a';

let headersA;
let batchIdB;

async function cleanup() {
  await db.query('DELETE FROM staging_employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Import Guard A (test)', 'tenant-import-guard-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Import Guard B (test)', 'tenant-import-guard-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A, permissions: ['employees:create'] });

  await cleanup();

  // Lote de TENANT_B, sin confirmar todavia -- simula el "flotando" real.
  const headersB = await getTestAuthHeaders('test-import-staging-guard-b', { isSuperadmin: false, tenantId: TENANT_B, permissions: ['employees:create'] });
  const uploadRes = await fetch(`${BASE_URL}/api/import/employees`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees: [{ employee_id: 900800, nombre: 'Empleado Staging Guard B' }] }),
  });
  const uploadJson = await uploadRes.json();
  batchIdB = uploadJson.batchId;
  await deleteTestUser('test-import-staging-guard-b');
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('GET /employees/preview/:batchId de OTRA empresa -> vacío, no expone los datos', async () => {
  const res = await fetch(`${BASE_URL}/api/import/employees/preview/${batchIdB}`, { headers: headersA });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 0, 'no debe ver ninguna fila del lote de la otra empresa');
});

test('POST /employees/confirm/:batchId de OTRA empresa -> 404, no crea nada', async () => {
  const res = await fetch(`${BASE_URL}/api/import/employees/confirm/${batchIdB}`, { method: 'POST', headers: headersA });
  assert.equal(res.status, 404);

  const [rows] = await db.query('SELECT id FROM employees WHERE employee_id = ?', [900800]);
  assert.equal(rows.length, 0, 'el empleado del lote ajeno NO debe haberse creado (ni para A ni para nadie)');
});

test('el propio lote (mismo tenant) se puede previsualizar y confirmar normalmente', async () => {
  const uploadRes = await fetch(`${BASE_URL}/api/import/employees`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees: [{ employee_id: 900801, nombre: 'Empleado Staging Guard A' }] }),
  });
  const { batchId } = await uploadRes.json();

  const previewRes = await fetch(`${BASE_URL}/api/import/employees/preview/${batchId}`, { headers: headersA });
  const previewRows = await previewRes.json();
  assert.equal(previewRows.length, 1);

  const confirmRes = await fetch(`${BASE_URL}/api/import/employees/confirm/${batchId}`, { method: 'POST', headers: headersA });
  assert.equal(confirmRes.status, 200);
  const confirmJson = await confirmRes.json();
  assert.equal(confirmJson.inserted, 1);

  const [[row]] = await db.query('SELECT tenant_id FROM employees WHERE employee_id = ?', [900801]);
  assert.equal(row.tenant_id, TENANT_A);
});
