// Regla de alcance de un feriado por ciudad -- UNICA implementacion, usada
// por los 3 motores que calculan asistencia (motor diario, Legacy,
// /attendance-range) para no reimplementarla 3 veces de forma divergente
// (ver holidays-by-ciudad, Fase 21).
//
// ciudad_id NULL en el feriado = aplica a toda la empresa (comportamiento
// historico, cero cambio para los feriados que ya existen). Un empleado sin
// ciudad asignada (hueco permitido a proposito desde el feature de
// ciudad/sucursal obligatoria) NO matchea un feriado de ciudad, pero SI
// matchea uno de toda la empresa.
function holidayAppliesToEmployee(holiday, employeeCiudadId) {
  if (holiday.ciudad_id === null || holiday.ciudad_id === undefined) return true;
  if (employeeCiudadId === null || employeeCiudadId === undefined) return false;
  return Number(holiday.ciudad_id) === Number(employeeCiudadId);
}

function isNonWorkHoliday(holiday) {
  return holiday.isWorkDay === 0 || holiday.isWorkDay === '0' || holiday.isWorkDay === false;
}

module.exports = {
  holidayAppliesToEmployee,
  isNonWorkHoliday
};
