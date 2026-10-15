// ============================================================================
// Límites de llegadas tarde y salidas particulares (2026-10-15)
// ============================================================================
//
// UN SOLO LUGAR. Antes había dos límites parecidos en dos pantallas distintas
// ("Límite de licencia personal" en Configuración General y el tope de
// Salidas), y ninguno decía qué sumaba. El dueño cargó los dos porque no
// sabía cuál era. Ahora los tres conceptos se configuran juntos, en
// Administración → "Llegadas tarde y salidas", y cada número que los muestra
// (Presentismo, Salidas, portal) lleva a esa pantalla.
//
// TRES CONCEPTOS DISTINTOS (no son lo mismo):
//   1. tardanzas:             llegadas tarde SIN justificar.
//   2. tardanzasJustificadas: llegadas tarde justificadas (con un motivo,
//                             ej. "Salida particular"). Era la "licencia
//                             personal" de Configuración General.
//   3. salidasParticulares:   salidas en horario con el marcador particular
//                             (pantalla Salidas).
//
// CADA UNO SE PUEDE LIMITAR POR CANTIDAD Y/O POR TIEMPO, los dos opcionales
// (0 o vacío = sin límite). Así lo hacen los sistemas de control horario: la
// cantidad suele decidir cosas como el premio por presentismo; el tiempo, la
// bolsa de horas o un descuento. Hoy el límite solo AVISA (marca "excedido").
//
// PERÍODO: por mes. En un rango de varios meses, el límite se multiplica por
// la cantidad de meses del rango (igual que ya hacía Presentismo).
//
// COMPATIBLE CON LO ANTERIOR: los dos límites de tiempo que ya existían usan
// las MISMAS claves de app_settings que antes. Ninguna empresa pierde lo que
// tenía cargado ni ve un número distinto.
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');

const CONCEPTOS = {
  tardanzas: { cantidad: 'lateUnjustifiedMonthlyMaxCount', minutos: 'lateUnjustifiedMonthlyMaxMinutes' },
  tardanzasJustificadas: { cantidad: 'lateJustifiedMonthlyMaxCount', minutos: 'personalLeaveMonthlyLimitMinutes' },
  salidasParticulares: { cantidad: 'particularExitMonthlyMaxCount', minutos: 'particularExitMonthlyLimitMinutes' },
};
const MAXIMO_RAZONABLE = { cantidad: 1000, minutos: 100000 };

const numero = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/** Los límites MENSUALES de la empresa: { tardanzas: {cantidad, minutos}, ... } (0 = sin límite). */
async function leerLimites(db, tenantId) {
  const out = {};
  for (const [concepto, claves] of Object.entries(CONCEPTOS)) {
    out[concepto] = {
      cantidad: Math.round(numero(await getAppSetting(claves.cantidad, tenantId, db))),
      minutos: Math.round(numero(await getAppSetting(claves.minutos, tenantId, db))),
    };
  }
  return out;
}

/** Valida y guarda. Acepta un subconjunto: lo que no viene, no se toca. */
async function guardarLimites(db, tenantId, cuerpo) {
  const cambios = [];
  for (const [concepto, valores] of Object.entries(cuerpo || {})) {
    const claves = CONCEPTOS[concepto];
    if (!claves) throw Object.assign(new Error(`Concepto desconocido: ${concepto}`), { status: 400 });
    for (const medida of ['cantidad', 'minutos']) {
      if (!valores || valores[medida] === undefined) continue;
      const v = valores[medida] === null || valores[medida] === '' ? 0 : Number(valores[medida]);
      if (!Number.isFinite(v) || v < 0 || v > MAXIMO_RAZONABLE[medida] || (medida === 'cantidad' && !Number.isInteger(v))) {
        throw Object.assign(new Error(`Valor inválido en ${concepto}.${medida}: tiene que ser un número entre 0 y ${MAXIMO_RAZONABLE[medida]}${medida === 'cantidad' ? ', entero' : ''}.`), { status: 400 });
      }
      cambios.push([claves[medida], String(Math.round(v))]);
    }
  }
  for (const [clave, valor] of cambios) await setAppSetting(clave, tenantId, valor, db);
  return leerLimites(db, tenantId);
}

/**
 * Compara lo usado contra el límite de un rango de `meses` meses.
 * @returns {{cantidad, minutos, maxCantidad, maxMinutos, excedidoCantidad, excedidoMinutos, excedido}}
 */
function evaluar({ cantidad, minutos }, limiteMensual, meses = 1) {
  const maxCantidad = (limiteMensual.cantidad || 0) * meses;
  const maxMinutos = (limiteMensual.minutos || 0) * meses;
  const excedidoCantidad = maxCantidad > 0 && cantidad > maxCantidad;
  const excedidoMinutos = maxMinutos > 0 && minutos > maxMinutos;
  return { cantidad, minutos, maxCantidad, maxMinutos, excedidoCantidad, excedidoMinutos, excedido: excedidoCantidad || excedidoMinutos };
}

/** Cantidad de meses calendario que toca el rango [desde, hasta] (AAAA-MM-DD). */
function mesesDelRango(desde, hasta) {
  const [a1, m1] = String(desde).split('-').map(Number);
  const [a2, m2] = String(hasta).split('-').map(Number);
  return Math.max(1, (a2 - a1) * 12 + (m2 - m1) + 1);
}

/** ¿La empresa ya revisó esta configuración? (para la guía de Inicio) */
async function configurados(db, tenantId) {
  const claves = Object.values(CONCEPTOS).flatMap((c) => [c.cantidad, c.minutos]);
  const [r] = await db.query('SELECT COUNT(*) n FROM app_settings WHERE tenant_id = ? AND name IN (?)', [tenantId, claves]);
  return Number(r[0].n) > 0;
}

module.exports = { CONCEPTOS, leerLimites, guardarLimites, evaluar, mesesDelRango, configurados };
