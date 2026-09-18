// Etapas 7 y 8 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt). Motor de clasificacion: junta
// ScheduleResolver (Etapa 5) + toleranceResolver (Etapa 6) +
// dayTypeRuleResolver (Etapa 8) para transformar HORARIO + FICHAJES +
// CONFIGURACION + AUTORIZACION + TIPO DE DIA en un CalculationResult (aca
// "AttendanceResult", nombre adaptado al vocabulario ya usado en el resto
// del proyecto).
//
// Modulo PURO (sin acceso a DB) -- todavia sin conectar a ningun
// endpoint. Todavia sin convenios (Etapa 9, RuleResolver): dayTypeRules
// se recibe ya resuelto por el llamador (filtrado por tenant/plantilla),
// este modulo no decide CUALES reglas aplican, solo las usa. La
// autorizacion sigue siendo la MISMA que ya existe en el resto del sistema
// (overtimeAuthorizationMode + employees.overtime_authorized), pasada
// como parametro -- este modulo no la resuelve ni la duplica.
//
// Principio explicito del documento fuente: nunca se pierde tiempo
// fichado. Todo intervalo, reconocido o no, queda en classifiedSegments.
// Y: nunca hardcodear "if holiday => 100" -- la tasa siempre sale de
// dayTypeRules (datos), nunca de una condicion en este archivo.
const { evaluateEntranceTolerance, evaluateExitTolerance, resolvePolicyOutcome } = require('./toleranceResolver');
const { resolveOvertimeRate, resolveAllDayRule } = require('./dayTypeRuleResolver');
const { normalizeCheckins } = require('./checkinNormalizer');

// Un segmento (de resolveScheduleSegments) + hasta 2 fichajes (entrada,
// salida) ya emparejados posicionalmente -- mismo criterio que ya usa
// evaluateMultiVisitDay en attendanceCalculations.js (N bloques -> 2N
// marcas alternadas). checkinIn/checkinOut en minutos desde medianoche,
// o null si falta ese fichaje.
function classifySegment({ segment, checkinIn, checkinOut, toleranceConfig, isOvertimeAuthorized, dayType, dayTypeRules }) {
  const appliedRules = [];
  const classifiedSegments = [];
  let normalMinutes = 0;
  let overtimeMinutes = 0;
  let unauthorizedMinutes = 0;
  let workedMinutes = 0;
  const incidents = [];

  // Un segmento que cruza medianoche (22:00-06:00) tiene endMinutes=360
  // en terminos de "minuto del dia", pero los fichajes se esperan en una
  // linea de tiempo CONTINUA desde el inicio del segmento (el llamador es
  // responsable de pasar checkinIn/checkinOut ya en esa misma linea, ej.
  // 06:00 del dia siguiente = 360 + 1440). Sin este ajuste, el fin de un
  // turno nocturno siempre quedaria "antes" que su propio inicio.
  const effectiveEndMinutes = segment.crossesMidnight ? segment.endMinutes + 24 * 60 : segment.endMinutes;

  if (checkinIn == null) {
    incidents.push({ type: 'MISSING_ENTRANCE', segment: segment.name, scheduledStart: segment.startTime });
    return { normalMinutes, overtimeMinutes, unauthorizedMinutes, workedMinutes, incidents, classifiedSegments, appliedRules };
  }

  // --- Entrada: tardanza dentro de tolerancia (informativo, no mueve minutos) ---
  const entranceEval = evaluateEntranceTolerance({
    scheduledStartMinutes: segment.startMinutes,
    actualMinutes: checkinIn,
    toleranceMinutes: toleranceConfig.entradaMinutos
  });
  appliedRules.push({ rule: 'ENTRANCE_TOLERANCE', toleranceMinutes: toleranceConfig.entradaMinutos, result: entranceEval });
  if (entranceEval.isLate) {
    incidents.push({ type: 'LATE_ARRIVAL', segment: segment.name, lateMinutes: entranceEval.lateMinutes });
  }

  // --- Tiempo ANTES del segmento (llegada anticipada) ---
  if (checkinIn < segment.startMinutes) {
    const minutesBefore = segment.startMinutes - checkinIn;
    const outcome = resolvePolicyOutcome(toleranceConfig.politicaLlegadaAnticipada, minutesBefore);
    appliedRules.push({ rule: 'EARLY_ARRIVAL_POLICY', outcome });
    classifiedSegments.push(applyOutcome(outcome, checkinIn, segment.startMinutes, isOvertimeAuthorized, incidents, 'ANTES_DEL_HORARIO', dayType, dayTypeRules, 'BEFORE_SCHEDULE'));
  }

  // --- Dentro del segmento: NORMAL (lo que realmente se solapa con lo programado) ---
  if (checkinOut != null) {
    const overlapStart = Math.max(checkinIn, segment.startMinutes);
    const overlapEnd = Math.min(checkinOut, effectiveEndMinutes);
    if (overlapEnd > overlapStart) {
      normalMinutes += overlapEnd - overlapStart;
      workedMinutes += overlapEnd - overlapStart;
      classifiedSegments.push({ type: 'NORMAL', startMinutes: overlapStart, endMinutes: overlapEnd, minutes: overlapEnd - overlapStart });
    }
  } else {
    incidents.push({ type: 'MISSING_EXIT', segment: segment.name, scheduledEnd: segment.endTime });
  }

  // --- Salida anticipada (dentro de tolerancia, informativo) ---
  if (checkinOut != null && toleranceConfig.salidaAnticipadaMinutos != null) {
    const exitEval = evaluateExitTolerance({
      scheduledEndMinutes: effectiveEndMinutes,
      actualMinutes: checkinOut,
      toleranceMinutes: toleranceConfig.salidaAnticipadaMinutos
    });
    appliedRules.push({ rule: 'EXIT_TOLERANCE', toleranceMinutes: toleranceConfig.salidaAnticipadaMinutos, result: exitEval });
    if (exitEval.isEarly) {
      incidents.push({ type: 'EARLY_DEPARTURE', segment: segment.name, earlyMinutes: exitEval.earlyMinutes });
    }
  }

  // --- Tiempo DESPUES del segmento (salida posterior / exceso de jornada) ---
  if (checkinOut != null && checkinOut > effectiveEndMinutes) {
    const outcome = resolvePolicyOutcome(toleranceConfig.politicaSalidaPosterior, checkinOut - effectiveEndMinutes);
    appliedRules.push({ rule: 'LATE_DEPARTURE_POLICY', outcome });
    classifiedSegments.push(applyOutcome(outcome, effectiveEndMinutes, checkinOut, isOvertimeAuthorized, incidents, 'DESPUES_DEL_HORARIO', dayType, dayTypeRules, 'AFTER_SCHEDULE'));
  }

  // Sumar lo que aporto cada segmento clasificado fuera de NORMAL.
  for (const cs of classifiedSegments) {
    if (cs.type === 'OVERTIME') { overtimeMinutes += cs.minutes; workedMinutes += cs.minutes; }
    else if (cs.type === 'UNAUTHORIZED_OVERTIME') { unauthorizedMinutes += cs.minutes; workedMinutes += cs.minutes; }
    else if (cs.type === 'RECOGNIZED_WORKED_TIME') { workedMinutes += cs.minutes; }
    // NOT_COMPUTED / INFORMATIVE_ONLY: el tiempo queda registrado en
    // classifiedSegments (nunca se pierde el fichaje) pero no suma a
    // ningun contador -- mismo comportamiento que hoy.
  }

  return { normalMinutes, overtimeMinutes, unauthorizedMinutes, workedMinutes, incidents, classifiedSegments, appliedRules };
}

// Traduce el resultado de resolvePolicyOutcome a un segmento clasificado
// concreto, aplicando la autorizacion EXISTENTE solo cuando la politica es
// EXTRA_SI_AUTORIZADO -- las otras 3 politicas no dependen de autorizacion.
// dayType/dayTypeRules/trigger (Etapa 8): si hay una regla configurada
// para este tipo de dia + disparador, agrega la tasa (rate) -- sin regla,
// rate queda en null (identico a como se comporta hoy, sin porcentaje).
function applyOutcome(outcome, startMinutes, endMinutes, isOvertimeAuthorized, incidents, label, dayType, dayTypeRules, trigger) {
  const minutes = endMinutes - startMinutes;
  if (!outcome.recognized) {
    return { type: 'NOT_COMPUTED', startMinutes, endMinutes, minutes, label, policy: outcome.policy };
  }
  if (outcome.category === 'NORMAL') {
    return { type: 'RECOGNIZED_WORKED_TIME', startMinutes, endMinutes, minutes, label, policy: outcome.policy };
  }
  if (outcome.category === 'INFORMATIVE_ONLY') {
    incidents.push({ type: 'REGISTERED_WITHOUT_OVERTIME', label, minutes });
    return { type: 'INFORMATIVE_ONLY', startMinutes, endMinutes, minutes, label, policy: outcome.policy };
  }
  // OVERTIME_CANDIDATE: depende de la autorizacion existente, salvo que la
  // propia regla de dia+disparador diga explicitamente que no la requiere
  // (ej. un feriado que se paga siempre, autorizado o no). El tiempo NUNCA
  // se descarta -- si no esta autorizado (y la regla si la exige), queda
  // como UNAUTHORIZED_OVERTIME (se preserva, se marca como incidencia).
  const rateInfo = resolveOvertimeRate(dayTypeRules, { dayType, trigger });
  const rate = rateInfo && rateInfo.rate != null ? rateInfo.rate : null;
  const classificationType = (rateInfo && rateInfo.classificationType) || 'OVERTIME';
  const authorizationRequired = rateInfo ? rateInfo.requiresAuthorization : true;
  const isAuthorized = !authorizationRequired || isOvertimeAuthorized;

  if (isAuthorized) {
    return { type: 'OVERTIME', startMinutes, endMinutes, minutes, label, policy: outcome.policy, rate, classificationType };
  }
  incidents.push({ type: 'UNAUTHORIZED_OVERTIME', label, minutes });
  return { type: 'UNAUTHORIZED_OVERTIME', startMinutes, endMinutes, minutes, label, policy: outcome.policy, rate, classificationType };
}

// Etapa 8: si hay una regla ALL_DAY configurada para este tipo de dia
// (ej. "trabajar el franco es HE al 100%, siempre"), TODO el tiempo que
// ya se clasifico como trabajado (NORMAL o RECOGNIZED_WORKED_TIME) se
// reevalua bajo esa tasa -- no solo el exceso. Los segmentos que el
// admin marco explicitamente como NOT_COMPUTED/INFORMATIVE_ONLY NO se
// tocan (esa es una decision mas fuerte, no la pisa un default de dia).
function applyAllDayOverride(result, dayTypeRules, dayType, isOvertimeAuthorized) {
  const allDayRule = resolveAllDayRule(dayTypeRules, dayType);
  if (!allDayRule) return result;

  const authorizationRequired = allDayRule.requiresAuthorization;
  const isAuthorized = !authorizationRequired || isOvertimeAuthorized;
  const newType = isAuthorized ? 'OVERTIME' : 'UNAUTHORIZED_OVERTIME';

  let normalMinutes = 0;
  let overtimeMinutes = result.overtimeMinutes;
  let unauthorizedMinutes = result.unauthorizedMinutes;
  const incidents = result.incidents.slice();
  const appliedRules = result.appliedRules.slice();
  appliedRules.push({ rule: 'ALL_DAY_OVERRIDE', dayType, outcome: allDayRule });

  const classifiedSegments = result.classifiedSegments.map((seg) => {
    if (seg.type !== 'NORMAL' && seg.type !== 'RECOGNIZED_WORKED_TIME') return seg;
    if (newType === 'UNAUTHORIZED_OVERTIME') {
      unauthorizedMinutes += seg.minutes;
      incidents.push({ type: 'UNAUTHORIZED_OVERTIME', label: seg.label || 'ALL_DAY', minutes: seg.minutes });
    } else {
      overtimeMinutes += seg.minutes;
    }
    return { ...seg, type: newType, rate: allDayRule.rate, classificationType: allDayRule.classificationType, overriddenBy: 'ALL_DAY_RULE' };
  });

  // workedMinutes no cambia (el tiempo trabajado sigue siendo el mismo,
  // solo cambia SU clasificacion) -- scheduledMinutes tampoco.
  return {
    ...result,
    normalMinutes,
    overtimeMinutes,
    unauthorizedMinutes,
    incidents,
    classifiedSegments,
    appliedRules
  };
}

// segments: resolveScheduleSegments(blocks) (Etapa 5). checkins: array de
// minutos-desde-medianoche de TODOS los fichajes del dia, ya ordenados
// (mismo criterio de emparejamiento posicional 2*N que evaluateMultiVisitDay).
// toleranceConfig: resolveToleranceConfig(template, legacyTolerance) (Etapa 6).
// isOvertimeAuthorized: boolean YA resuelto por el llamador (overtimeAuthorizationMode
// + employees.overtime_authorized) -- este modulo no lo calcula.
// dayType (Etapa 8, default 'WORKDAY') + dayTypeRules (filas de
// day_type_overtime_rules ya filtradas por tenant/convenio/plantilla por
// el llamador): sin dayTypeRules, el comportamiento es identico a la
// Etapa 7 (rate siempre null, ninguna regla ALL_DAY se dispara).
function computeAttendanceResult({ segments, checkins, toleranceConfig, isOvertimeAuthorized, dayType = 'WORKDAY', dayTypeRules = [] }) {
  const sortedSegments = (segments || []).slice().sort((a, b) => a.startMinutes - b.startMinutes);

  const scheduledMinutes = sortedSegments.reduce((sum, s) => sum + s.durationMinutes, 0);

  let workedMinutes = 0;
  let normalMinutes = 0;
  let overtimeMinutes = 0;
  let unauthorizedMinutes = 0;
  const incidents = [];
  const classifiedSegments = [];
  const appliedRules = [];

  if (sortedSegments.length === 0) {
    // Dia sin jornada (franco implicito) -- si igual hay fichajes, se
    // preservan como incidencia, nunca se pierden ni se inventa una
    // clasificacion sin segmento contra el cual compararlos.
    const rawSortedCheckins = (checkins || []).slice().sort((a, b) => a - b);
    if (rawSortedCheckins.length > 0) {
      incidents.push({ type: 'CHECKIN_ON_NON_SCHEDULED_DAY', checkinsCount: rawSortedCheckins.length });
    }
    return { scheduledMinutes: 0, workedMinutes: 0, normalMinutes: 0, overtimeMinutes: 0, unauthorizedMinutes: 0, incidents, classifiedSegments, appliedRules, ruleSetVersion: 1 };
  }

  // Etapa 14 (HALLAZGO #2 de la auditoria): antes de emparejar fichajes
  // por posicion, colapsar duplicados exactos (rebote de reloj) y dejar
  // registrada cualquier marca de mas -- nunca desaparecen en silencio.
  // Ver checkinNormalizer.js.
  const { checkins: sortedCheckins, incidents: normalizationIncidents } = normalizeCheckins(checkins, sortedSegments.length);
  incidents.push(...normalizationIncidents);

  if (sortedCheckins.length === 0) {
    incidents.push({ type: 'NO_CHECKINS' });
    return { scheduledMinutes, workedMinutes: 0, normalMinutes: 0, overtimeMinutes: 0, unauthorizedMinutes: 0, incidents, classifiedSegments, appliedRules, ruleSetVersion: 1 };
  }

  sortedSegments.forEach((segment, i) => {
    const checkinIn = sortedCheckins[i * 2] ?? null;
    const checkinOut = sortedCheckins[i * 2 + 1] ?? null;
    const result = classifySegment({ segment, checkinIn, checkinOut, toleranceConfig, isOvertimeAuthorized, dayType, dayTypeRules });
    workedMinutes += result.workedMinutes;
    normalMinutes += result.normalMinutes;
    overtimeMinutes += result.overtimeMinutes;
    unauthorizedMinutes += result.unauthorizedMinutes;
    incidents.push(...result.incidents);
    classifiedSegments.push(...result.classifiedSegments);
    appliedRules.push(...result.appliedRules);
  });

  const result = {
    scheduledMinutes,
    workedMinutes,
    normalMinutes,
    overtimeMinutes,
    unauthorizedMinutes,
    incidents,
    classifiedSegments: classifiedSegments.sort((a, b) => a.startMinutes - b.startMinutes),
    appliedRules,
    ruleSetVersion: 1
  };

  return applyAllDayOverride(result, dayTypeRules, dayType, isOvertimeAuthorized);
}

module.exports = {
  computeAttendanceResult
};
