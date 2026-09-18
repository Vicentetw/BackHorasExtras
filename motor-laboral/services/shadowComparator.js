// Etapa 12 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt). Modo de comparacion/sombra: para
// los MISMOS datos, correr Legacy (ya calculado por /attendance-range) y
// el motor nuevo (timeClassifier.computeAttendanceResult) y generar
// diferencias, SIN cambiar el resultado oficial. Modulo PURO -- no decide
// si corre o no (eso lo decide el llamador segun rules_engine_mode), no
// hace queries, no persiste nada.
//
// Legacy no modela "tiempo normal"/"tiempo trabajado" como campos propios
// (confirmado en la Etapa 1, auditoria) -- buildLegacyComparable() los
// deriva a partir de las mismas variables que /attendance-range ya usa
// para su resultado OFICIAL (que no cambia en nada). Estos valores
// derivados existen solo para poder comparar, nunca se devuelven como el
// resultado oficial de ningun dia.
const { timeToMinutes } = require('./attendanceCalculations');

const DIFF_TYPES = ['EXPECTED', 'NEW_FEATURE', 'UNEXPECTED', 'POSSIBLE_REGRESSION'];
const NUMERIC_FIELDS = ['workedMinutes', 'normalMinutes', 'overtimeMinutes'];

function extractMinutesFromDatetime(datetimeStr) {
  const part = datetimeStr && datetimeStr.split(' ')[1];
  return part ? timeToMinutes(part.substring(0, 5)) : null;
}

// firstMinutes/lastMinutes: primer/ultimo fichaje del dia, en minutos
// desde medianoche (mismo dato que ya calcula /attendance-range).
// overtimeMinutes: SOLO la deteccion automatica (heuristico/marcador),
// sin sumar HE manual -- el motor nuevo no conoce ManualEntries (es una
// carga humana explicita, fuera del alcance de esta comparacion).
// visits: multiVisit.visits si el dia es de turno partido (evaluateMultiVisitDay),
// null en el caso normal.
function buildLegacyComparable({ firstMinutes, lastMinutes, isLate, lateMinutes, isPartialAbsence, overtimeMinutes, visits }) {
  let workedMinutes;
  if (Array.isArray(visits) && visits.length > 0) {
    workedMinutes = visits.reduce((sum, v) => {
      const inMin = extractMinutesFromDatetime(v.entrada);
      const outMin = extractMinutesFromDatetime(v.salida);
      if (inMin == null || outMin == null) return sum;
      return sum + Math.max(0, outMin - inMin);
    }, 0);
  } else {
    workedMinutes = Math.max(0, (lastMinutes ?? 0) - (firstMinutes ?? 0));
  }
  const normalMinutes = Math.max(0, workedMinutes - overtimeMinutes);
  const incidents = [];
  if (isLate) incidents.push({ type: 'LATE_ARRIVAL', lateMinutes });
  if (isPartialAbsence) incidents.push({ type: 'PARTIAL_ABSENCE' });
  const classification = isPartialAbsence ? 'PartialAbsence' : (isLate ? 'Late' : 'OnTime');

  return { workedMinutes, normalMinutes, overtimeMinutes, incidents, classification };
}

// Equivalente de "classification" del lado del motor nuevo -- el motor no
// tiene un status de dia propio (solo incidents + classifiedSegments), se
// deriva aca solo para poder comparar contra el status que si expone Legacy.
function deriveEngineClassification(engineResult) {
  const incidents = engineResult.incidents || [];
  if (incidents.some((i) => i.type === 'MISSING_ENTRANCE' || i.type === 'MISSING_EXIT')) return 'PartialAbsence';
  if (incidents.some((i) => i.type === 'LATE_ARRIVAL')) return 'Late';
  return 'OnTime';
}

function incidentTypesOf(incidents) {
  return new Set((incidents || []).map((i) => i.type));
}

// Sin configuracion nueva cargada (hasCustomConfig=false), Legacy y el
// motor nuevo deberian coincidir siempre -- cualquier diferencia ahi es
// sospechosa. Una diferencia en un campo NUMERICO (los que ya forman el
// resultado oficial hoy) es mas grave que una en un campo informativo
// (incidents/classifications, que Legacy ni siquiera expone hoy como tal).
function classifyDiff(field, hasCustomConfig) {
  if (hasCustomConfig) return 'NEW_FEATURE';
  return NUMERIC_FIELDS.includes(field) ? 'POSSIBLE_REGRESSION' : 'UNEXPECTED';
}

// legacy: buildLegacyComparable(...). engine: computeAttendanceResult(...).
// hasCustomConfig: true si esta plantilla/dia tiene tolerancias o reglas
// de tipo de dia configuradas explicitamente (entonces una diferencia es
// SPERADA -- es la nueva funcionalidad haciendo lo que se le pidio, no un
// bug). Devuelve la lista de diferencias encontradas (vacia si coinciden).
function compareAttendanceResults({ legacy, engine, hasCustomConfig }) {
  const diffs = [];

  for (const field of NUMERIC_FIELDS) {
    if (legacy[field] !== engine[field]) {
      diffs.push({ field, legacyValue: legacy[field], newValue: engine[field], diffType: classifyDiff(field, hasCustomConfig) });
    }
  }

  const legacyIncidentTypes = incidentTypesOf(legacy.incidents);
  const engineIncidentTypes = incidentTypesOf(engine.incidents);
  const incidentsMatch = legacyIncidentTypes.size === engineIncidentTypes.size
    && [...legacyIncidentTypes].every((t) => engineIncidentTypes.has(t));
  if (!incidentsMatch) {
    diffs.push({
      field: 'incidents',
      legacyValue: [...legacyIncidentTypes],
      newValue: [...engineIncidentTypes],
      diffType: classifyDiff('incidents', hasCustomConfig)
    });
  }

  const engineClassification = deriveEngineClassification(engine);
  if (legacy.classification !== engineClassification) {
    diffs.push({
      field: 'classifications',
      legacyValue: legacy.classification,
      newValue: engineClassification,
      diffType: classifyDiff('classifications', hasCustomConfig)
    });
  }

  return diffs;
}

module.exports = {
  DIFF_TYPES,
  buildLegacyComparable,
  deriveEngineClassification,
  compareAttendanceResults
};
