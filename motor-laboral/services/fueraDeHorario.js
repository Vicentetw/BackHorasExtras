// ============================================================================
// "Fuera de su horario": ¿los fichajes del dia coinciden con su plantilla?
// ============================================================================
//
// POR QUE EXISTE
// --------------
// Pedido del dueño (2026-10-07): poder VER cuando alguien ficha en un horario
// que no es el de su plantilla, para verificar. Casos reales que lo motivaron:
//   - AGUILAR 3056: esta semana hace noche (23 a 7) pero tiene asignada
//     "turno de 15 a 23". Su salida de las 07:04 se leia como "Entrada, a
//     tiempo". Es el caso tipico de un horario ROTATIVO mal aplicado.
//   - BELCARO 2107: plantilla Administracion (07:00), fichó a las 05:08 para
//     salir al campo.
//
// QUE HACE (y que NO)
// -------------------
// Solo AVISA. No cambia el estado del dia (A tiempo, Tarde...), ni las horas
// extra, ni ningun numero. Es para que alguien mire.
//
// LOS TRES CASOS
// --------------
//   sin_turno   ficho un dia que segun su plantilla no trabaja (franco).
//   no_coincide ningun fichaje esta cerca de su hora de entrada NI de su hora
//               de salida: parece otro turno (rotativo mal cargado).
//   antes       llego bastante antes de su hora de entrada (pero algo coincide
//               con su horario, ej. se fue a su hora).
// "Cerca" y "bastante antes" = `umbralMinutos` (configurable por empresa en
// "Configurar avisos"; null = aviso apagado).
//
// Los feriados NO se evaluan: fichar un feriado ya tiene su propio estado
// ("Trabajó feriado"). Llegar tarde tampoco: ya es el estado "Tarde".

const aMinutos = (hhmm) => {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (s) => String(s).slice(0, 5);
const duracion = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
};

/**
 * @param {object} p
 * @param {string[]} p.fichajes        horas del dia, 'HH:MM' (o 'YYYY-MM-DD HH:MM:SS'), en orden
 * @param {boolean}  p.esDiaDeTrabajo  segun su plantilla
 * @param {boolean}  [p.esFeriado]
 * @param {string}   [p.entrada]       'HH:MM' de su plantilla ese dia
 * @param {string}   [p.salida]        'HH:MM'
 * @param {boolean}  [p.cruzaMedianoche] el turno termina al dia siguiente
 * @param {string}   [p.plantilla]     nombre, para el texto
 * @param {number|null} p.umbralMinutos null = apagado
 * @returns {null | { tipo: 'sin_turno'|'no_coincide'|'antes', texto: string, minutos?: number }}
 */
function evaluarFueraDeHorario({ fichajes, esDiaDeTrabajo, esFeriado = false, entrada, salida, cruzaMedianoche = false, plantilla = null, umbralMinutos }) {
  if (umbralMinutos == null || !fichajes || fichajes.length === 0 || esFeriado) return null;
  const horas = fichajes.map((f) => (String(f).length > 5 ? String(f).slice(11, 16) : hhmm(f)));
  const deQuien = plantilla ? `su plantilla "${plantilla}"` : 'su horario';
  const lista = horas.join(', ');

  if (!esDiaDeTrabajo) {
    return { tipo: 'sin_turno', texto: `Fichó (${lista}) un día en que ${deQuien} no tiene turno.` };
  }
  if (!entrada || !salida) return null;

  const ini = aMinutos(entrada);
  const fin = aMinutos(salida);
  const mins = horas.map(aMinutos);
  const cerca = (ref) => mins.some((m) => Math.abs(m - ref) <= umbralMinutos);
  const turno = `${hhmm(entrada)} a ${hhmm(salida)}${cruzaMedianoche ? ' (termina al día siguiente)' : ''}`;

  // Un turno que termina al dia siguiente no tiene su salida en ESTE dia:
  // solo se puede comparar con la entrada.
  const coincideAlgo = cerca(ini) || (!cruzaMedianoche && cerca(fin));
  if (!coincideAlgo) {
    return {
      tipo: 'no_coincide',
      texto: `Ninguno de sus fichajes (${lista}) está cerca de ${deQuien} (${turno}). ¿Le corresponde otro horario ese día?`,
    };
  }
  const antes = ini - mins[0];
  if (antes > umbralMinutos) {
    return {
      tipo: 'antes',
      minutos: antes,
      texto: `Llegó a las ${horas[0]}, ${duracion(antes)} antes de ${deQuien} (${turno}).`,
    };
  }
  return null;
}

module.exports = { evaluarFueraDeHorario };
