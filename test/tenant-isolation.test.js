// El test mas importante del paso 2: un usuario de una empresa NO debe ver
// empleados de otra. Prueba el aislamiento de punta a punta a traves de
// /api/employees y /attendance-range.
//
// SE ARMA SUS PROPIOS DATOS (cambiado el 2026-09-21)
// --------------------------------------------------
// Antes usaba la empresa 4 ("AVP2") con 2 empleados de legajo 2329 y 3056, y
// la empresa 6 con sus ~478, dando por hecho que ya estaban en la base. Eso
// lo ataba a UNA base concreta: en una base nueva -- la que levanta el CI en
// cada corrida -- la empresa 4 no existe y el test explotaba en el before
// con un error de clave foranea, antes de probar nada.
//
// Ahora crea dos empresas descartables con sus empleados y las borra al
// terminar. Prueba exactamente lo mismo y corre en cualquier base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-tenant-isolation';
const TENANT_CHICO = 999927;   // 2 empleados: el que mira
const TENANT_GRANDE = 999928;  // 5 empleados: los que NO tiene que ver
const LEGAJOS_PROPIOS = [2329, 3056];
const LEGAJOS_AJENOS = [900801, 900802, 900803, 900804, 900805];

let headers;

async function limpiar() {
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_CHICO, TENANT_GRANDE]);
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_CHICO, 'Tenant Aislamiento Chico (test)', 'tenant-aislamiento-chico-test'],
    [TENANT_GRANDE, 'Tenant Aislamiento Grande (test)', 'tenant-aislamiento-grande-test']
  ]) {
    await db.query(
      'INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [id, name, code]
    );
  }
  await limpiar();

  for (const legajo of LEGAJOS_PROPIOS) {
    await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)',
      [legajo, `Empleado propio ${legajo}`, TENANT_CHICO]);
  }
  for (const legajo of LEGAJOS_AJENOS) {
    await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)',
      [legajo, `Empleado ajeno ${legajo}`, TENANT_GRANDE]);
  }

  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: false, tenantId: TENANT_CHICO });
});

after(async () => {
  await limpiar();
  await deleteTestUser(TEST_UID);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_CHICO, TENANT_GRANDE]);
  await closeDb();
});

test('/api/employees: solo ve los empleados de SU empresa, no los de la otra', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.data.length, LEGAJOS_PROPIOS.length, 'debe ver solo los empleados de su propio tenant');
  const legajos = json.data.map((e) => e.employee_id).sort((a, b) => a - b);
  assert.deepEqual(legajos, LEGAJOS_PROPIOS);
});

test('/api/employees: no puede ver otra empresa aunque mande tenantId por query (no es superadmin)', async () => {
  const res = await fetch(`${BASE_URL}/api/employees?limit=0&tenantId=${TENANT_GRANDE}`, { headers });
  const json = await res.json();
  assert.equal(json.data.length, LEGAJOS_PROPIOS.length,
    'el tenantId de la query se ignora para un usuario no-superadmin');
});

test('/attendance-range: el reporte tambien queda acotado a su empresa', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.length, LEGAJOS_PROPIOS.length, 'el reporte de asistencia tambien queda acotado al tenant');
});
