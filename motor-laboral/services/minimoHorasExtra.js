// ============================================================================
// Mínimo de horas extra por día (R4, 2026-10-17)
// ============================================================================
//
// POR QUE
// -------
// Medido en AVP (septiembre): de 9.489 días con horas extra, 735 tenían 10
// minutos o menos y el 96 % eran ESTIMADAS ("se fue unos minutos después del
// corte"). Cada empresa decide desde cuántos minutos un día cuenta como hora
// extra. Pedido del dueño: por empresa y que un convenio pueda tener el suyo,
// vacío = como hoy, y que NUNCA se esconda el tiempo trabajado.
//
// CÓMO SE APLICA (una sola verdad)
// --------------------------------
// - Cálculo de siempre (Presentismo, Horas Extra por Régimen, portal,
//   liquidación sin convenio): si las horas extra AUTOMÁTICAS de un día son
//   menos que el mínimo, ese día no suma; el detalle lo muestra ("8 min,
//   menos del mínimo de 10"). Las cargas manuales no se tocan: son una
//   decisión explícita de una persona.
// - Quien tiene máximos de horas extra (cálculo por régimen): si su convenio
//   o régimen tiene su propio "Mínimo", vale ese; si no, el de la empresa.
//
// Se guarda en app_settings ('overtimeMinimumMinutes'), por empresa. Vacío o
// sin cargar = sin mínimo (comportamiento de siempre).
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');

const CLAVE = 'overtimeMinimumMinutes';
const MAXIMO_PERMITIDO = 240;

function normalizar(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 && n <= MAXIMO_PERMITIDO ? n : null;
}

async function leer(db, tenantId) {
  if (tenantId === null || tenantId === undefined) return null;
  return normalizar(await getAppSetting(CLAVE, tenantId, db));
}

/** @param {number|null} minutos  null o '' = sin mínimo */
async function guardar(db, tenantId, minutos) {
  await setAppSetting(CLAVE, tenantId, minutos == null ? '' : String(minutos), db);
}

/**
 * Pura. Minutos automáticos de un día -> lo que cuenta y lo que quedó afuera.
 * @returns {{minutos:number, bajoMinimo:number}}
 */
function aplicar(minutos, minimo) {
  if (!minimo || !(minutos > 0) || minutos >= minimo) return { minutos: minutos || 0, bajoMinimo: 0 };
  return { minutos: 0, bajoMinimo: minutos };
}

module.exports = { CLAVE, MAXIMO_PERMITIDO, normalizar, leer, guardar, aplicar };
