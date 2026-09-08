// Pedido real: en /empleados, al filtrar "sin fichar hace 180 días"
// (jubilados/bajas no cargadas formalmente), poder tildar varios de la
// lista y marcarlos inactivos en un solo paso -- antes había que editar
// uno por uno con el modal completo. PATCH /api/employees/bulk-status.
//
// Tenants descartables propios (999995/999996), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999995;
const TENANT_B = 999996;
const UID_A = 'test-employees-bulk-status-a';
const UID_B = 'test-employees-bulk-status-b';

let headersA;
let headersB;

async function cleanupEmployees() {
  await db.query(`DELETE FROM employees WHERE tenant_id IN (?, ?)`, [TENANT_A, TENANT_B]);
}

async function createEmployee(headers, id, extra = {}) {
  const res = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 900300 + id, nombre: `Bulk Status Test ${id}`, ...extra }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.id;
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Bulk Status A (test)', 'tenant-bulkstatus-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Bulk Status B (test)', 'tenant-bulkstatus-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A, permissions: ['employees:create', 'employees:read', 'employees:update'] });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B, permissions: ['employees:create', 'employees:read', 'employees:update'] });
});

beforeEach(cleanupEmployees);

after(async () => {
  await cleanupEmployees();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await db.query(`DELETE FROM tenants WHERE id IN (?, ?)`, [TENANT_A, TENANT_B]);
  await closeDb();
});

test('marca varios como inactivos de una vez, con fecha_baja y motivo', async () => {
  const id1 = await createEmployee(headersA, 1);
  const id2 = await createEmployee(headersA, 2);

  const res = await fetch(`${BASE_URL}/api/employees/bulk-status`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id1, id2], activo: false, motivoBaja: 'Sin fichar hace 180 días' }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.updated, 2);
  assert.equal(json.skipped, 0);

  const [rows] = await db.query('SELECT activo, fecha_baja, motivo_baja FROM employees WHERE id IN (?)', [[id1, id2]]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(Number(r.activo), 0);
    assert.ok(r.fecha_baja, 'fecha_baja debe quedar seteada (hoy)');
    assert.equal(r.motivo_baja, 'Sin fichar hace 180 días');
  }
});

test('reactivar en lote solo toca activo, no pisa fecha_baja/motivo_baja', async () => {
  const id1 = await createEmployee(headersA, 3, { activo: false, fecha_baja: '2020-01-01', motivo_baja: 'Baja vieja' });

  const res = await fetch(`${BASE_URL}/api/employees/bulk-status`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id1], activo: true }),
  });
  assert.equal(res.status, 200);

  const [[row]] = await db.query('SELECT activo, fecha_baja, motivo_baja FROM employees WHERE id = ?', [id1]);
  assert.equal(Number(row.activo), 1);
  assert.equal(String(row.fecha_baja).slice(0, 10), '2020-01-01', 'reactivar no debe borrar la fecha_baja historica');
  assert.equal(row.motivo_baja, 'Baja vieja');
});

test('aislamiento por tenant: no puede desactivar empleados de otra empresa aunque mande su id', async () => {
  const idOwn = await createEmployee(headersA, 4);
  const idOther = await createEmployee(headersB, 5);

  const res = await fetch(`${BASE_URL}/api/employees/bulk-status`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [idOwn, idOther], activo: false }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.updated, 1, 'solo el propio debe contarse como actualizado');
  assert.equal(json.skipped, 1, 'el de la otra empresa debe quedar afuera');

  const [[ownRow]] = await db.query('SELECT activo FROM employees WHERE id = ?', [idOwn]);
  const [[otherRow]] = await db.query('SELECT activo FROM employees WHERE id = ?', [idOther]);
  assert.equal(Number(ownRow.activo), 0, 'el propio SI debe quedar inactivo');
  assert.equal(Number(otherRow.activo), 1, 'el de la otra empresa NO debe haberse tocado');
});

test('validaciones: ids vacío, activo no-boolean y más de 1000 ids se rechazan con 400', async () => {
  const resEmpty = await fetch(`${BASE_URL}/api/employees/bulk-status`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [], activo: false }),
  });
  assert.equal(resEmpty.status, 400);

  const resBadActivo = await fetch(`${BASE_URL}/api/employees/bulk-status`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [1], activo: 'no' }),
  });
  assert.equal(resBadActivo.status, 400);

  const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1);
  const resTooMany = await fetch(`${BASE_URL}/api/employees/bulk-status`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: tooMany, activo: false }),
  });
  assert.equal(resTooMany.status, 400);
});
