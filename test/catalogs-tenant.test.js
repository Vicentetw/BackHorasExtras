// Feriados, motivos de ausencia y categorias de empleado eran catalogos
// GLOBALES (Fase A paso 2 del plan de venta). Un usuario de la empresa
// de prueba (AVP2) no debe ver los feriados/motivos/categorias de la
// empresa real, ya migrados al tenant 6.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const AVP2_TENANT_ID = 4;
const UID = 'test-catalogs-tenant-ci';

after(async () => {
  await deleteTestUser(UID);
  await closeDb();
});

test('holidays/event-types/employee-categories: un usuario de AVP2 no ve los catalogos de la otra empresa', async () => {
  const headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: AVP2_TENANT_ID });

  const r1 = await fetch(`${BASE_URL}/api/holidays`, { headers });
  const j1 = await r1.json();
  assert.equal(j1.count, 0);

  const r2 = await fetch(`${BASE_URL}/api/event-types`, { headers });
  const j2 = await r2.json();
  assert.equal(j2.eventTypes.length, 0);

  const r3 = await fetch(`${BASE_URL}/api/employee-categories`, { headers });
  const j3 = await r3.json();
  assert.equal(j3.categories.length, 0);
});
