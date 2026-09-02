// Congela el comportamiento del diagnostico de matching: los usuarios sin
// vincular con fichajes reales deben aparecer primero (fix de esta sesion),
// no mezclados entre la basura del reloj sin ningun fichaje.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-matching-characterization';

let headers;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
});

after(async () => {
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/api/matching/diagnosis/report: usuarios con fichajes reales aparecen primero', async () => {
  const res = await fetch(`${BASE_URL}/api/matching/diagnosis/report`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  const { unmatchedUsers } = json.data;
  assert.ok(unmatchedUsers.length > 0, 'debe haber al menos un usuario sin match para que el test tenga sentido');

  // Ordenado por checkinCount descendente
  for (let i = 1; i < unmatchedUsers.length; i++) {
    const prev = Number(unmatchedUsers[i - 1].checkinCount) || 0;
    const curr = Number(unmatchedUsers[i].checkinCount) || 0;
    assert.ok(prev >= curr, `checkinCount debe venir ordenado descendente (fila ${i})`);
  }

  // checkinCount es un COUNT(*) sobre TODO el historial de Checkins (sin
  // acotar a un rango cerrado, ver matching.routes.js) -- crece cada vez
  // que se importan fichajes nuevos (ej. actualizar CHECKINOUT.csv), no es
  // un valor que se pueda "congelar" como el de un mes cerrado. Se
  // verifica que siga siendo el mismo usuario (identidad estable) y que el
  // conteo no haya bajado, en vez de un numero exacto que se desactualiza
  // solo con el paso del tiempo.
  const top = unmatchedUsers[0];
  assert.equal(top.Badgenumber, '2837', 'el usuario con mas fichajes reales sin vincular');
  assert.ok(Number(top.checkinCount) >= 15, 'el conteo de fichajes de este usuario no deberia bajar con el tiempo');
});
