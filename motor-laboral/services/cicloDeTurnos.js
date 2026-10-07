// ============================================================================
// Plantillas rotativas: que turno le toca a alguien un dia (reglas puras)
// ============================================================================
//
// DISENO_HORARIOS_ROTATIVOS.md. Una plantilla rotativa es un ciclo de N dias;
// cada dia del ciclo es un TURNO (con uno o varios tramos: "07-12 y 16-20")
// o "sin turno". La asignacion de cada persona dice que fecha es su "dia 1".
//
// Lo importante: un turno se convierte en los MISMOS "bloques del dia" que ya
// usa una plantilla semanal (shift_blocks). Asi todo lo que viene despues
// (tardanza, turno partido, horas extra, noche que cruza medianoche, "Fuera
// de horario") funciona igual, sin saber si la plantilla era semanal o
// rotativa.

const DIA_MS = 24 * 60 * 60 * 1000;

// Dias entre dos fechas 'AAAA-MM-DD' (por calendario, sin horas ni husos).
function diasEntre(desde, hasta) {
  const a = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
  const b = Date.UTC(+hasta.slice(0, 4), +hasta.slice(5, 7) - 1, +hasta.slice(8, 10));
  return Math.round((b - a) / DIA_MS);
}

/**
 * Dia del ciclo (1..largo) que cae en `fecha`, si `diaUno` es el dia 1.
 * Funciona tambien para fechas ANTERIORES al dia 1 (cuenta para atras).
 */
function diaDelCiclo(fecha, diaUno, largo) {
  const n = diasEntre(String(diaUno).slice(0, 10), String(fecha).slice(0, 10));
  return (((n % largo) + largo) % largo) + 1;
}

// Una plantilla es rotativa solo si tiene el modo Y el largo cargados.
const esRotativa = (plantilla) => !!plantilla && plantilla.modo === 'ROTATIVO' && Number(plantilla.cycle_length) > 0;

const aTexto = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Los bloques del dia para una plantilla rotativa, con el mismo formato que
 * las filas de shift_blocks.
 *
 * @param {object} plantilla   fila de work_schedule_templates (+ los datos de la
 *                             asignacion si vienen juntos: cycle_start_date, valid_from)
 * @param {string} fecha       'AAAA-MM-DD'
 * @param {object} datos       { ciclos: Map(templateId -> Map(dia -> shiftId|null)),
 *                               turnos: Map(shiftId -> { id, nombre, tramos:[{inicio,fin,cruza_medianoche}] }) }
 * @param {string} [diaUno]    fecha del dia 1; por defecto cycle_start_date o valid_from de la asignacion
 * @returns {{ bloques: object[], dia: number, turno: object|null }}
 */
function bloquesDelCiclo(plantilla, fecha, datos, diaUno) {
  const inicio = diaUno || plantilla.cycle_start_date || plantilla.valid_from;
  if (!inicio) return { bloques: [], dia: null, turno: null };
  const largo = Number(plantilla.cycle_length);
  const dia = diaDelCiclo(fecha, aTexto(inicio), largo);
  const ciclo = datos.ciclos.get(plantilla.id);
  const shiftId = ciclo ? ciclo.get(dia) : null;
  const turno = shiftId != null ? datos.turnos.get(shiftId) || null : null;
  if (!turno) return { bloques: [], dia, turno: null };
  const bloques = turno.tramos.map((t) => ({
    template_id: plantilla.id,
    block_name: turno.nombre,
    start_time: String(t.inicio).length === 5 ? `${t.inicio}:00` : String(t.inicio),
    end_time: String(t.fin).length === 5 ? `${t.fin}:00` : String(t.fin),
    block_type: 'WORK',
    crosses_midnight: Number(t.cruza_medianoche) ? 1 : 0,
    active: 1,
  }));
  return { bloques, dia, turno: { id: turno.id, nombre: turno.nombre } };
}

// Un tramo cruza medianoche si termina a la misma hora o antes de empezar.
const cruzaMedianoche = (inicio, fin) => String(fin).slice(0, 5) <= String(inicio).slice(0, 5);

module.exports = { diaDelCiclo, diasEntre, esRotativa, bloquesDelCiclo, cruzaMedianoche };
