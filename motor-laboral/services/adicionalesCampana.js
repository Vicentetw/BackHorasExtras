// ============================================================================
// Adicionales de campaña por noches fuera del domicilio (2026-10-13)
// ============================================================================
//
// MÓDULO que el superadmin prende por empresa ('adicionalesCampana', ver
// modulos.js): no todas las empresas tienen esta regla. Los números los
// configura el administrador de cada empresa (Configuración general), con
// los del CCT 572/09 (vialidad) por defecto:
//
//   - Dedicación Funcional Exclusiva (art. 33 B): "Será reconocida solo al
//     trabajador que pernocte en campaña más de doce (12) días dentro de un
//     período de treinta (30) días corridos."
//   - Desarraigo (art. 33 E): proporcional a los días; "por un período mayor
//     a veinte días (20) se les liquidará hasta un sesenta por ciento".
//
// El sistema NO calcula importes (eso es de sueldos): marca a quién le
// corresponde y muestra las noches, para que RRHH lo revise y liquide.
//
// QUÉ ES UNA NOCHE EN CAMPAÑA
// ---------------------------
// Cada noche entre el día de salida y el día de regreso: salir el lunes y
// volver el viernes son 4 noches (lunes, martes, miércoles y jueves). Salir
// y volver el mismo día: 0 noches. Sin regreso todavía: hasta el día
// anterior al fin del período consultado (la noche de ese día aún no pasó).

const POR_DEFECTO = { nochesParaDedicacion: 12, ventanaDias: 30, diasParaDesarraigoMayor: 20 };
const RANGOS = { nochesParaDedicacion: [1, 60], ventanaDias: [7, 92], diasParaDesarraigoMayor: [1, 366] };

const p2 = (n) => String(n).padStart(2, '0');
const fecha = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const deTexto = (s) => { const [a, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(a, m - 1, d); };
const sumarDias = (s, n) => { const d = deTexto(s); d.setDate(d.getDate() + n); return fecha(d); };

function normalizarConfig(guardada) {
  const out = { ...POR_DEFECTO };
  for (const [k, [min, max]] of Object.entries(RANGOS)) {
    const n = Number(guardada && guardada[k]);
    if (Number.isInteger(n) && n >= min && n <= max) out[k] = n;
  }
  return out;
}

/** Noches (fechas 'AAAA-MM-DD') de una campaña. hasta: fin del período consultado. */
function nochesDeCampana(timeOut, timeIn, hasta) {
  if (!timeOut) return [];
  const desde = fecha(timeOut);
  const ultima = timeIn ? sumarDias(fecha(timeIn), -1) : sumarDias(hasta, -1);
  const noches = [];
  for (let d = desde; d <= ultima; d = sumarDias(d, 1)) noches.push(d);
  return noches;
}

/**
 * Por persona: noches en [desde, hasta] y el máximo de noches en cualquier
 * ventana de `ventanaDias` corridos que termine dentro del período.
 * @param campanas [{ employeeId, timeOut: Date, timeIn: Date|null }]
 */
function resumirNoches(campanas, desde, hasta, config) {
  const nochesPorPersona = new Map();
  for (const c of campanas) {
    const set = nochesPorPersona.get(c.employeeId) || new Set();
    for (const n of nochesDeCampana(c.timeOut, c.timeIn, hasta)) set.add(n);
    nochesPorPersona.set(c.employeeId, set);
  }
  const resultado = [];
  for (const [employeeId, noches] of nochesPorPersona) {
    let enPeriodo = 0;
    for (const n of noches) if (n >= desde && n <= hasta) enPeriodo++;
    let max = 0; let ventana = null;
    for (let fin = desde; fin <= hasta; fin = sumarDias(fin, 1)) {
      const ini = sumarDias(fin, -(config.ventanaDias - 1));
      let k = 0;
      for (const n of noches) if (n >= ini && n <= fin) k++;
      if (k > max) { max = k; ventana = { desde: ini, hasta: fin }; }
    }
    if (enPeriodo === 0 && max === 0) continue;
    resultado.push({
      employeeId,
      nochesEnPeriodo: enPeriodo,
      maxNochesEnVentana: max,
      ventanaDelMaximo: ventana,
      // "más de doce": estrictamente mayor
      dedicacionFuncional: max > config.nochesParaDedicacion,
    });
  }
  return resultado;
}

module.exports = { POR_DEFECTO, RANGOS, normalizarConfig, nochesDeCampana, resumirNoches, sumarDias };
