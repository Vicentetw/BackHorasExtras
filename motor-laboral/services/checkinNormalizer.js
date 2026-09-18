// Etapa 14 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt) -- corrige el HALLAZGO #2 de la
// auditoria: el emparejamiento posicional de timeClassifier.js tomaba
// ciegamente los primeros 2 fichajes por segmento, perdiendo en SILENCIO
// marcas duplicadas (rebote de reloj) o de mas (mas visitas de las que la
// plantilla espera). Esto es dinero real (horas trabajadas) -- nunca debe
// perderse sin que quede una incidencia que lo delate.
//
// Modulo PURO. checkins: array de minutos-desde-medianoche (mismo formato
// que ya usa computeAttendanceResult). expectedPairs: cantidad de
// segmentos resueltos (cada uno espera 2 marcas, entrada+salida).
//
// Dos correcciones, cada una con su propia incidencia (nunca silenciosa):
// 1. Duplicados EXACTOS (mismo minuto -- un rebote de reloj biometrico ya
//    llega redondeado al mismo minuto en la enorme mayoria de los casos
//    reales) se colapsan a una sola marca -- esto ARREGLA el calculo
//    (antes: la marca duplicada se leia como si fuera la salida real,
//    truncando el dia a minutos=0; ahora: se ignora el duplicado y se usa
//    la marca real siguiente).
// 2. Marcas DE MAS (mas de 2*expectedPairs, incluso despues de sacar
//    duplicados) no se pueden reasignar de forma segura -- adivinar a que
//    corresponden seria peor que no saberlo (mismo principio que ya sigue
//    el resto del motor: "nunca hardcodear una decision sin datos"). Se
//    deja el emparejamiento posicional tal cual sobre las primeras
//    2*expectedPairs (comportamiento sin cambios para ese tramo) pero se
//    agrega una incidencia EXPLICITA listando las marcas sobrantes, para
//    que un admin las revise -- ya no desaparecen sin dejar rastro.
function normalizeCheckins(checkins, expectedPairs) {
  const incidents = [];
  const sorted = (checkins || []).slice().sort((a, b) => a - b);

  const deduped = [];
  for (const minutes of sorted) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined && minutes === previous) {
      incidents.push({ type: 'DUPLICATE_CHECKIN_IGNORED', minutes });
      continue;
    }
    deduped.push(minutes);
  }

  const expectedCount = Math.max(0, expectedPairs) * 2;
  if (deduped.length > expectedCount) {
    incidents.push({
      type: 'UNEXPECTED_EXTRA_CHECKINS',
      expectedCount,
      actualCount: deduped.length,
      extra: deduped.slice(expectedCount)
    });
  }

  return { checkins: deduped, incidents };
}

module.exports = { normalizeCheckins };
