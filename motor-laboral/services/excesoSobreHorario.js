// ============================================================================
// Horas extra = lo que supera el horario de la plantilla (2026-10-17)
// ============================================================================
//
// POR QUE
// -------
// La mayoría de las empresas no usa las teclas del reloj (9/10) para avisar
// que empiezan horas extra; muchos relojes (los de rostro) ni siquiera las
// tienen. Para ellas, hora extra es el tiempo trabajado DESPUÉS de su horario
// (y, si la empresa lo decide, el de ANTES de la entrada).
//
// El motor de reglas viejo (timeClassifier) ya hacía esto, pero emparejaba
// los fichajes por posición: un fichaje de más (almuerzo en un horario
// corrido, una salida particular, un rebote del reloj a 1 minuto) desordenaba
// el día y perdía las horas extra. Medido el 2026-10-17: fallaba en 5 de 12
// casos típicos. Este cálculo no depende de cuántos fichajes haya:
//
//   1. Junta los fichajes repetidos (dos lecturas a menos de N minutos = una).
//   2. Si quedan en número PAR, arma los tramos entrada-salida y cuenta solo
//      la parte de cada tramo que cae después del horario (o antes, si cuenta
//      llegar antes). Un almuerzo o una salida en el medio no afectan.
//   3. Si quedan en número IMPAR, falta un fichaje y no se sabe con certeza
//      qué tramo es cuál: se toma el último fichaje contra el fin del horario
//      y el día queda "a revisar" (aparece en Días a revisar).
//   4. Con un solo fichaje no hay forma de saber cuánto trabajó: no suma.
//   5. Si trabajó TODO el día fuera de su horario (ej. horario de 7 a 14 y
//      fichó de 15 a 23), casi siempre es un horario mal asignado o un cambio
//      de turno, no 8 horas extra: cuenta, pero el día queda "a revisar" con
//      ese motivo (caso real en la copia local, 2026-10-17).
//
// Módulo PURO (sin base). Todo en minutos desde la medianoche del día de la
// jornada, en una línea continua: las 08:00 del día siguiente son 1920.

const VENTANA_REPETIDO_MINUTOS = 3;

function hhmmAMinutos(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
}

// Tramos de trabajo de la plantilla ese día, en la línea continua.
function tramosDelHorario(blocks) {
  return (blocks || [])
    .filter((b) => b.block_type === 'WORK' && (b.active === undefined || b.active === null || Number(b.active) === 1))
    .map((b) => {
      const desde = hhmmAMinutos(b.start_time);
      let hasta = hhmmAMinutos(b.end_time);
      if (Number(b.crosses_midnight) === 1 || hasta <= desde) hasta += 24 * 60;
      return { desde, hasta };
    })
    .sort((a, b) => a.desde - b.desde);
}

function solape(a, b, desde, hasta) {
  return Math.max(0, Math.min(b, hasta) - Math.max(a, desde));
}

/**
 * @param {object} p
 * @param {number[]} p.fichajes  minutos en la línea continua del día (sin ordenar está bien)
 * @param {object[]} p.blocks    shift_blocks del día (los de la plantilla)
 * @param {string|null} [p.corte]  "Corte HE" de la plantilla (HH:MM). Vacío = fin del horario.
 * @param {boolean} [p.contarLlegadaAnticipada]
 * @param {number} [p.ventanaRepetidoMinutos]
 * @returns {null | {minutos:number, minutosDespues:number, minutosAntes:number,
 *   desde:number, hasta:number, tramos:{desde:number,hasta:number}[],
 *   aRevisar:boolean, fueraDeHorario:boolean, repetidosIgnorados:number}}
 *   null = el día no tiene horario o no hay tiempo fuera de él.
 */
function calcular({ fichajes, blocks, corte = null, contarLlegadaAnticipada = false, ventanaRepetidoMinutos = VENTANA_REPETIDO_MINUTOS }) {
  const horario = tramosDelHorario(blocks);
  if (!horario.length) return null;
  const inicioHorario = horario[0].desde;
  const finHorario = horario[horario.length - 1].hasta;

  // Desde dónde cuentan las horas extra: el corte cargado o el fin del horario.
  // Turno noche: un corte anterior a la entrada es del día siguiente.
  let cuentanDesde = finHorario;
  const corteMin = hhmmAMinutos(corte);
  if (corteMin != null) cuentanDesde = corteMin <= inicioHorario && finHorario > 24 * 60 ? corteMin + 24 * 60 : corteMin;

  const ordenados = (fichajes || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  const limpios = [];
  let repetidosIgnorados = 0;
  for (const f of ordenados) {
    if (limpios.length && f - limpios[limpios.length - 1] < ventanaRepetidoMinutos) { repetidosIgnorados++; continue; }
    limpios.push(f);
  }
  if (limpios.length < 2) return null;

  const tramos = [];
  const agregar = (a, b) => { if (b > a) tramos.push({ desde: a, hasta: b }); };
  let aRevisar = false;
  if (limpios.length % 2 === 0) {
    for (let i = 0; i < limpios.length; i += 2) {
      const [a, b] = [limpios[i], limpios[i + 1]];
      agregar(Math.max(a, cuentanDesde), b);
      if (contarLlegadaAnticipada) agregar(a, Math.min(b, inicioHorario));
    }
  } else {
    // Falta un fichaje: se mide contra el primero y el último.
    aRevisar = true;
    agregar(Math.max(limpios[0], cuentanDesde), limpios[limpios.length - 1]);
    if (contarLlegadaAnticipada) agregar(limpios[0], Math.min(limpios[limpios.length - 1], inicioHorario));
  }
  tramos.sort((a, b) => a.desde - b.desde);
  // ¿Estuvo en algún momento dentro de su horario? (entre el primer y el último fichaje)
  const tocaElHorario = horario.some((s) => solape(limpios[0], limpios[limpios.length - 1], s.desde, s.hasta) > 0);
  const fueraDeHorario = !tocaElHorario;
  if (fueraDeHorario) aRevisar = true;
  const minutosAntes = tramos.reduce((s, t) => s + solape(t.desde, t.hasta, -Infinity, inicioHorario), 0);
  const minutos = tramos.reduce((s, t) => s + (t.hasta - t.desde), 0);
  if (minutos <= 0) return null;
  return {
    minutos,
    minutosDespues: minutos - minutosAntes,
    minutosAntes,
    desde: tramos[0].desde,
    hasta: tramos[tramos.length - 1].hasta,
    tramos,
    aRevisar,
    fueraDeHorario,
    repetidosIgnorados,
  };
}

module.exports = { calcular, tramosDelHorario, VENTANA_REPETIDO_MINUTOS };
