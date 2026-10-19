// ============================================================================
// Saldo de vacaciones: UNA sola cuenta para todas las pantallas (2026-10-19)
// ============================================================================
//
// Lo usan: "Saldos de vacaciones" (la lista), el saldo de una persona y el
// formulario "Cargar ausencia" (que muestra "le quedan X, quedarían Y").
// Antes cada lugar tenía su propia consulta.
//
// ASIGNADOS de un año:
//   - lo que se cargó a mano para esa persona y ese año (employee_leave_balances);
//   - si no se cargó nada: lo que corresponde por la ESCALA de la empresa
//     según su antigüedad al 1 de enero (o la de la ley, art. 150 LCT, si la
//     empresa no cargó la suya). Pedido del dueño (rediseño de ausencias, B):
//     antes había que escribirlo persona por persona y año por año, y sin eso
//     el saldo daba negativo. Se marca `porEscala: true` para que se vea de
//     dónde salió y se pueda corregir a mano.
// TOMADOS: las licencias con un motivo que DESCUENTA VACACIONES (la marca del
//   motivo), del año al que se imputan (balance_year, o el año de inicio).
//   Antes contaba solo el motivo de código exacto 'VACACIONES': un motivo
//   "Vacaciones adelantadas" marcado igual no descontaba nada.

// Escala de vacaciones de la Ley de Contrato de Trabajo (art. 150).
const ESCALA_LCT = [
  { id: null, min_years: 0, max_years: 5, days: 14 },
  { id: null, min_years: 5, max_years: 10, days: 21 },
  { id: null, min_years: 10, max_years: 20, days: 28 },
  { id: null, min_years: 20, max_years: null, days: 35 },
];

async function escalaDe(db, tenantId) {
  if (tenantId == null) return { escala: ESCALA_LCT, esLaDeLaLey: true };
  const [rows] = await db.query('SELECT id, min_years, max_years, days FROM vacation_scale WHERE tenant_id = ? ORDER BY min_years ASC', [tenantId]);
  return rows.length ? { escala: rows, esLaDeLaLey: false } : { escala: ESCALA_LCT, esLaDeLaLey: true };
}

/** Pura. Años de antigüedad al 1 de enero de `anio`, y los días que le tocan. */
function diasPorEscala(fechaAlta, anio, escala) {
  if (!fechaAlta) return { dias: null, anios: null };
  const referencia = new Date(Number(anio), 0, 1);
  const alta = new Date(String(fechaAlta).slice(0, 10) + 'T00:00:00');
  const anios = Math.max(0, (referencia - alta) / (365.25 * 24 * 3600 * 1000));
  const paso = (escala || []).find((s) => anios >= s.min_years && (s.max_years == null || anios < s.max_years));
  return { dias: paso ? Number(paso.days) : null, anios: Number(anios.toFixed(1)) };
}

// Motivo que descuenta vacaciones: la marca, o el código histórico.
const ES_VACACIONES = "(et.descuenta_vacaciones = 1 OR et.code = 'VACACIONES')";

/**
 * Saldos de un año para varias personas de UNA empresa.
 * @returns {Map<number, {asignados, porEscala, anios, tomados, quedan, notas, vencimiento, isAutomatic}>}
 *          clave: id interno de employees
 */
async function saldos(db, tenantId, anio, empleados) {
  // empleados: [{ id, fecha_alta }]
  const ids = empleados.map((e) => e.id);
  const out = new Map();
  if (!ids.length) return out;
  const { escala } = await escalaDe(db, tenantId);
  const [cargados] = await db.query(
    'SELECT employee_id, allotted_days, notes, expiration_date, is_automatic FROM employee_leave_balances WHERE year = ? AND employee_id IN (?)',
    [anio, ids]);
  const porId = new Map(cargados.map((r) => [r.employee_id, r]));
  const [tomadas] = await db.query(
    `SELECT ee.employee_id, COALESCE(SUM(ee.dias), 0) AS tomados
       FROM employee_events ee JOIN event_types et ON et.id = ee.event_type_id
      WHERE ee.employee_id IN (?) AND ${ES_VACACIONES}
        AND COALESCE(ee.balance_year, YEAR(ee.fecha_desde)) = ?
      GROUP BY ee.employee_id`,
    [ids, anio]);
  const tomadosPorId = new Map(tomadas.map((r) => [r.employee_id, Number(r.tomados)]));
  for (const e of empleados) {
    const c = porId.get(e.id);
    const esc = diasPorEscala(e.fecha_alta, anio, escala);
    const asignados = c ? Number(c.allotted_days) : (esc.dias ?? 0);
    const tomados = tomadosPorId.get(e.id) || 0;
    out.set(e.id, {
      asignados,
      porEscala: !c && esc.dias != null,
      anios: esc.anios,
      sugeridoPorEscala: esc.dias,
      tomados,
      quedan: Number((asignados - tomados).toFixed(2)),
      notas: c ? c.notes : null,
      vencimiento: c ? c.expiration_date : null,
      isAutomatic: c ? !!c.is_automatic : false,
    });
  }
  return out;
}

module.exports = { ESCALA_LCT, escalaDe, diasPorEscala, saldos, ES_VACACIONES };
