// Bug real reportado: subir CHECKINOUT.csv con mas de 5000 fichajes (algo
// esperable -- ese archivo puede acumular "muchos meses de fichajes", el
// upload ya acepta hasta 50MB, ver el comentario de `multer` en
// horasdedica2.js) fallaba con un 500 generico ("Import checkins failed")
// sin explicar por que. Causa real: insertCheckinsBatch/upsertUsersBatch
// comparten el mismo tope de 5000 (MAX_RECORDS_PER_BATCH) pensado para el
// agente automatico (JSON, clave de agente, riesgo de DoS real) -- la
// subida manual via CSV (autenticada, permiso attendance:create, ya
// acotada a 50MB por multer) no tiene el mismo riesgo y necesita permitir
// lotes mucho mas grandes. Se agrega un 4to parametro opcional (maxRecords)
// -- sin pasarlo, el comportamiento para el agente queda IDENTICO a antes.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { insertCheckinsBatch, MAX_RECORDS_PER_BATCH, MAX_RECORDS_PER_MANUAL_IMPORT } = require('../motor-laboral/services/checkinsIngestService');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-checkins-batch-size';
const TENANT_ID = 999952;
const OVER_5000 = MAX_RECORDS_PER_BATCH + 1; // 5001 -- por encima del tope del agente

let headers;

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Checkins Batch (test)', 'tenant-checkins-batch-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: false, tenantId: TENANT_ID, permissions: ['attendance:create'] });
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID BETWEEN 970000 AND 990000 AND tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await deleteTestUser(TEST_UID);
  await db.end().catch(() => {});
  await closeDb();
});

function fakeRecords(count, useridBase) {
  return Array.from({ length: count }, (_, i) => ({
    USERID: String(useridBase + i),
    CHECKTIME: '2026-09-01 08:00:00',
  }));
}

test('insertCheckinsBatch: mas de 5000 registros CON el tope del agente (default) -> BATCH_TOO_LARGE', async () => {
  await assert.rejects(
    () => insertCheckinsBatch(fakeRecords(OVER_5000, 970000), db, TENANT_ID),
    (err) => {
      assert.equal(err.code, 'BATCH_TOO_LARGE');
      return true;
    }
  );
});

test('insertCheckinsBatch: mas de 5000 registros CON el tope de la subida manual (MAX_RECORDS_PER_MANUAL_IMPORT) -> inserta bien', async () => {
  const records = fakeRecords(OVER_5000, 971000);
  const result = await insertCheckinsBatch(records, db, TENANT_ID, MAX_RECORDS_PER_MANUAL_IMPORT);
  assert.equal(result.total, OVER_5000);
  assert.equal(result.inserted + result.skipped + result.errors >= OVER_5000 || result.inserted === OVER_5000, true);
  assert.ok(result.inserted > MAX_RECORDS_PER_BATCH, 'deberia haber insertado mas fichajes que el tope viejo del agente');
});

test('POST /import/checkins: un CSV con mas de 5000 filas ya NO da el 500 generico -- se importa bien', async () => {
  let csv = 'USERID;CHECKTIME;MACHINE_IP;MACHINE_SN\r\n';
  for (let i = 0; i < OVER_5000; i++) {
    csv += `${972000 + i};2026-09-02 09:00:00;;\r\n`;
  }
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'CHECKINOUT.csv');

  const res = await fetch(`${BASE_URL}/import/checkins?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.total, OVER_5000);
  assert.ok(body.inserted > MAX_RECORDS_PER_BATCH, 'deberia haber insertado mas fichajes que el viejo tope de 5000');
});
