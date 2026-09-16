// Pedido real: "que no puedan subir cualquier archivo" -- ver la funcion
// validateCsvFile() en horasdedica2.js, agregada arriba de /import/checkins.
// No es un chequeo de seguridad (nada de esto se ejecuta ni se guarda en
// disco, ver `multer.memoryStorage()`), es para agarrar el error humano
// mas comun (subir el archivo equivocado, o un .xlsx en vez de .csv) con
// un mensaje claro en vez de un 500 generico o -- peor -- que se importe
// mal sin avisar.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-import-csv-validation';
const TENANT_ID = 999953;

let headers;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Import Validation (test)', 'tenant-import-validation-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: false, tenantId: TENANT_ID, permissions: ['attendance:create'] });
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID BETWEEN 980000 AND 980100 AND tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM users WHERE USERID BETWEEN 980000 AND 980100 AND tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await deleteTestUser(TEST_UID);
  await db.end().catch(() => {});
  await closeDb();
});

test('POST /import/checkins: nombre de archivo sin extension .csv -> 400 con mensaje claro', async () => {
  const csv = 'USERID;CHECKTIME;MACHINE_IP;MACHINE_SN\r\n980001;2026-09-02 09:00:00;;\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'application/vnd.ms-excel' }), 'CHECKINOUT.xlsx');

  const res = await fetch(`${BASE_URL}/import/checkins?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /\.csv/);
});

test('POST /import/checkins: CSV con columnas equivocadas (el de usuarios en vez del de fichajes) -> 400', async () => {
  const csv = 'USERID;Badgenumber;Name\r\n980002;B002;Juan Perez\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'CHECKINOUT.csv');

  const res = await fetch(`${BASE_URL}/import/checkins?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /CHECKTIME/);
});

test('POST /import/checkins: archivo vacio (solo encabezado, cero filas) -> 400', async () => {
  const csv = 'USERID;CHECKTIME;MACHINE_IP;MACHINE_SN\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'CHECKINOUT.csv');

  const res = await fetch(`${BASE_URL}/import/checkins?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /ninguna fila/);
});

test('POST /import/checkins: CSV valido sigue importando sin problemas (regresion)', async () => {
  const csv = 'USERID;CHECKTIME;MACHINE_IP;MACHINE_SN\r\n980003;2026-09-02 09:00:00;;\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'CHECKINOUT.csv');

  const res = await fetch(`${BASE_URL}/import/checkins?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.total, 1);
});

test('POST /import/users: nombre de archivo sin extension .csv -> 400', async () => {
  const csv = 'USERID;Badgenumber;Name\r\n980004;B004;Ana Lopez\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'application/vnd.ms-excel' }), 'USERINFO.xlsx');

  const res = await fetch(`${BASE_URL}/import/users?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /\.csv/);
});

test('POST /import/users: CSV con columnas equivocadas (el de fichajes en vez del de usuarios) -> 400', async () => {
  const csv = 'USERID;CHECKTIME;MACHINE_IP;MACHINE_SN\r\n980005;2026-09-02 09:00:00;;\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'USERINFO.csv');

  const res = await fetch(`${BASE_URL}/import/users?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /Badgenumber/);
});

test('POST /import/users: archivo vacio (solo encabezado, cero filas) -> 400', async () => {
  const csv = 'USERID;Badgenumber;Name\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'USERINFO.csv');

  const res = await fetch(`${BASE_URL}/import/users?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /ninguna fila/);
});

test('POST /import/users: CSV valido sigue importando sin problemas (regresion)', async () => {
  const csv = 'USERID;Badgenumber;Name\r\n980006;B006;Carlos Ruiz\r\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'USERINFO.csv');

  const res = await fetch(`${BASE_URL}/import/users?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.users, 1);
});
