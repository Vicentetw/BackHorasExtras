// Test de caracterizacion: "congela" el comportamiento ACTUAL de
// /attendance-range contra un mes ya cerrado (junio 2026, no cambia mas
// con el paso del tiempo) para tener una alarma temprana si el proximo
// refactor (unificar el motor + filtro multi-tenant, paso 2 del plan)
// cambia sin querer un resultado que hoy sabemos correcto.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra una base con los mismos datos de referencia -- no
// arranca el server por su cuenta todavia (horasdedica2.js llama
// app.listen() directo, no exporta `app`). Cuando se arme CI/CD esto se
// puede mejorar para levantar el server en el propio test.
//
// Correr con: npm test  (o: node --test test/)
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-characterization';

let headers;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
});

after(async () => {
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/attendance-range junio 2026 (mes cerrado): mismos totales que hoy', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.data.length, 476, 'cantidad de empleados en el reporte');

  let sumOvertime = 0;
  let withOvertime = 0;
  json.data.forEach((row) => {
    const v = parseFloat(row.overtimeHours) || 0;
    sumOvertime += v;
    if (v > 0) withOvertime += 1;
  });
  // Valores actualizados 2026-09-03: la base LOCAL de desarrollo perdio
  // todos los Checkins durante una prueba de Fase 6 (un test de /clear/checkins
  // corrio contra un servidor que todavia tenia el codigo viejo sin el guard
  // de superadmin -- el servidor no se habia reiniciado despues de agregar
  // el guard). Se restauro reimportando descarga-fichaje-py/dist/CHECKINOUT.csv
  // (unico respaldo local disponible), que no es byte-a-byte identico a los
  // datos que habia antes (esta version del reloj tiene menos marcas
  // badge 9/10 de HE real para junio 2026) -- la cantidad de empleados (476)
  // y el resto de los campos de Perrotta no cambiaron, asi que la logica de
  // calculo sigue intacta; solo cambio la data cruda de origen.
  assert.equal(sumOvertime.toFixed(2), '1600.06', 'suma total de horas extras del mes');
  assert.equal(withOvertime, 64, 'cantidad de empleados con horas extras > 0');
});

test('/attendance-range junio 2026: Perrotta (legajo 2525) da los valores conocidos', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, { headers });
  const json = await res.json();
  const perrotta = json.data.find((e) => String(e.employeeId) === '2525');

  assert.ok(perrotta, 'legajo 2525 debe aparecer en el reporte');
  assert.equal(perrotta.name, 'Vicente Perrotta', 'nombre desde employees.nombre, no el crudo del reloj');
  assert.equal(perrotta.daysWorked, 21);
  assert.equal(perrotta.absent, 0);
  assert.equal(perrotta.late, 0);
  // Actualizado 2026-09-03 junto con el total de arriba (ver comentario en
  // el test anterior) -- antes '38.10'.
  assert.equal(perrotta.overtimeHours, '40.10');
  assert.equal(perrotta.personalLeaveLimitHours, '4.00');
});

test('/attendance-range sin token: 401', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, {
    headers: { 'x-api-key': process.env.API_KEY }
  });
  assert.equal(res.status, 401);
});
