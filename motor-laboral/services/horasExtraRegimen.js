// ============================================================================
// Horas extra segun el REGIMEN de la persona -- calculo PURO (bloque B2)
// ============================================================================
//
// Diseño completo: HORAS_EXTRA_REGIMENES.md (raiz del repo). Resumen:
//
//   plantilla = CUANDO se trabaja (jornada, descansos, ventana de HE)
//   regimen   = COMO se computa y se paga lo que excede la jornada
//
// Este modulo no lee la base: recibe los datos ya resueltos y devuelve el
// resultado con el detalle de POR QUE. Asi las reglas de RRHH, que son las
// que definen plata, se prueban a fondo sin fixtures
// (test/horas-extra-regimen.test.js).
//
// Las piezas, en el orden en que se aplican:
//   1. recortarPorPlantilla  -- saca jornada y descansos, respeta la ventana
//   2. aplicarMinimoYRedondeo
//   3. clasificarPorTipoDeDia -- EXTRA (con recargo) / REGISTRAR / NO_COMPUTAR
//   4. aplicarTopesDelPeriodo -- topes dia/mes/año, en orden cronologico, y la
//      politica de excedente
//
// Todo en MINUTOS desde medianoche del dia (un intervalo que pasa medianoche
// llega con fin > 1440; lo resuelve el llamador).

// ---------------------------------------------------------------------------
// 1. Recorte por la plantilla
// ---------------------------------------------------------------------------

/**
 * Del intervalo trabajado fuera de la jornada, que parte es hora extra
 * posible segun la plantilla: nunca la jornada, nunca un descanso, y solo
 * desde la hora en que "cuentan las horas extra" y dentro de la ventana de
 * horas extra si la plantilla la define.
 *
 * @param {{inicio:number, fin:number}} intervalo  minutos del dia
 * @param {object} plantilla
 * @param {{desde:number, hasta:number, tipo:'WORK'|'BREAK'|'OVERTIME'}[]} plantilla.bloques
 * @param {number|null} [plantilla.cuentanDesde]  "Corte HE" cargado (minutos)
 * @returns {{minutos:number, tramos:{desde:number,hasta:number}[], recortes:{motivo:string, minutos:number}[]}}
 */
function recortarPorPlantilla(intervalo, { bloques = [], cuentanDesde = null } = {}) {
  let tramos = intervalo.fin > intervalo.inicio ? [{ desde: intervalo.inicio, hasta: intervalo.fin }] : [];
  const recortes = [];

  const quitar = (desde, hasta, motivo) => {
    let quitado = 0;
    const nuevos = [];
    for (const t of tramos) {
      const a = Math.max(t.desde, desde);
      const b = Math.min(t.hasta, hasta);
      if (b <= a) { nuevos.push(t); continue; }
      quitado += b - a;
      if (t.desde < a) nuevos.push({ desde: t.desde, hasta: a });
      if (b < t.hasta) nuevos.push({ desde: b, hasta: t.hasta });
    }
    tramos = nuevos;
    if (quitado > 0) recortes.push({ motivo, minutos: quitado });
  };

  for (const b of bloques.filter((x) => x.tipo === 'WORK')) quitar(b.desde, b.hasta, 'dentro de la jornada');
  for (const b of bloques.filter((x) => x.tipo === 'BREAK')) quitar(b.desde, b.hasta, 'dentro del descanso');
  if (cuentanDesde != null) quitar(0, cuentanDesde, 'antes del corte de horas extra');

  const ventanas = bloques.filter((x) => x.tipo === 'OVERTIME');
  if (ventanas.length) {
    // Fuera de toda ventana de HE: se recorta lo que no cae en ninguna.
    const orden = [...ventanas].sort((a, b) => a.desde - b.desde);
    let cursor = 0;
    for (const v of orden) {
      if (v.desde > cursor) quitar(cursor, v.desde, 'fuera de la ventana de horas extra');
      cursor = Math.max(cursor, v.hasta);
    }
    quitar(cursor, 48 * 60, 'fuera de la ventana de horas extra');
  }

  tramos.sort((a, b) => a.desde - b.desde);
  const minutos = tramos.reduce((s, t) => s + (t.hasta - t.desde), 0);
  return { minutos, tramos, recortes };
}

// ---------------------------------------------------------------------------
// 2. Minimo y redondeo
// ---------------------------------------------------------------------------

/**
 * @param {number} minutos
 * @param {{minimo?:number|null, redondeo?:number|null, modo?:'ABAJO'|'CERCANO'|'ARRIBA'}} reglas
 * @returns {{minutos:number, motivo:string|null}}
 */
function aplicarMinimoYRedondeo(minutos, { minimo = null, redondeo = null, modo = 'ABAJO' } = {}) {
  if (minutos <= 0) return { minutos: 0, motivo: null };
  if (minimo != null && minutos < minimo) {
    return { minutos: 0, motivo: `menos del mínimo de ${minimo} min` };
  }
  if (redondeo != null && redondeo > 1) {
    const f = modo === 'ARRIBA' ? Math.ceil : modo === 'CERCANO' ? Math.round : Math.floor;
    const r = f(minutos / redondeo) * redondeo;
    return { minutos: r, motivo: r !== minutos ? `redondeado a ${redondeo} min (${minutos} → ${r})` : null };
  }
  return { minutos, motivo: null };
}

// ---------------------------------------------------------------------------
// 3. Clasificacion por tipo de dia
// ---------------------------------------------------------------------------

// Clases que se guardan en day_type_overtime_rules.classification_type.
// 'OVERTIME' es el valor historico de esa tabla: se toma como 'EXTRA'.
const CLASES = ['EXTRA', 'EXTRA_SI_AUTORIZADO', 'REGISTRAR', 'NO_COMPUTAR'];

/**
 * Que es el tiempo fuera de horario de ese tipo de dia para ESTE regimen.
 *
 * @param {string} tipoDeDia  WORKDAY | SATURDAY | SUNDAY | REST_DAY | HOLIDAY
 * @param {{day_type:string, classification_type:string, rate:number|null}[]} reglas del regimen
 * @param {{autorizado:boolean, claseSinRegla?:string}} opciones
 *   claseSinRegla: que hacer si el regimen no dice nada de ese tipo de dia
 *   (default 'EXTRA' sin recargo: el comportamiento de siempre).
 * @returns {{clase:'EXTRA'|'REGISTRAR'|'NO_COMPUTAR', recargo:number|null, motivo:string|null}}
 */
function clasificarPorTipoDeDia(tipoDeDia, reglas, { autorizado = true, claseSinRegla = 'EXTRA' } = {}) {
  const regla = (reglas || []).find((r) => r.day_type === tipoDeDia);
  let clase = regla ? String(regla.classification_type || 'EXTRA').toUpperCase() : claseSinRegla;
  if (clase === 'OVERTIME') clase = 'EXTRA';
  if (!CLASES.includes(clase)) clase = 'EXTRA';
  const recargo = regla && regla.rate != null ? Number(regla.rate) : null;

  if (clase === 'EXTRA_SI_AUTORIZADO') {
    return autorizado
      ? { clase: 'EXTRA', recargo, motivo: null }
      : { clase: 'REGISTRAR', recargo: null, motivo: 'no está autorizado a hacer horas extra: se registra sin pagar' };
  }
  if (clase === 'REGISTRAR') return { clase, recargo: null, motivo: 'su régimen no paga este tiempo: se registra (horas de dedicación)' };
  if (clase === 'NO_COMPUTAR') return { clase, recargo: null, motivo: 'su régimen no computa este tiempo' };
  return { clase: 'EXTRA', recargo, motivo: null };
}

// ---------------------------------------------------------------------------
// 4. Topes y politica de excedente
// ---------------------------------------------------------------------------

const POLITICAS = ['TAL_CUAL', 'AVISAR', 'NO_COMPUTAR', 'AUTORIZAR'];

/**
 * Topes que valen para una persona: si tiene una autorizacion individual, esa
 * REEMPLAZA a la del regimen (una autorizacion existe justamente para dar mas
 * o menos horas que el regimen, ej. "Chineli: hasta 60 h/mes"). Cada tope por
 * separado: la autorizacion puede cambiar solo el mensual y dejar el diario.
 */
function resolverTopes(regimen, autorizacion) {
  const de = (clave) => {
    if (autorizacion && autorizacion[clave] != null) return autorizacion[clave];
    return regimen ? regimen[clave] ?? null : null;
  };
  return { dia: de('dia'), mes: de('mes'), anio: de('anio') };
}

/**
 * Reparte las horas EXTRA de un periodo entre computables y excedente,
 * respetando los topes EN ORDEN CRONOLOGICO: las primeras horas del periodo
 * son computables y lo que pasa el tope es excedente. Asi queda definido que
 * horas son al 50 % y cuales al 100 % (las de un domingo al final del mes
 * pueden quedar como excedente aunque el martes anterior no).
 *
 * El tope diario se aplica primero, dia por dia; despues el mensual y el
 * anual acumulados.
 *
 * @param {{fecha:string, minutos:number, recargo:number|null}[]} dias  solo clase EXTRA
 * @param {{dia:number|null, mes:number|null, anio:number|null}} topes  en minutos
 * @param {object} opciones
 * @param {string} opciones.politica  TAL_CUAL | AVISAR | NO_COMPUTAR | AUTORIZAR
 * @param {number} [opciones.yaComputadoEnElAnio]  minutos computables de meses anteriores del mismo año
 * @param {number} [opciones.aprobados]  minutos de excedente aprobados a mano en este periodo
 */
function aplicarTopesDelPeriodo(dias, topes, { politica = 'AVISAR', yaComputadoEnElAnio = 0, aprobados = 0 } = {}) {
  if (!POLITICAS.includes(politica)) politica = 'AVISAR';
  const ordenados = [...dias].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  let acumMes = 0;
  let acumAnio = yaComputadoEnElAnio;
  let aprobadosRestantes = aprobados;
  const detalle = [];

  for (const d of ordenados) {
    let dentro = d.minutos;
    const motivos = [];
    if (topes.dia != null && dentro > topes.dia) { dentro = topes.dia; motivos.push('tope diario'); }
    if (topes.mes != null) {
      const cabe = Math.max(0, topes.mes - acumMes);
      if (dentro > cabe) { dentro = cabe; motivos.push('tope mensual'); }
    }
    if (topes.anio != null) {
      const cabe = Math.max(0, topes.anio - acumAnio);
      if (dentro > cabe) { dentro = cabe; motivos.push('tope anual'); }
    }
    const excede = d.minutos - dentro;
    acumMes += dentro;
    acumAnio += dentro;

    let computables = dentro;
    let excedente = excede;
    let pendiente = 0;
    if (excede > 0) {
      if (politica === 'TAL_CUAL' || politica === 'AVISAR') {
        computables = d.minutos; // se computa todo; AVISAR ademas lo marca
        excedente = politica === 'AVISAR' ? excede : 0;
      } else if (politica === 'AUTORIZAR') {
        const usa = Math.min(aprobadosRestantes, excede);
        aprobadosRestantes -= usa;
        computables = dentro + usa;
        pendiente = excede - usa;
        excedente = excede;
      }
      // NO_COMPUTAR: computables = dentro, excedente queda registrado.
    }
    detalle.push({ fecha: d.fecha, recargo: d.recargo, minutos: d.minutos, computables, excedente, pendiente, motivos });
  }

  const suma = (k) => detalle.reduce((s, x) => s + x[k], 0);
  const porRecargo = {};
  for (const x of detalle) {
    const clave = x.recargo == null ? 'sin recargo' : `${x.recargo}%`;
    porRecargo[clave] = (porRecargo[clave] || 0) + x.computables;
  }
  return {
    politica,
    reales: suma('minutos'),
    computables: suma('computables'),
    excedente: suma('excedente'),
    pendiente: suma('pendiente'),
    porRecargo,
    aviso: suma('excedente') > 0 && politica !== 'TAL_CUAL',
    detalle,
  };
}

module.exports = {
  recortarPorPlantilla,
  aplicarMinimoYRedondeo,
  clasificarPorTipoDeDia,
  resolverTopes,
  aplicarTopesDelPeriodo,
  CLASES,
  POLITICAS,
};
