// ============================================================================
// Vistas previas de horas extra: dos cálculos COMPLETOS, comparados día por día
// (2026-10-18)
// ============================================================================
//
// "Ver qué cambiaría" (mínimo, método, excepción de plantilla) corre el MISMO
// cálculo de Presentismo dos veces: como está y con la configuración nueva
// (pedido interno con simular*). Después compara lo que cuenta cada persona
// cada día. Antes la vista previa reimplementaba una parte del cálculo y no
// veía el régimen (mínimo propio, topes): podía prometer algo distinto de lo
// que pasaba al guardar. Así, lo que muestra es exactamente lo que va a pasar.
//
// Pura: recibe los `heDias` de las dos respuestas.

/**
 * @param {{employeeId:string, nombre?:string, fecha:string, auto:number, aRevisar:boolean, estimada:boolean}[]} hoy
 * @param {typeof hoy} con
 */
function compararDias(hoy, con) {
  const clave = (x) => `${x.employeeId}|${x.fecha}`;
  const mapaHoy = new Map(hoy.map((x) => [clave(x), x]));
  const mapaCon = new Map(con.map((x) => [clave(x), x]));
  const filas = [];
  for (const k of new Set([...mapaHoy.keys(), ...mapaCon.keys()])) {
    const a = mapaHoy.get(k) || { auto: 0, aRevisar: false };
    const b = mapaCon.get(k) || { auto: 0, aRevisar: false };
    if (a.auto === b.auto && !!a.aRevisar === !!b.aRevisar) continue;
    const base = mapaHoy.get(k) || mapaCon.get(k);
    filas.push({
      employeeId: base.employeeId, nombre: base.nombre || '', fecha: base.fecha,
      hoy: a.auto || 0, con: b.auto || 0, aRevisarHoy: !!a.aRevisar, aRevisarCon: !!b.aRevisar,
      estimada: !!(a.estimada || b.estimada),
    });
  }
  return filas;
}

function resumen(filas) {
  const porPersona = new Map();
  for (const f of filas) {
    const p = porPersona.get(f.employeeId) || { employeeId: f.employeeId, nombre: f.nombre, hoy: 0, con: 0, dias: 0 };
    p.hoy += f.hoy; p.con += f.con; p.dias++;
    porPersona.set(f.employeeId, p);
  }
  return {
    dias: filas.length,
    personas: porPersona.size,
    minutosHoy: filas.reduce((a, f) => a + f.hoy, 0),
    minutosCon: filas.reduce((a, f) => a + f.con, 0),
    diasQueSuman: filas.filter((f) => f.con > f.hoy).length,
    diasQueRestan: filas.filter((f) => f.con < f.hoy).length,
    aRevisarHoy: filas.filter((f) => f.aRevisarHoy).length,
    aRevisarCon: filas.filter((f) => f.aRevisarCon).length,
    ejemplos: [...porPersona.values()].sort((a, b) => Math.abs(b.con - b.hoy) - Math.abs(a.con - a.hoy)).slice(0, 10),
  };
}

module.exports = { compararDias, resumen };
