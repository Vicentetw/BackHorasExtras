// ============================================================================
// Cupo por motivo ("Artículo 55: no más de 6 por año") -- calculo PURO
// ============================================================================
//
// Sin base de datos adentro: recibe los datos ya leidos y devuelve cuanto se
// consumio. Asi las reglas de RRHH, que son las que importan, se prueban a
// fondo sin fixtures (test/cupo-motivos.test.js). La lectura de datos esta en
// motor-laboral/repositories/cupoMotivoRepository.js.
//
// LAS REGLAS (criterio de RRHH, decidido el 2026-09-28)
// -----------------------------------------------------
// 1. Solo consume un dia en que la persona NO trabajo. Un "articulo 55" en
//    un dia que ficho no es una falta justificada: es un error de carga (o
//    del fichaje), y ya tiene su propio aviso en Presentismo. Lo mismo si
//    vuelve antes de terminar las vacaciones: los dias que ficho dentro de
//    la licencia no se descuentan.
// 2. Un mismo dia cargado dos veces (como licencia Y como justificacion, o
//    dos licencias que se pisan) cuenta UNA sola vez.
// 3. Se respeta la modalidad del motivo (corridos / habiles, con su
//    historial de vigencias): en habiles no cuentan sabados, domingos ni
//    feriados. Es la misma funcion que ya calcula los dias de las licencias
//    (leaveDaysCalculations.js), no una segunda version.
// 4. Los permisos horarios (justificaciones que no son de dia completo) no
//    gastan dias de cupo en esta version: el llamador solo pasa las de dia
//    completo.
const { resolveModoEnFecha, formatLocalDate } = require('./leaveDaysCalculations');

function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function* fechasEntre(desde, hasta) {
  const cursor = parseLocalDate(desde);
  const fin = parseLocalDate(hasta);
  while (cursor <= fin) {
    yield formatLocalDate(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }
}

function esFeriado(fecha, feriados) {
  if (!feriados) return false;
  return (feriados.fechas && feriados.fechas.has(fecha))
    || (feriados.recurrentesMesDia && feriados.recurrentesMesDia.has(fecha.slice(5)));
}

/**
 * Periodo anual que contiene a `fecha`.
 *   'calendario'  -> 1/1 al 31/12 de ese año.
 *   'aniversario' -> desde el ultimo aniversario de ingreso (inclusive) hasta
 *                    el dia anterior al proximo. Sin fecha de ingreso cae a
 *                    calendario (no se inventa una).
 * Un ingreso un 29/02 cumple "aniversario" el 01/03 en los años no bisiestos.
 */
function periodoAnual(fecha, tipo, fechaAlta) {
  const [y] = fecha.split('-').map(Number);
  if (tipo !== 'aniversario' || !fechaAlta) {
    return { desde: `${y}-01-01`, hasta: `${y}-12-31` };
  }
  const [, ma, da] = fechaAlta.slice(0, 10).split('-').map(Number);
  const aniversario = (anio) => formatLocalDate(new Date(anio, ma - 1, da));
  let inicio = aniversario(y);
  if (inicio > fecha) inicio = aniversario(y - 1);
  const [yi] = inicio.split('-').map(Number);
  const siguiente = parseLocalDate(aniversario(yi + 1));
  siguiente.setDate(siguiente.getDate() - 1);
  return { desde: inicio, hasta: formatLocalDate(siguiente) };
}

/**
 * Regla de cupo vigente a una fecha, o null si el motivo no tiene cupo.
 * @param {{vigente_desde:string}[]} cupos historial del motivo
 */
function cupoVigente(fecha, cupos) {
  let vigente = null;
  for (const c of [...(cupos || [])].sort((a, b) => (a.vigente_desde < b.vigente_desde ? -1 : 1))) {
    if (c.vigente_desde <= fecha) vigente = c;
  }
  return vigente;
}

/**
 * Cuantos dias consumio una persona de un motivo dentro de un periodo.
 *
 * @param {object} p
 * @param {{desde:string, hasta:string}} p.periodo
 * @param {{fecha_desde:string, fecha_hasta:string}[]} p.licencias  del motivo
 * @param {string[]} p.justificaciones  fechas de justificaciones de dia completo del motivo
 * @param {Set<string>} p.diasFichados  fechas en que la persona ficho
 * @param {{modo:string, vigente_desde:string}[]} p.vigenciasModo  corridos/habiles
 * @param {{fechas?:Set<string>, recurrentesMesDia?:Set<string>}} p.feriados
 * @param {{desde:string, hasta:string}|null} [p.nuevo]  lo que se esta por cargar
 * @returns {{ usados:number, usadosConNuevo:number, porMes:Object<string,number>,
 *             porMesConNuevo:Object<string,number>, detalle:{fecha:string, origen:string[], cuenta:boolean, porQueNo?:string}[] }}
 */
function calcularConsumo({ periodo, licencias, justificaciones, diasFichados, vigenciasModo, feriados, nuevo = null }) {
  const origenes = new Map(); // fecha -> Set de origenes
  const agregar = (fecha, origen) => {
    if (fecha < periodo.desde || fecha > periodo.hasta) return;
    if (!origenes.has(fecha)) origenes.set(fecha, new Set());
    origenes.get(fecha).add(origen);
  };
  for (const l of licencias || []) {
    for (const f of fechasEntre(l.fecha_desde.slice(0, 10), l.fecha_hasta.slice(0, 10))) agregar(f, 'licencia');
  }
  for (const f of justificaciones || []) agregar(f.slice(0, 10), 'justificacion');
  if (nuevo) {
    for (const f of fechasEntre(nuevo.desde, nuevo.hasta)) agregar(f, 'nuevo');
  }

  const vigencias = [...(vigenciasModo || [])].sort((a, b) => (a.vigente_desde < b.vigente_desde ? -1 : 1));
  const detalle = [];
  let usados = 0;
  let usadosConNuevo = 0;
  const porMes = {};
  const porMesConNuevo = {};

  for (const fecha of [...origenes.keys()].sort()) {
    const origen = [...origenes.get(fecha)];
    let porQueNo = null;
    if (diasFichados && diasFichados.has(fecha)) {
      porQueNo = 'fichó ese día';
    } else if (resolveModoEnFecha(fecha, vigencias) === 'habiles') {
      const dow = parseLocalDate(fecha).getDay();
      if (dow === 0 || dow === 6) porQueNo = 'fin de semana';
      else if (esFeriado(fecha, feriados)) porQueNo = 'feriado';
    }
    const cuenta = porQueNo === null;
    detalle.push(cuenta ? { fecha, origen, cuenta } : { fecha, origen, cuenta, porQueNo });
    if (!cuenta) continue;

    const mes = fecha.slice(0, 7);
    const yaEstaba = origen.some((o) => o !== 'nuevo');
    if (yaEstaba) {
      usados++;
      porMes[mes] = (porMes[mes] || 0) + 1;
    }
    usadosConNuevo++;
    porMesConNuevo[mes] = (porMesConNuevo[mes] || 0) + 1;
  }
  return { usados, usadosConNuevo, porMes, porMesConNuevo, detalle };
}

/**
 * Compara el consumo contra el cupo. Devuelve los excesos en lenguaje de
 * pantalla, o [] si no se pasa de nada.
 */
//
// Solo cuenta como exceso lo que AGREGA la carga nueva: si un mes ya estaba
// pasado por cargas viejas, eso no frena una carga en otro mes (se ve en el
// estado del empleado, no en esta validacion).
function evaluarCupo(cupo, consumo) {
  if (!cupo) return [];
  const excesos = [];
  if (cupo.max_dias_anio != null
      && consumo.usadosConNuevo > cupo.max_dias_anio
      && consumo.usadosConNuevo > consumo.usados) {
    excesos.push(`supera el tope anual: quedaría en ${consumo.usadosConNuevo} de ${cupo.max_dias_anio}`);
  }
  if (cupo.max_dias_mes != null) {
    for (const [mes, n] of Object.entries(consumo.porMesConNuevo).sort()) {
      if (n > cupo.max_dias_mes && n > (consumo.porMes[mes] || 0)) {
        excesos.push(`supera el tope de ${mes}: quedaría en ${n} de ${cupo.max_dias_mes}`);
      }
    }
  }
  return excesos;
}

module.exports = { periodoAnual, cupoVigente, calcularConsumo, evaluarCupo };
