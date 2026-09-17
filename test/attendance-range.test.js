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
  // Actualizado 2026-09-04: 476 -> 477. Se agrego un empleado real nuevo
  // en la base local (no un empleado de prueba huerfano -- se verifico
  // que no hay ninguno con employee_id/nombre sospechoso) mientras se
  // probaba el formulario de Empleados recien arreglado esta sesion. No
  // afecta el resto de los campos de Perrotta ni la suma total.
  assert.equal(json.data.length, 477, 'cantidad de empleados en el reporte');

  let sumOvertime = 0;
  let withOvertime = 0;
  json.data.forEach((row) => {
    const v = parseFloat(row.overtimeHours) || 0;
    sumOvertime += v;
    if (v > 0) withOvertime += 1;
  });
  // Valores actualizados 2026-09-04: computeDailyOvertime ya no asume un
  // fallback fijo a las "14:00" cuando no hay un 2do fichaje post-corte
  // claro -- ahora arranca del corte REALMENTE CONFIGURADO (pedido
  // explicito del usuario: "el fichaje de ingreso a la hora extra tiene
  // que ser posterior a la hora que se indica de inicio", no una hora
  // hardcodeada distinta de la configuracion). Con el corte actual de la
  // base local (13:38, mas temprano que el "14:00" hardcodeado de antes),
  // varios dias que caian en el fallback ahora suman mas minutos (o dejan
  // de descartarse por dar una duracion negativa) -- sube tanto la suma
  // como la cantidad de empleados con HE > 0. Es una correccion real de
  // la logica de negocio, no un dato crudo distinto (a diferencia del
  // cambio anterior, del mismo dia, que si fue por reimportar el CSV).
  // OJO: como el fallback ahora depende del corte configurado, este
  // numero se mueve si el corte configurado cambia -- no es un bug de
  // este test, es inherente a la regla nueva.
  //
  // Actualizado 2026-09-17: 1740.09 -> 1747.92. Pedido real: "el tope es
  // una opcion solo para que salte un aviso en el detalle, superó límite
  // diario" -- antes se sumaba overtimeResult.cappedMinutes (TRUNCADO al
  // tope configurado), ahora se suma el valor REAL (.minutes); el tope
  // solo prende overtimeOverCap como aviso, ya no recorta el numero. Sube
  // la suma porque algunos dias de junio ya superaban el tope y quedaban
  // truncados en silencio -- withOvertime (cuantos empleados tienen HE>0)
  // no cambia, un dia topeado ya era >0 antes de la correccion tambien.
  assert.equal(sumOvertime.toFixed(2), '1747.92', 'suma total de horas extras del mes');
  assert.equal(withOvertime, 74, 'cantidad de empleados con horas extras > 0');
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
  // Actualizado 2026-09-04 junto con el total de arriba (fallback al corte
  // configurado en vez de "14:00" fijo) -- antes '40.10'.
  assert.equal(perrotta.overtimeHours, '40.30');
  assert.equal(perrotta.personalLeaveLimitHours, '4.00');
});

test('/attendance-range sin token: 401', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, {
    headers: { 'x-api-key': process.env.API_KEY }
  });
  assert.equal(res.status, 401);
});
