// Test de caracterizacion: "congela" el comportamiento ACTUAL de
// /api/labor-engine/attendance/:date (motor diario, calculateDailyAttendance)
// contra dias ya cerrados de junio 2026 (no cambian mas con el paso del
// tiempo). No existia ningun test para este endpoint antes de la
// unificacion con /attendance-range (extraccion de attendanceCalculations.js) --
// se agrega aca como red de seguridad para ese refactor y los que vengan.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra una base con los mismos datos de referencia.
//
// Correr con: npm test  (o: node --test test/)
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-daily-characterization';

let headers;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
});

after(async () => {
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/api/labor-engine/attendance/:date 2026-06-30 (dia cerrado): mismos totales que hoy', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-30`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.summary.total, 476);
  assert.equal(json.summary.onTime, 37);
  assert.equal(json.summary.late, 28);
  assert.equal(json.summary.lateJustified, 0);
  assert.equal(json.summary.absent, 410);
  assert.equal(json.summary.excused, 1);
});

test('/api/labor-engine/attendance/:date 2026-06-29 (dia con una exclusion FULL_DAY): mismos totales que hoy', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-29`, { headers });
  const json = await res.json();
  assert.equal(json.summary.excused, 1, 'la exclusion FULL_DAY del legajo 2525 debe seguir contando como Excused');
  assert.equal(json.summary.onTime, 69);
  assert.equal(json.summary.late, 10);
});

test('/api/labor-engine/attendance/:date sin token: 401', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-30`, {
    headers: { 'x-api-key': process.env.API_KEY }
  });
  assert.equal(res.status, 401);
});
