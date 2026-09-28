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
const { saltarSinDatosReales } = require('../test-helpers/datosReales');

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

test('/api/labor-engine/attendance/:date 2026-06-30 (dia cerrado): mismos totales que hoy', async (t) => {
  if (await saltarSinDatosReales(t)) return;
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-30`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  // Actualizado 2026-09-08: bug real corregido -- un empleado marcado
  // como INACTIVO (baja no cargada formalmente) contaba como "Ausente"
  // solo por no fichar, en TODOS los dias, aunque ya no trabaje aca. Con
  // el fix (ver attendanceService.js), los 197 empleados inactivos reales
  // de esta base (confirmado: activo=0) ya no suman al conteo de ausentes
  // -- 411 -> 214 (411 - 197). El resto de los estados no cambia (un
  // inactivo sin fichar no es OnTime/Late/Excused tampoco, asi que esos
  // conteos quedan iguales).
  // Actualizado 2026-09-28: estos valores fallaban desde el 18/09 sin que
  // hubiera ningun bug. Ese dia se reimportaron los fichajes de junio de la
  // base local (todos tienen created_at 2026-09-18 02:17:35) y la ventana de
  // marcadores paso a 6 s. Verificado con git bisect: el codigo del 17/09
  // (22c56e3, el que fijo los valores anteriores) da HOY exactamente lo
  // mismo que el codigo actual sobre estos datos.   // Antes: total 477, onTime 37, late 28, absent 214, excused 1.
  assert.equal(json.summary.total, 478);
  assert.equal(json.summary.onTime, 74);
  assert.equal(json.summary.late, 35);
  assert.equal(json.summary.lateJustified, 0);
  assert.equal(json.summary.absent, 61);
  assert.equal(json.summary.excused, 0);
});

test('/api/labor-engine/attendance/:date 2026-06-29 (dia con una exclusion FULL_DAY): mismos totales que hoy', async (t) => {
  if (await saltarSinDatosReales(t)) return;
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-29`, { headers });
  const json = await res.json();
  // Actualizado 2026-09-28 (ver el test anterior): 2525 sigue teniendo su
  // excepcion FULL_DAY ("articulo 55") este dia, pero con los datos
  // reimportados el 18/09 tambien FICHO (06:53 y 13:43), y el fichaje manda:
  // queda OnTime y ya no suma a Excused. Lo que este test cuidaba (una
  // excepcion de dia completo SIN fichaje cuenta como Excused) pasa a
  // probarse con datos propios en leave-conflict.test.js.
  // Antes: excused 1, onTime 69, late 10.
  assert.equal(json.summary.excused, 0);
  assert.equal(json.summary.onTime, 111);
  assert.equal(json.summary.late, 21);
});

test('/api/labor-engine/attendance/:date sin token: 401', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-30`, {
    headers: { 'x-api-key': process.env.API_KEY }
  });
  assert.equal(res.status, 401);
});
