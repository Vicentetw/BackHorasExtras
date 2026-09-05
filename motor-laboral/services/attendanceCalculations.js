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
  evaluateMultiVisitDay
};
