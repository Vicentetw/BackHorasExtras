// Cuenta los dias de una licencia (employee_events.dias) respetando la
// modalidad vigente de su motivo -- extraida como funcion PURA (sin DB
// adentro) para poder testear a fondo el caso dificil sin fixtures: una
// licencia que cruza un cambio de vigencia.
//
// Motivacion: hasta ahora TODO se contaba en dias corridos (diffDaysInclusive,
// que ademas estaba duplicado en el frontend). En la practica Vacaciones/
// Enfermedad/ART se cuentan corridos, pero Articulo 55/Permiso particular/
// Licencia por estudio se cuentan en dias HABILES (lunes a viernes, sin
// feriados) -- una misma empresa necesita las dos modalidades a la vez, una
// por motivo (ver migracion 20260916_event_type_count_modes.sql).
//
// La modalidad de un motivo puede cambiar en el tiempo (una paritaria que
// pasa de corridos a habiles) -- por eso "vigencias" es un HISTORIAL
// ({modo, vigente_desde}[]), no un valor fijo. Se recorre la licencia dia
// por dia y cada dia usa la modalidad vigente ESE dia puntual: si la
// licencia no cruza ningun cambio, da lo mismo que preguntar una vez: si lo
// cruza, el tramo de antes cuenta con la regla vieja y el tramo de despues
// con la nueva, sin ningun caso especial.
function formatLocalDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// vigencias: [{ modo: 'corridos'|'habiles', vigente_desde: 'YYYY-MM-DD' }, ...]
// (en cualquier orden -- se ordenan aca adentro). Sin ninguna vigencia
// aplicable a una fecha (ninguna con vigente_desde <= esa fecha, o el
// array esta vacio) esa fecha se cuenta 'corridos' -- comportamiento de
// siempre, para no cambiarle nada a un motivo que nunca se configuro.
function resolveModoEnFecha(fechaStr, vigenciasOrdenadas) {
  let modo = 'corridos';
  for (const v of vigenciasOrdenadas) {
    if (v.vigente_desde <= fechaStr) {
      modo = v.modo;
    } else {
      break; // ordenadas ascendente -- las que siguen son todas futuras
    }
  }
  return modo;
}

// feriados: { fechas: Set<'YYYY-MM-DD'>, recurrentesMesDia: Set<'MM-DD'> }
// (mismo criterio de "feriado" que ya usa /attendance-range: fecha exacta
// O recurrente todos los anios en ese mes/dia).
function esFeriado(fechaStr, feriados) {
  if (!feriados) return false;
  if (feriados.fechas && feriados.fechas.has(fechaStr)) return true;
  if (feriados.recurrentesMesDia && feriados.recurrentesMesDia.has(fechaStr.slice(5))) return true;
  return false;
}

function esFinDeSemana(date) {
  const dow = date.getDay(); // 0 = domingo, 6 = sabado
  return dow === 0 || dow === 6;
}

/**
 * @param {string} fechaDesde 'YYYY-MM-DD'
 * @param {string} fechaHasta 'YYYY-MM-DD' (inclusive)
 * @param {{modo:string, vigente_desde:string}[]} vigencias historial del motivo
 * @param {{fechas?:Set<string>, recurrentesMesDia?:Set<string>}} [feriados]
 * @returns {number} cantidad de dias a descontar
 */
function contarDiasLicencia(fechaDesde, fechaHasta, vigencias, feriados) {
  const vigenciasOrdenadas = [...(vigencias || [])].sort((a, b) => (a.vigente_desde < b.vigente_desde ? -1 : 1));

  let dias = 0;
  const cursor = parseLocalDate(fechaDesde);
  const fin = parseLocalDate(fechaHasta);

  while (cursor <= fin) {
    const fechaStr = formatLocalDate(cursor);
    const modo = resolveModoEnFecha(fechaStr, vigenciasOrdenadas);
    if (modo === 'habiles') {
      if (!esFinDeSemana(cursor) && !esFeriado(fechaStr, feriados)) dias++;
    } else {
      dias++; // corridos: todos los dias del rango cuentan
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

module.exports = {
  contarDiasLicencia,
  resolveModoEnFecha,
  formatLocalDate,
};
