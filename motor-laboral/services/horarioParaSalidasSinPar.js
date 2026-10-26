// ============================================================================
// Con qué horario se completa una salida que quedó "sin par" (2026-10-10)
// ============================================================================
//
// QUÉ RESUELVE
// ------------
// Salidas (particulares y oficiales) tiene dos casos en que falta un extremo:
//   - salida SIN REGRESO: se fue con el marcador y no volvió a fichar ese día.
//     Se cierra a la hora de SALIDA de su horario de ese día.
//   - "entrada particular": llegó con el marcador de regreso sin haber salido
//     (se lo autorizaron el día anterior). Se abre a la hora de ENTRADA.
//
// EL ERROR QUE ARREGLA (encontrado al copiar el legajo 2525 a la demo)
// -------------------------------------------------------------------
// Hasta ahora se usaba el horario POR DEFECTO DE LA EMPRESA, no el de la
// persona. A quien tiene otro horario se le cerraba la salida a otra hora.
// Medido en AVP, ene–oct 2026: 1.732 de 1.925 salidas sin regreso, 142
// personas, ~43.000 minutos (típico: horario hasta las 14:00, cerrada a las
// 13:38). Y si no había horario, el código inventaba 07:00 y 13:40 (los de
// AVP), también un sábado o un franco.
//
// CÓMO DECIDE AHORA (en este orden)
// ---------------------------------
//   1. El horario ASIGNADO a la persona ese día: la misma función que usa
//      Presentismo (findAssignedScheduleMapForDate: rotativos, vigencias,
//      asignaciones superpuestas), así las dos pantallas no se contradicen.
//      Si ese día no trabaja (franco, fin de semana), NO se inventa una hora:
//      la salida queda sin duración, con aviso.
//   2. Si no tiene plantilla asignada: el horario general de la empresa (como
//      antes), con aviso "asignale su horario".
//   3. Si tampoco hay horario general: sin duración, con aviso.
// Un turno que cruza la medianoche (sereno de 22 a 6) cierra a la hora de
// salida del DÍA SIGUIENTE.
//
// Una consulta por día para todas las personas (no una por salida).
const scheduleRepository = require('../repositories/scheduleRepository');

const AVISO_SIN_PLANTILLA = 'No tiene plantilla de horario asignada: se usó el horario general de la empresa. Asignale su horario en Horarios de empleados.';
const AVISO_SIN_HORARIO = 'No tiene plantilla de horario asignada y la empresa no tiene un horario general: no se puede calcular la duración. Asignale su horario en Horarios de empleados.';
const AVISO_SIN_JORNADA = 'Su horario no tiene jornada ese día: no se puede calcular la duración.';
const AVISO_EMPRESA_SIN_JORNADA = 'No tiene plantilla de horario asignada y el horario general no tiene jornada ese día: no se puede calcular la duración. Asignale su horario en Horarios de empleados.';

const cruzaMedianoche = (sched) => {
  const trabajo = (sched.blocks || []).filter((b) => b.block_type === 'WORK');
  const ultimo = trabajo[trabajo.length - 1];
  return !!(ultimo && Number(ultimo.crosses_midnight) === 1);
};

/**
 * @returns {Promise<Map<string, {entrada: string|null, salida: string|null, salidaDiaSiguiente: boolean, origen: 'propio'|'empresa'|null, aviso: string|null}>>}
 *          por legajo (texto). entrada/salida 'HH:MM:SS' o null si no se puede usar.
 */
async function horarioParaSalidasSinPar(db, fecha, legajos, tenantId) {
  const resultado = new Map();
  const unicos = [...new Set(legajos.map(String))];
  if (!unicos.length) return resultado;

  const numeros = unicos.map(Number).filter((n) => Number.isFinite(n));
  const propios = numeros.length ? await scheduleRepository.findAssignedScheduleMapForDate(fecha, numeros, db, tenantId) : {};

  let empresa; // se busca una sola vez, y solo si alguien no tiene plantilla
  const horarioEmpresa = async () => {
    if (empresa === undefined) {
      const filas = await scheduleRepository.findByDate(fecha, tenantId, db);
      empresa = (Array.isArray(filas) ? filas[0] : filas) || null;
    }
    return empresa;
  };
  const trabaja = (s) => s && Number(s.isWorkDay) === 1 && s.timeEntrance && s.timeExit;

  for (const legajo of unicos) {
    const propio = propios[legajo] ?? propios[Number(legajo)];
    if (propio) {
      resultado.set(legajo, trabaja(propio)
        ? { entrada: propio.timeEntrance, salida: propio.timeExit, salidaDiaSiguiente: cruzaMedianoche(propio), origen: 'propio', aviso: null }
        : { entrada: null, salida: null, salidaDiaSiguiente: false, origen: 'propio', aviso: AVISO_SIN_JORNADA });
      continue;
    }
    const general = await horarioEmpresa();
    if (!general) {
      resultado.set(legajo, { entrada: null, salida: null, salidaDiaSiguiente: false, origen: null, aviso: AVISO_SIN_HORARIO });
    } else if (!trabaja(general)) {
      resultado.set(legajo, { entrada: null, salida: null, salidaDiaSiguiente: false, origen: 'empresa', aviso: AVISO_EMPRESA_SIN_JORNADA });
    } else {
      resultado.set(legajo, { entrada: general.timeEntrance, salida: general.timeExit, salidaDiaSiguiente: cruzaMedianoche(general), origen: 'empresa', aviso: AVISO_SIN_PLANTILLA });
    }
  }
  return resultado;
}

// 'HH:MM[:SS]' en el día de `base` (Date), opcionalmente al día siguiente.
function horaEnElDia(base, hhmmss, diaSiguiente = false) {
  if (!hhmmss) return null;
  const [h, m] = String(hhmmss).split(':').map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + (diaSiguiente ? 1 : 0), h, m, 0);
}

module.exports = { horarioParaSalidasSinPar, horaEnElDia, AVISO_SIN_PLANTILLA, AVISO_SIN_HORARIO, AVISO_SIN_JORNADA, AVISO_EMPRESA_SIN_JORNADA };
