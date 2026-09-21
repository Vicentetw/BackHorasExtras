// Elegir contra que dato del empleado se compara el Badgenumber del reloj.
//
// Por que existe esta opcion: el Badgenumber es la identidad, pero identidad
// SEGUN QUE. Cada empresa decide que le carga al reloj al dar de alta a una
// persona: el legajo o el DNI. En AVP se midio y es el legajo (478
// coincidencias contra 0 del documento), pero la proxima empresa puede tener
// lo contrario.
//
// Lo que mas importa probar aca: que la configuracion sea POR EMPRESA (si se
// filtrara mal, una empresa cambiaria el criterio de vinculacion de otra) y
// que un valor invalido no llegue nunca a la consulta SQL.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999923;
const TENANT_B = 999924;
const UID_A = 'test-matching-identity-a';
const UID_B = 'test-matching-identity-b';
const USERID_A = 8890050;
const USERID_B = 8890051;

let headersA, headersB;

async function cleanup() {
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_A, 'Tenant Identity A (test)', 'tenant-identity-a-test'],
    [TENANT_B, 'Tenant Identity B (test)', 'tenant-identity-b-test']
  ]) {
    await db.query(
      `INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [id, name, code]
    );
  }
  headersA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: TENANT_A });
  headersB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TENANT_B });

  await cleanup();

  // Empresa A: el reloj tiene cargado el LEGAJO (badge 4001 = legajo 4001)
  await db.query(
    'INSERT INTO employees (employee_id, nombre, documento, tenant_id, activo) VALUES (?, ?, ?, ?, 1)',
    [4001, 'AVILA, Marta', '30111222', TENANT_A]
  );
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)',
    [USERID_A, TENANT_A, '4001', 'AVILA']);

  // Empresa B: el reloj tiene cargado el DOCUMENTO (badge 27333444 = DNI)
  await db.query(
    'INSERT INTO employees (employee_id, nombre, documento, tenant_id, activo) VALUES (?, ?, ?, ?, 1)',
    [5002, 'SOSA, Julian', '27333444', TENANT_B]
  );
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)',
    [USERID_B, TENANT_B, '27333444', 'SOSA']);
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

test('por defecto compara contra el legajo', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/identity-field`, { headers: headersA });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.current, 'legajo');
  assert.equal(json.default, 'legajo');
});

test('cuenta cuantos candidatos daria CADA opcion, para no tener que adivinar', async () => {
  const resA = await fetch(`${BASE_URL}/api/matching/identity-field`, { headers: headersA });
  const a = await resA.json();
  assert.equal(a.options.legajo.candidates, 1, 'en A el badge es el legajo');
  assert.equal(a.options.documento.candidates, 0);
  assert.equal(a.suggested, 'legajo', 'debe sugerir la opcion con evidencia');

  const resB = await fetch(`${BASE_URL}/api/matching/identity-field`, { headers: headersB });
  const b = await resB.json();
  assert.equal(b.options.documento.candidates, 1, 'en B el badge es el documento');
  assert.equal(b.options.legajo.candidates, 0);
  assert.equal(b.suggested, 'documento');
});

test('elegir "documento" cambia contra que se empareja', async () => {
  // Antes de configurarlo, B no encuentra a nadie: compara contra el legajo.
  const antes = await (await fetch(`${BASE_URL}/api/matching/auto`, { method: 'POST', headers: headersB })).json();
  assert.equal(antes.would_match, 0);
  assert.equal(antes.identityField, 'legajo');

  const put = await fetch(`${BASE_URL}/api/matching/identity-field`, {
    method: 'PUT',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityField: 'documento' })
  });
  assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));

  const despues = await (await fetch(`${BASE_URL}/api/matching/auto`, { method: 'POST', headers: headersB })).json();
  assert.equal(despues.identityField, 'documento');
  assert.equal(despues.would_match, 1, 'ahora si encuentra al empleado por su DNI');
  assert.equal(despues.predictions[0].empLegajo, 5002);
});

test('la configuracion es POR EMPRESA: lo de B no afecta a A', async () => {
  const a = await (await fetch(`${BASE_URL}/api/matching/identity-field`, { headers: headersA })).json();
  assert.equal(a.current, 'legajo', 'A debe seguir comparando por legajo');

  const autoA = await (await fetch(`${BASE_URL}/api/matching/auto`, { method: 'POST', headers: headersA })).json();
  assert.equal(autoA.identityField, 'legajo');
  assert.equal(autoA.would_match, 1);
});

test('un valor invalido se rechaza con 400 y no cambia nada', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/identity-field`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityField: 'nombre; DROP TABLE users' })
  });
  assert.equal(res.status, 400);

  const a = await (await fetch(`${BASE_URL}/api/matching/identity-field`, { headers: headersA })).json();
  assert.equal(a.current, 'legajo', 'debe haber quedado como estaba');
});

test('la propuesta trae TODOS los campos que lee la pantalla', async () => {
  // Contrato con el frontend: src/app/matching/matching.ts, interfaz
  // `Prediction`. Si alguien renombra un campo del backend, este test se
  // pone en rojo ACA en vez de dejar la pantalla mostrando "undefined"
  // (que es como se descubren normalmente estos errores: en produccion).
  const json = await (await fetch(`${BASE_URL}/api/matching/auto`, { method: 'POST', headers: headersA })).json();
  const p = json.predictions[0];
  assert.ok(p, 'deberia haber al menos una propuesta');

  for (const campo of [
    'USERID', 'user_badgenumber', 'user_name',   // el usuario del reloj
    'employee_id', 'emp_legajo', 'employee_name', // el empleado
    'checkinCount', 'lastCheckin',                // la evidencia de uso
    'nameEvidence', 'preselected', 'alternatives' // la corroboracion
  ]) {
    assert.ok(campo in p, `falta el campo "${campo}" que la pantalla necesita`);
  }

  assert.equal(typeof p.checkinCount, 'number');
  assert.equal(typeof p.preselected, 'boolean');
  assert.ok(Array.isArray(p.alternatives));
  assert.ok(
    ['exacto', 'contiene', 'acentos', 'sin_nombre', 'no_coincide'].includes(p.nameEvidence),
    `nameEvidence inesperado: ${p.nameEvidence}`
  );

  // El endpoint de configuracion tambien tiene su contrato.
  const info = await (await fetch(`${BASE_URL}/api/matching/identity-field`, { headers: headersA })).json();
  for (const campo of ['current', 'default', 'suggested', 'options']) {
    assert.ok(campo in info, `falta "${campo}" en identity-field`);
  }
  for (const opcion of Object.values(info.options)) {
    for (const campo of ['label', 'description', 'candidates']) {
      assert.ok(campo in opcion, `falta "${campo}" en una opcion de identity-field`);
    }
  }
});

test('/auto sigue sin vincular nada: solo propone', async () => {
  const json = await (await fetch(`${BASE_URL}/api/matching/auto`, { method: 'POST', headers: headersA })).json();
  assert.equal(json.applied, 0);
  assert.equal(json.requiresConfirmation, true);

  const [rows] = await db.query('SELECT USERID FROM user_employee_map WHERE USERID = ?', [USERID_A]);
  assert.equal(rows.length, 0, 'proponer NO debe crear el vinculo');
});

