// GET /api/employees?employee_id=X se usa como pre-chequeo de "ya existe"
// antes de crear una fila durante el import de empleados (employees-v2.html
// y su equivalente en Angular). El query param se mandaba desde siempre
// pero el backend nunca lo soporto -- devolvia la primera pagina sin
// filtrar, asi que el chequeo terminaba comparando contra un empleado
// cualquiera, no contra el legajo real. Ver routes/employees.js.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const UID = 'test-employees-lookup-ci';
// employee_id es INT en la base -- nada de prefijos alfabeticos.
const EMPLOYEE_ID = String(900000000 + (Date.now() % 100000000));
let createdId = null;

after(async () => {
  if (createdId) {
    const headers = await getTestAuthHeaders(UID);
    await fetch(`${BASE_URL}/api/employees/${createdId}`, { method: 'DELETE', headers }).catch(() => {});
  }
  await deleteTestUser(UID);
  await closeDb();
});

test('GET /api/employees?employee_id=X devuelve exactamente ese legajo, no el primero de la pagina', async () => {
  const headers = await getTestAuthHeaders(UID);

  // activo:false a proposito -- node --test corre los archivos de test en
  // paralelo, asi que mientras este test vive, otros tests que consultan
  // /attendance-range (o cualquier conteo de empleados) podrian ver este
  // legajo de mentira de contarse como uno mas si quedara activo=true
  // (default). Paso ya real: sumaba +1 al conteo de un test de
  // caracterizacion que corre en paralelo (attendance-range.test.js).
  const created = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: EMPLOYEE_ID, nombre: 'CI Lookup Test', activo: false }),
  });
  const createdJson = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdJson));
  createdId = createdJson.id;

  const res = await fetch(`${BASE_URL}/api/employees?employee_id=${EMPLOYEE_ID}`, { headers });
  const json = await res.json();
  assert.equal(json.data.length, 1, `esperaba 1 resultado exacto, vinieron ${json.data.length}`);
  assert.equal(String(json.data[0].employee_id), EMPLOYEE_ID);
  assert.equal(json.data[0].nombre, 'CI Lookup Test');

  const resMissing = await fetch(`${BASE_URL}/api/employees?employee_id=999999999`, { headers });
  const jsonMissing = await resMissing.json();
  assert.equal(jsonMissing.data.length, 0);
});
