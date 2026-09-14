// Piezas de calculo de asistencia que hoy estan duplicadas, byte a byte,
// entre /attendance-range (horasdedica2.js) y calculateDailyAttendance
// (attendanceService.js). Se extraen aca para que exista una sola fuente
// de verdad de esta regla de negocio -- ver el plan de unificacion B.4.
//
// IMPORTANTE: estas funciones son puras (sin I/O, sin acceso a la base).
// No incluyen todavia el calculo de horas extra / salida particular ni el
// status WorkedHoliday, porque esas dos rutas divergieron en esas features
// y unificarlas cambiaria comportamiento observable -- eso queda para una
// decision de producto aparte, no para este refactor.

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// ==========================
// Turnos que cruzan medianoche ("sereno", guardias 22:00-06:00, etc.)
// ==========================
// Bug real confirmado (prueba de estres pre-venta, sept 2026): los fichajes
// se agrupaban por DIA CALENDARIO de CHECKTIME. Para un turno 22:00-06:00,
// la salida de una noche (ej. 06:05) cae en el MISMO dia calendario que la
// entrada de la noche siguiente (ej. 22:35) -- ese dia queda con DOS marcas,
// y el motor toma la primera CRONOLOGICA (06:05, la salida de la noche
// anterior) como si fuera la entrada de hoy. Una "entrada" de madrugada
// nunca puede llegar tarde respecto de un turno que arranca de noche -- una
// llegada tarde real a un turno de sereno quedaba invisible SIEMPRE, no como
// caso de borde. La columna shift_blocks.crosses_midnight ya existia en la
// base y en el admin de plantillas, pero ningun calculo la usaba.
//
// Solucion: antes de calcular el estado de un dia D, se saca de sus
// fichajes cualquier marca de madrugada que en realidad sea la SALIDA del
// turno de D-1 (si el turno de D-1 cruza medianoche) -- esa marca se
// reasigna al dia D-1 (para que tenga una salida correcta) y se excluye del
// calculo de entrada/tardanza de D. Dicho de otra forma: cada marca queda
// atribuida a la JORNADA DE TRABAJO a la que realmente pertenece, no al
// dia calendario en el que cayo el reloj.
const OVERNIGHT_CARRYOVER_MARGIN_MINUTES = 240; // 4hs de margen despues del fin de turno -- una salida demorada sigue siendo "de anoche", no una entrada nueva.

function findCrossingWorkBlock(schedule) {
  if (!schedule || !Array.isArray(schedule.blocks)) return null;
  return schedule.blocks.find((b) => b.block_type === 'WORK' && Number(b.crosses_midnight) === 1) || null;
}

function extractTimeHHMM(checkTimeStr) {
  const part = checkTimeStr && checkTimeStr.split(' ')[1];
  return part ? part.substring(0, 5) : null;
}

// checksOfDay: string[] 'YYYY-MM-DD HH:MM:SS' (fichajes YA atribuidos al dia
// calendario D, sin ordenar o ya ordenados -- da igual, se re-ordena por
// las dudas). previousDaySchedule: el schedule de D-1 para ESTE empleado (o
// null/undefined si no se pudo resolver -- en ese caso no se filtra nada,
// mismo comportamiento que antes de este fix). Devuelve { checks, carryover }:
// "checks" es lo que le queda a D (ya sin la salida de D-1, ordenado),
// "carryover" son las marcas que en realidad son la salida de D-1.
function stripOvernightCarryover(checksOfDay, previousDaySchedule) {
  const sorted = (checksOfDay || []).slice().sort();
  const crossingBlock = findCrossingWorkBlock(previousDaySchedule);
  if (!crossingBlock) {
    return { checks: sorted, carryover: [] };
  }

  const cutoffMinutes = timeToMinutes(crossingBlock.end_time) + OVERNIGHT_CARRYOVER_MARGIN_MINUTES;
  const carryover = [];
  const checks = [];
  for (const c of sorted) {
    const minutes = timeToMinutes(extractTimeHHMM(c));
    (minutes <= cutoffMinutes ? carryover : checks).push(c);
  }
  return { checks, carryover };
}

// Aplica stripOvernightCarryover dia por dia, en orden, sobre TODOS los
// fichajes de un mismo empleado -- la salida que se le saca a un dia se
// suma a la jornada anterior (para que le quede una salida real), y asi en
// cadena. checksByDate: { 'YYYY-MM-DD': string[] }. getScheduleForDate:
// (dateStr) => schedule de ese dia para este empleado, o null si no se
// puede resolver. datesAscendingWithPadding: TODAS las fechas consecutivas
// a procesar, SIN huecos, incluyendo (si estan disponibles) un dia extra
// antes del rango pedido (para saber si ESE dia cruzaba medianoche y asi
// limpiar el primer dia del rango) y un dia extra despues (para poder
// encontrarle la salida real al ultimo dia del rango, si tambien cruza
// medianoche) -- ninguno de los dos dias de margen se devuelve como
// resultado propio, solo se usan para limpiar los dias del medio.
function reassignOvernightCheckins(checksByDate, getScheduleForDate, datesAscendingWithPadding) {
  const adjusted = {};
  for (const d of datesAscendingWithPadding) {
    adjusted[d] = (checksByDate[d] || []).slice();
  }

  for (let i = 1; i < datesAscendingWithPadding.length; i++) {
    const today = datesAscendingWithPadding[i];
    const yesterday = datesAscendingWithPadding[i - 1];
    const previousDaySchedule = getScheduleForDate(yesterday);
    const { checks, carryover } = stripOvernightCarryover(adjusted[today], previousDaySchedule);
    if (carryover.length > 0) {
      adjusted[today] = checks;
      adjusted[yesterday] = adjusted[yesterday].concat(carryover);
    }
  }
  return adjusted;
}

function getEntranceReference(schedule) {
  if (schedule.source === 'motor' && schedule.blocks && schedule.blocks.length > 0) {
    const workBlocks = schedule.blocks.filter(b => b.block_type === 'WORK');
    if (workBlocks.length > 0) {
      return workBlocks[0].start_time;
    }
  }
  return schedule.timeEntrance;
}

function resolveToleranceMinutes(schedule) {
  return schedule.source === 'motor' && schedule.template_type === 'FLEXIBLE' ? 60 : 10;
}

// firstMinutes/entranceMinutes en minutos desde medianoche; exclusion es la
// fila de userexclusions del dia (o null/undefined si no hay).
function resolveLateJustification({ firstMinutes, entranceMinutes, toleranceMinutes, exclusion }) {
  const isLate = firstMinutes > entranceMinutes + toleranceMinutes;
  if (!isLate) {
    return { isLate: false, lateMinutes: 0, justified: false };
  }

  const lateMinutes = firstMinutes - entranceMinutes;
  const excToMin = exclusion && exclusion.excTo ? timeToMinutes(exclusion.excTo) : null;
  const justified = !!exclusion && (excToMin === null || firstMinutes <= excToMin);

  return { isLate: true, lateMinutes, justified };
}

// Turno partido / visitas multiples en un mismo dia (profesor que da clase a
// la mañana y a la tarde, medico que atiende en dos horarios): cada bloque
// WORK de la plantilla es una "visita" independiente y requiere su propia
// entrada + salida, en vez de aplastarse en un unico entrance/exit como hacia
// buildScheduleFromBlocks (ver scheduleRepository.js). Solo se llama cuando
// el dia tiene MAS de un bloque WORK -- el caso de un solo bloque sigue
// exactamente igual que antes (resolveLateJustification de arriba), para no
// tocar el comportamiento de ningun empleado existente (hoy ninguno tiene
// mas de un bloque WORK por dia).
//
// Emparejamiento posicional: se asume que los fichajes de un dia con N
// bloques vienen en 2N marcas alternadas entrada/salida (fichaje 0 y 1 son
// la visita 1, 2 y 3 la visita 2, etc.) -- es la misma suposicion de
// alternancia estricta que ya usa el resto del motor (primera/ultima marca).
// checkinsSorted: string[] ('YYYY-MM-DD HH:MM:SS', ya ordenados). Devuelve
// null si no hay ningun fichaje (el llamador ya distingue Absent/Excused
// antes de llamar a esto).
function evaluateMultiVisitDay({ workBlocks, checkinsSorted, toleranceMinutes, exclusion }) {
  if (!checkinsSorted || checkinsSorted.length === 0) return null;

  const blocks = workBlocks.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
  const visits = blocks.map((block, i) => {
    const entrada = checkinsSorted[i * 2] || null;
    const salida = checkinsSorted[i * 2 + 1] || null;
    let isLate = false;
    let lateMinutes = 0;
    let justified = false;

    if (entrada) {
      const entradaMinutes = timeToMinutes(entrada.split(' ')[1].substring(0, 5));
      ({ isLate, lateMinutes, justified } = resolveLateJustification({
        firstMinutes: entradaMinutes,
        entranceMinutes: timeToMinutes(block.start_time),
        toleranceMinutes,
        exclusion
      }));
    }

    return {
      blockId: block.id,
      blockName: block.block_name || null,
      startTime: block.start_time,
      endTime: block.end_time,
      entrada,
      salida,
      isLate,
      lateMinutes,
      justified,
      missing: !entrada ? 'both' : !salida ? 'salida' : 'none'
    };
  });

  const isPartial = visits.some(v => v.missing !== 'none');
  const firstVisit = visits[0];

  return {
    visits,
    isPartial,
    isLate: firstVisit ? firstVisit.isLate : false,
    lateMinutes: firstVisit ? firstVisit.lateMinutes : 0,
    justified: firstVisit ? firstVisit.justified : false
  };
}

module.exports = {
  timeToMinutes,
  getEntranceReference,
  resolveToleranceMinutes,
  resolveLateJustification,
  evaluateMultiVisitDay,
  findCrossingWorkBlock,
  stripOvernightCarryover,
  reassignOvernightCheckins,
  OVERNIGHT_CARRYOVER_MARGIN_MINUTES
};
