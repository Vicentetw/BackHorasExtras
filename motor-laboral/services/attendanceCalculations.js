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

module.exports = {
  timeToMinutes,
  getEntranceReference,
  resolveToleranceMinutes,
  resolveLateJustification
};
