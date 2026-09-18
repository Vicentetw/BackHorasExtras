// Etapa 6 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt). Modulo PURO (sin acceso a DB) que
// evalua tolerancias de entrada/salida y las 4 politicas de tiempo antes/
// despues del horario, sin decidir todavia horas extra ni tasas (eso es
// Etapa 7/8, TimeClassifier) y sin tocar ningun endpoint existente.
//
// IMPORTANTE (pedido explicito del documento fuente): una tolerancia NUNCA
// modifica el fichaje real -- estas funciones siempre devuelven
// `actualMinutes` tal cual se recibio, solo agregan una clasificacion al
// lado.
const { timeToMinutes } = require('./attendanceCalculations');

const DEFAULT_POLICY = 'NO_COMPUTAR';
const VALID_POLICIES = ['NO_COMPUTAR', 'TIEMPO_TRABAJADO', 'EXTRA_SI_AUTORIZADO', 'REGISTRAR_SIN_EXTRA'];

// template: fila de work_schedule_templates (o cualquier objeto con las
// mismas 4 columnas). Si una columna es NULL/undefined, se resuelve al
// comportamiento de HOY: tolerancia de entrada -> el hardcode existente de
// resolveToleranceMinutes (10 o 60 segun type); tolerancia de salida
// anticipada -> null (hoy no existe el concepto, ninguna evaluacion se
// dispara); las dos politicas -> NO_COMPUTAR (que es exactamente lo que
// pasa hoy: ese tiempo no se reconoce como nada).
function resolveToleranceConfig(template, legacyEntranceToleranceMinutes) {
  const entradaMinutos = template && template.tolerancia_entrada_minutos != null
    ? Number(template.tolerancia_entrada_minutos)
    : legacyEntranceToleranceMinutes;
  const salidaAnticipadaMinutos = template && template.tolerancia_salida_anticipada_minutos != null
    ? Number(template.tolerancia_salida_anticipada_minutos)
    : null;
  const politicaLlegadaAnticipada = (template && template.politica_llegada_anticipada) || DEFAULT_POLICY;
  const politicaSalidaPosterior = (template && template.politica_salida_posterior) || DEFAULT_POLICY;

  return { entradaMinutos, salidaAnticipadaMinutos, politicaLlegadaAnticipada, politicaSalidaPosterior };
}

// scheduledStartMinutes/actualMinutes en minutos desde medianoche (mismo
// formato que timeToMinutes). toleranceMinutes puede ser null/undefined
// (sin tolerancia configurada -> cualquier minuto de mas ya es tardanza,
// igual que el resto del motor cuando toleranceMinutes=0).
function evaluateEntranceTolerance({ scheduledStartMinutes, actualMinutes, toleranceMinutes }) {
  const tolerance = toleranceMinutes || 0;
  // Misma direccion de comparacion (estrictamente mayor) que ya usa
  // resolveLateJustification en attendanceCalculations.js -- el limite
  // exacto de la tolerancia SIGUE contando como a tiempo, no tarde.
  const isLate = actualMinutes > scheduledStartMinutes + tolerance;
  return {
    actualMinutes,
    scheduledMinutes: scheduledStartMinutes,
    isLate,
    lateMinutes: isLate ? actualMinutes - scheduledStartMinutes : 0,
    withinTolerance: !isLate
  };
}

// Simetrico a evaluateEntranceTolerance, para la salida. El limite exacto
// de la tolerancia cuenta como a horario (no anticipada), mismo criterio
// "el borde es a favor del empleado" que ya usa el resto del motor.
function evaluateExitTolerance({ scheduledEndMinutes, actualMinutes, toleranceMinutes }) {
  const tolerance = toleranceMinutes || 0;
  const isEarly = actualMinutes < scheduledEndMinutes - tolerance;
  return {
    actualMinutes,
    scheduledMinutes: scheduledEndMinutes,
    isEarly,
    earlyMinutes: isEarly ? scheduledEndMinutes - actualMinutes : 0,
    withinTolerance: !isEarly
  };
}

// Traduce una politica configurada a una etiqueta simple -- NO calcula
// minutos de HE ni tasas todavia (eso llega en la Etapa 7/8, una vez que
// exista TimeClassifier). `minutesOutside` es solo informativo aca.
function resolvePolicyOutcome(policy, minutesOutside) {
  const normalized = VALID_POLICIES.includes(policy) ? policy : DEFAULT_POLICY;
  switch (normalized) {
    case 'TIEMPO_TRABAJADO':
      return { policy: normalized, recognized: true, category: 'NORMAL', minutesOutside };
    case 'EXTRA_SI_AUTORIZADO':
      return { policy: normalized, recognized: true, category: 'OVERTIME_CANDIDATE', minutesOutside };
    case 'REGISTRAR_SIN_EXTRA':
      return { policy: normalized, recognized: true, category: 'INFORMATIVE_ONLY', minutesOutside };
    case 'NO_COMPUTAR':
    default:
      // Comportamiento de HOY: el tiempo se ficha (nunca se pierde el
      // dato), pero no se reconoce como nada -- ni normal, ni HE, ni
      // incidencia.
      return { policy: normalized, recognized: false, category: null, minutesOutside };
  }
}

module.exports = {
  resolveToleranceConfig,
  evaluateEntranceTolerance,
  evaluateExitTolerance,
  resolvePolicyOutcome,
  VALID_POLICIES
};
