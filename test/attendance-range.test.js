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
const { saltarSinDatosReales } = require('../test-helpers/datosReales');

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

test('/attendance-range junio 2026 (mes cerrado): mismos totales que hoy', async (t) => {
  if (await saltarSinDatosReales(t)) return;
  // ?tenantId=6: ver la nota del 2026-10-07 abajo.
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30&tenantId=6`, { headers });
  assert.equal(res.status, 200);

  const json = await res.json();
  // Actualizado 2026-09-04: 476 -> 477. Se agrego un empleado real nuevo
  // en la base local (no un empleado de prueba huerfano -- se verifico
  // que no hay ninguno con employee_id/nombre sospechoso) mientras se
  // probaba el formulario de Empleados recien arreglado esta sesion. No
  // afecta el resto de los campos de Perrotta ni la suma total.
  // Actualizado 2026-09-28: estos valores fallaban desde el 18/09 sin que
  // hubiera ningun bug. Ese dia se reimportaron los fichajes de junio de la
  // base local (todos tienen created_at 2026-09-18 02:17:35) y la ventana de
  // marcadores paso a 6 s. Verificado con git bisect: el codigo del 17/09
  // (22c56e3, el que fijo los valores anteriores) da HOY exactamente lo
  // mismo que el codigo actual sobre estos datos. La unica diferencia de
  // logica en el medio es 7a6678c (un marcador solo lo consume un fichaje
  // del mismo reloj), que bajo la suma de HE de 2771.00 a 2763.46.
  assert.equal(json.data.length, 478, 'cantidad de empleados en el reporte');

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
  //
  // Actualizado 2026-09-17 (2da vez, mismo dia): 1747.92 -> 1730.31. Bug
  // real (Perrotta, ver resolveDailyOvertime en overtimeCalculations.js):
  // un marcador de HE (badge 9) atribuido por error al PRIMER fichaje del
  // dia de un empleado (su propia entrada normal, no un ingreso real a
  // HE) generaba una HE fantasma -- se descarta ahora. Baja la suma porque
  // junio tambien tenia casos asi, no solo el de septiembre que lo
  // destapo. withOvertime sigue en 74 -- ningun empleado quedo en 0 HE
  // solo por esto.
  //
  // Actualizado 2026-09-28: 1730.31 -> 2763.46 y 74 -> 129. Ver el
  // comentario al principio de este test (datos reimportados el 18/09).
  //
  // Actualizado 2026-10-06: 2763.46 -> 2814.59 (+51 h, +1,9 %). Regla de
  // LECTURA REPETIDA aprobada por el dueño (rebote refinado como regla
  // universal, MARCADORES_Y_SALIDAS.md "Doble lectura"): la segunda lectura
  // de la misma persona ya no cierra la hora extra que abrio la primera
  // (ej. legajo 1496, 07/04: 3 h 14 min que contaban 0). Verificado sobre
  // la copia de produccion, empleado por empleado.
  //
  // Actualizado 2026-10-07: 2814.59 -> 2576.66 y 129 -> 113. NO es un cambio
  // de logica: la base local de tests se recargo con el backup de produccion
  // del 07/10. La anterior tenia los fichajes de junio reimportados a mano
  // el 18/09 (ver arriba) y no coincidia con produccion. Comprobado: la copia
  // de produccion de septiembre da con el MISMO codigo 2587.27 / 113; la
  // diferencia de ~10 h son asignaciones de plantilla cargadas despues.
  // Incluye el cambio del marcador "nadie mas en el medio" (2026-10-07):
  // con el codigo anterior, sobre estos mismos datos, da 2537.82.
  // Se pide con ?tenantId=6: desde el aislamiento por empresa, la
  // configuracion de AVP (corte de HE, limites, campaña) es de la empresa 6.
  // Los valores de Perrotta (test siguiente) no cambiaron: 40.30 h, 21 dias.
  assert.equal(sumOvertime.toFixed(2), '2576.66', 'suma total de horas extras del mes');
  assert.equal(withOvertime, 113, 'cantidad de empleados con horas extras > 0');
});

test('/attendance-range junio 2026: Perrotta (legajo 2525) da los valores conocidos', async (t) => {
  if (await saltarSinDatosReales(t)) return;
  // Con la empresa elegida: el limite de salidas particulares (4 h) es una
  // configuracion de AVP, y sin empresa el superadmin no la ve.
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30&tenantId=6`, { headers });
  const json = await res.json();
  const perrotta = json.data.find((e) => String(e.employeeId) === '2525');

  assert.ok(perrotta, 'legajo 2525 debe aparecer en el reporte');
  assert.equal(perrotta.name, 'Vicente Perrotta', 'nombre desde employees.nombre, no el crudo del reloj');
  assert.equal(perrotta.daysWorked, 21);
  assert.equal(perrotta.absent, 0);
  assert.equal(perrotta.late, 0);
  // Actualizado 2026-09-04 junto con el total de arriba (fallback al corte
  // configurado en vez de "14:00" fijo) -- antes '40.10'.
  // Actualizado 2026-09-17: 40.30 -> 40.23 -- descarte de HE fantasma por
  // marcador atribuido a su primer fichaje del dia (ver comentario arriba).
  // Actualizado 2026-09-28: 40.23 -> 40.30. NO es que se deshizo el
  // descarte de HE fantasma del 17/09: el codigo de ese dia tambien da 40.30
  // con los datos reimportados el 18/09 (ver el primer test de este archivo).
  assert.equal(perrotta.overtimeHours, '40.30');
  assert.equal(perrotta.personalLeaveLimitHours, '4.00');
});

test('/attendance-range sin token: 401', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-30`, {
    headers: { 'x-api-key': process.env.API_KEY }
  });
  assert.equal(res.status, 401);
});
