// Etapa 5 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt). Capacidad NUEVA: representar la
// jornada de un dia como una coleccion de SEGMENTOS independientes, sin
// aplastarlos en una unica entrada/salida como hace hoy
// scheduleRepository.buildScheduleFromBlocks (que sigue existiendo tal
// cual, sin tocar -- lo sigue usando todo el camino Legacy).
//
// Esta funcion es PURA (sin acceso a DB) y todavia NO esta conectada a
// ningun endpoint ni reemplaza ningun calculo existente -- ver la Etapa 5
// del plan: "no modificar innecesariamente el calculo actual". Es la base
// que van a usar TimeSegmentCalculator (Etapa 6) y TimeClassifier
// (Etapa 7/8) para resolver tolerancias y horas extra por segmento en vez
// de por un unico entrance/exit.
const { timeToMinutes } = require('./attendanceCalculations');

// blocks: filas crudas de shift_blocks de UN dia de semana (mismo shape
// que ya devuelve `SELECT * FROM shift_blocks WHERE day_of_week = ?`).
// Devuelve los segmentos WORK normalizados y ordenados por hora de inicio.
// No decide nada sobre tolerancias, horas extra ni ausencias -- eso es
// responsabilidad de los modulos de las etapas siguientes.
function resolveScheduleSegments(blocks) {
  const workBlocks = (blocks || []).filter(
    (b) => b.block_type === 'WORK' && (b.active === undefined || b.active === null || Number(b.active) === 1)
  );

  return workBlocks
    .slice()
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time))
    .map((b) => {
      const startMinutes = timeToMinutes(b.start_time);
      const endMinutes = timeToMinutes(b.end_time);
      // El flag crosses_midnight manda; si no esta seteado pero end < start
      // igual implica un cruce (defensivo, no deberia pasar con datos bien
      // cargados desde el admin de plantillas).
      const crossesMidnight = !!Number(b.crosses_midnight) || endMinutes < startMinutes;
      const durationMinutes = crossesMidnight
        ? (24 * 60 - startMinutes) + endMinutes
        : endMinutes - startMinutes;

      return {
        blockId: b.id ?? null,
        name: b.block_name || null,
        startTime: b.start_time,
        endTime: b.end_time,
        startMinutes,
        endMinutes,
        crossesMidnight,
        durationMinutes
      };
    });
}

module.exports = {
  resolveScheduleSegments
};
