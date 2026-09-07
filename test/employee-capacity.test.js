// Fase 15 (venta): tope de empleados incluidos en el plan ("como una
// telefonia"). Hueco real encontrado por el superadmin: le asigno a un
// tenant un plan de prueba de 5 empleados y pudo cargar un 6to sin ningun
// aviso ni bloqueo -- no existia ningun chequeo de cantidad vs plan.
//
// Cubre las 2 puertas de entrada de un empleado nuevo: el alta individual
// (routes/employees.js) y la confirmacion de un import masivo
// (routes/import.routes.js) -- el pedido explicito fue "que hacemos si
// carga un Excel con 60 empleados y paga 5", asi que el import tiene que
// respetar el MISMO tope, todo o nada (no insertar una parte y cortar).
//
// Tenant descartable propio (999993), NUNCA AVP (id 4).
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_CAP = 999993; // descartable, plan con tope de 2 empleados
const TENANT_UNLIMITED = 999994; // descartable, plan sin tope (max_employees NULL)
const UID_TENANT_CAP = 'test-employee-capacity-tenant';
const UID_TENANT_UNLIMITED = 'test-employee-capacity-unlimited';
const UID_SUPERADMIN = 'test-employee-capacity-superadmin';

let headersTenantCap;
let headersTenantUnlimited;
let headersSuperadmin;
let planCapId;
let planUnlimitedId;

async function cleanupEmployees(tenantId) {
  await db.query(`DELETE FROM employees WHERE tenant_id = ?`, [tenantId]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Capacidad (test)', 'tenant-capacidad-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_CAP]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Capacidad Sin Limite (test)', 'tenant-capacidad-sinlimite-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_UNLIMITED]
  );

  headersTenantCap = await getTestAuthHeaders(UID_TENANT_CAP, { isSuperadmin: false, tenantId: TENANT_CAP });
  headersTenantUnlimited = await getTestAuthHeaders(UID_TENANT_UNLIMITED, { isSuperadmin: false, tenantId: TENANT_UNLIMITED });
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });

  const planCapRes = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plan con tope (test)', base_price_usd: 10, price_per_employee_usd: 1, min_billed_employees: 1, max_employees: 2 })
  });
  planCapId = (await planCapRes.json()).id;

  const planUnlimitedRes = await fetch(`${BASE_URL}/api/billing/plans`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Plan sin tope (test)', base_price_usd: 10, price_per_employee_usd: 1, min_billed_employees: 1 })
  });
  planUnlimitedId = (await planUnlimitedRes.json()).id;

  await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_CAP}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planCapId, status: 'active', current_period_end: '2099-01-01' })
  });
  await fetch(`${BASE_URL}/api/billing/subscriptions/${TENANT_UNLIMITED}`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_id: planUnlimitedId, status: 'active', current_period_end: '2099-01-01' })
  });
});

beforeEach(async () => {
  await cleanupEmployees(TENANT_CAP);
  await cleanupEmployees(TENANT_UNLIMITED);
});

after(async () => {
  await cleanupEmployees(TENANT_CAP);
  await cleanupEmployees(TENANT_UNLIMITED);
  await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id IN (?, ?)`, [TENANT_CAP, TENANT_UNLIMITED]);
  if (planCapId) await db.query(`DELETE FROM plans WHERE id = ?`, [planCapId]);
  if (planUnlimitedId) await db.query(`DELETE FROM plans WHERE id = ?`, [planUnlimitedId]);
  await deleteTestUser(UID_TENANT_CAP);
  await deleteTestUser(UID_TENANT_UNLIMITED);
  await deleteTestUser(UID_SUPERADMIN);
  await db.query(`DELETE FROM tenants WHERE id IN (?, ?)`, [TENANT_CAP, TENANT_UNLIMITED]);
  await closeDb();
});

// employee_id es INT en la base -- nada de legajos con texto (bug propio
// encontrado escribiendo este mismo test).
function makeEmployee(id) {
  return { employee_id: 900000 + id, nombre: `Empleado Test ${id}` };
}

test('alta individual: se puede cargar hasta el tope del plan', async () => {
  for (const id of [1, 2]) {
    const res = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { ...headersTenantCap, 'Content-Type': 'application/json' },
      body: JSON.stringify(makeEmployee(id))
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  }
});

test('alta individual: pasarse del tope del plan se rechaza con 409 y un mensaje claro', async () => {
  for (const id of [1, 2]) {
    await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { ...headersTenantCap, 'Content-Type': 'application/json' },
      body: JSON.stringify(makeEmployee(id))
    });
  }
  const res = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersTenantCap, 'Content-Type': 'application/json' },
    body: JSON.stringify(makeEmployee(3))
  });
  const json = await res.json();
  assert.equal(res.status, 409);
  assert.match(json.error, /Plan con tope \(test\)/);
  assert.equal(json.employeeCap.max, 2);
  assert.equal(json.employeeCap.current, 2);

  const [[{ c }]] = await db.query(`SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ?`, [TENANT_CAP]);
  assert.equal(c, 2, 'el tercer empleado NO debe haber quedado insertado');
});

test('alta individual: un plan sin tope (max_employees NULL) no bloquea nada', async () => {
  for (const id of [1, 2, 3, 4, 5]) {
    const res = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { ...headersTenantUnlimited, 'Content-Type': 'application/json' },
      body: JSON.stringify(makeEmployee(10 + id))
    });
    assert.equal(res.status, 200);
  }
});

test('import masivo: si el batch completo supera el tope, se rechaza TODO (no se inserta nada)', async () => {
  // El tenant ya tiene 0 empleados y su plan permite 2 -- un batch de 3
  // filas nuevas no puede entrar completo.
  const uploadRes = await fetch(`${BASE_URL}/api/import/employees`, {
    method: 'POST',
    headers: { ...headersTenantCap, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employees: [
        { employee_id: 900101, nombre: 'Import Uno' },
        { employee_id: 900102, nombre: 'Import Dos' },
        { employee_id: 900103, nombre: 'Import Tres' }
      ]
    })
  });
  const { batchId } = await uploadRes.json();

  const confirmRes = await fetch(`${BASE_URL}/api/import/employees/confirm/${batchId}`, {
    method: 'POST',
    headers: { ...headersTenantCap, 'Content-Type': 'application/json' }
  });
  const confirmJson = await confirmRes.json();
  assert.equal(confirmRes.status, 409, JSON.stringify(confirmJson));
  assert.match(confirmJson.error, /3 empleados nuevos/);
  assert.match(confirmJson.error, /Plan con tope \(test\)/);

  const [[{ c }]] = await db.query(`SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ?`, [TENANT_CAP]);
  assert.equal(c, 0, 'el batch rechazado no debe haber insertado ninguna fila');
});

test('import masivo: un batch que entra justo en el tope se confirma normalmente', async () => {
  const uploadRes = await fetch(`${BASE_URL}/api/import/employees`, {
    method: 'POST',
    headers: { ...headersTenantCap, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employees: [
        { employee_id: 900201, nombre: 'Import Ok Uno' },
        { employee_id: 900202, nombre: 'Import Ok Dos' }
      ]
    })
  });
  const { batchId } = await uploadRes.json();

  const confirmRes = await fetch(`${BASE_URL}/api/import/employees/confirm/${batchId}`, {
    method: 'POST',
    headers: { ...headersTenantCap, 'Content-Type': 'application/json' }
  });
  const confirmJson = await confirmRes.json();
  assert.equal(confirmRes.status, 200, JSON.stringify(confirmJson));
  assert.equal(confirmJson.inserted, 2);
});
