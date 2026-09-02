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
  // Valores actualizados 2026-09-01, en dos pasos:
  // 1) unificacion del motor de horas extra con la regla "clasica" de
  //    index.html (2do fichaje post-corte, topeado a 6:00/dia, descarta
  //    dias sin actividad 07-14h) -- antes (heuristica vieja: ultimo
  //    fichaje menos 13:40 fijo, sin tope) daba 3621.52/141.
  // 2) integracion de la PRIORIDAD 1 real (badges 9/10, categoria HE en
  //    specialusers, via movementsCalculations.detectMovements) sobre esa
  //    regla clasica -- badge 10 estaba mal configurado (direction SALIDA
  //    en vez de REGRESO) y el badge 9 no existia como marcador todavia;
  //    al corregir ambos el total sube de 2085.22/103 a este valor, porque
  //    varios dias que la regla clasica descartaba (sin actividad post-corte
  //    detectable) si tenian una marca real de hora extra.
  assert.equal(sumOvertime.toFixed(2), '2465.24', 'suma total de horas extras del mes');
  assert.equal(withOvertime, 107, 'cantidad de empleados con horas extras > 0');
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
  // Actualizado 2026-09-01 junto con el total de arriba (antes '38.32').
  assert.equal(perrotta.overtimeHours, '38.10');
  assert.equal(perrotta.personalLeaveLimitHours, '4.00');
});

test('/attendance-range sin token: 401', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, {
    headers: { 'x-api-key': process.env.API_KEY }
  });
  assert.equal(res.status, 401);
});
