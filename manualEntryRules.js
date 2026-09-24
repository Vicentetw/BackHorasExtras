// ============================================================================
// Reglas de las cargas manuales de horas extra
// ============================================================================
//
// EL PRINCIPIO, dicho por quien opera el sistema:
//
//     "si fichó, esa es la fuente de la verdad"
//
// Una carga manual de hora extra existe para cubrir lo que el reloj NO
// registró. Si el reloj ya registró ese tramo, la carga manual no agrega
// información: agrega tiempo contado dos veces.
//
// EL CASO QUE LO DESTAPO (23/09/2026, legajo 2525)
// -------------------------------------------------
// Fichajes reales: 07:00:34, 13:39:10, 13:39:17, 14:22:11.
// Carga manual de HE: 13:40 -> 14:00 (20 minutos).
//
// Esos 20 minutos caen DENTRO del tiempo ya fichado (07:00 a 14:22), y el
// calculo los sumaba igual: 20 minutos cobrados dos veces.
//
// Medido en produccion el mismo dia: de 9 cargas manuales de HE, 4 se
// superponian, sumando 323 minutos (5,4 horas) contados dos veces. Las
// cuatro eran de pruebas del propio superadmin, asi que ningun empleado
// real quedo mal liquidado -- pero con uso real pasa.
//
// POR QUE HACEN FALTA LAS DOS MITADES
// ------------------------------------
// 1. BLOQUEAR AL CARGAR (validarSolape) -- avisa en el momento en que la
//    persona se puede dar cuenta y corregir.
// 2. NO CONTAR DOS VECES AL CALCULAR (minutosQueNoSeSolapan) -- porque los
//    fichajes pueden llegar DESPUES: el agente sincroniza a la noche y la
//    carga manual se hizo a la mañana. Ahi el solape aparece sin que nadie
//    haya hecho nada mal, y una validacion al guardar no lo ve.
//
// La segunda es la garantia; la primera es la ayuda.

// Los fichajes de un dia definen UN tramo: del primero al ultimo. No se
// intenta deducir idas y vueltas intermedias -- para eso estan los
// marcadores, y no es lo que esta regla tiene que resolver.
function tramoFichado(checktimes) {
  const tiempos = (checktimes || [])
    .map((c) => (c instanceof Date ? c.getTime() : new Date(String(c).replace(' ', 'T')).getTime()))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (tiempos.length < 2) return null; // con un solo fichaje no hay tramo
  return { desde: tiempos[0], hasta: tiempos[tiempos.length - 1] };
}

function aMilis(v) {
  if (v instanceof Date) return v.getTime();
  return new Date(String(v).replace(' ', 'T')).getTime();
}

// Minutos de solape entre la carga manual y el tramo fichado. 0 si no se
// tocan.
function minutosDeSolape({ startDatetime, endDatetime }, checktimes) {
  const tramo = tramoFichado(checktimes);
  if (!tramo) return 0;
  const ini = aMilis(startDatetime);
  const fin = aMilis(endDatetime);
  if (!Number.isFinite(ini) || !Number.isFinite(fin) || fin <= ini) return 0;
  const solape = Math.min(fin, tramo.hasta) - Math.max(ini, tramo.desde);
  return solape > 0 ? Math.round(solape / 60000) : 0;
}

// Para el alta y la edicion. Devuelve null si esta bien, o un mensaje
// explicando el choque.
//
// El mensaje dice las horas concretas y no solo "hay un solape": quien lo
// lee tiene que poder corregirlo sin ir a buscar los fichajes a otra
// pantalla.
function validarSolape({ startDatetime, endDatetime }, checktimes) {
  const tramo = tramoFichado(checktimes);
  if (!tramo) return null;
  const minutos = minutosDeSolape({ startDatetime, endDatetime }, checktimes);
  if (minutos === 0) return null;

  const hhmm = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `Ese horario ya está fichado (${hhmm(tramo.desde)} a ${hhmm(tramo.hasta)}), ` +
         `se superpone ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}. ` +
         `El fichaje del reloj es la fuente de la verdad: cargar horas extra ahí las contaría dos veces. ` +
         `Si faltan horas, cargalas en un horario que no esté fichado.`;
}

// Para el calculo. De los minutos de una carga manual, cuantos NO estan ya
// cubiertos por los fichajes.
//
// Se usa la duracion guardada (durationMinutes) y no el largo del rango,
// porque son cosas distintas: alguien puede cargar "de 18:00 a 22:00, 90
// minutos" para reflejar que dentro de ese rango trabajo hora y media. Se
// descuenta el solape de esa duracion, sin dejarla negativa.
function minutosQueNoSeSolapan(entrada, checktimes) {
  const duracion = Number(entrada.durationMinutes) || 0;
  if (duracion <= 0) return 0;
  const solape = minutosDeSolape(entrada, checktimes);
  return Math.max(0, duracion - solape);
}

module.exports = { tramoFichado, minutosDeSolape, validarSolape, minutosQueNoSeSolapan };
