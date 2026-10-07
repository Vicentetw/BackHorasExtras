// Turnos y ciclos de las plantillas rotativas (DISENO_HORARIOS_ROTATIVOS.md).
// Todo por empresa. Tolerante a la migracion 20261015 pendiente: si las
// tablas no existen, no hay turnos ni ciclos y nada cambia.

const SIN_TABLA = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

/**
 * Ciclos de las plantillas rotativas indicadas y los turnos que usan, en dos
 * consultas (no una por dia ni por empleado).
 * @returns {{ ciclos: Map<number, Map<number, number|null>>, turnos: Map<number, object> }}
 */
async function cargarCiclos(db, templateIds) {
  const ciclos = new Map();
  const turnos = new Map();
  const ids = [...new Set((templateIds || []).filter((x) => x != null))];
  if (!ids.length) return { ciclos, turnos };
  try {
    const [dias] = await db.query(
      'SELECT template_id, day_number, shift_id FROM template_cycle_days WHERE template_id IN (?)', [ids]);
    dias.forEach((d) => {
      if (!ciclos.has(d.template_id)) ciclos.set(d.template_id, new Map());
      ciclos.get(d.template_id).set(Number(d.day_number), d.shift_id);
    });
    const shiftIds = [...new Set(dias.map((d) => d.shift_id).filter((x) => x != null))];
    if (shiftIds.length) {
      const [filas] = await db.query(
        `SELECT s.id, s.nombre, t.inicio, t.fin, t.cruza_medianoche
         FROM shift_definitions s JOIN shift_definition_tramos t ON t.shift_id = s.id
         WHERE s.id IN (?) ORDER BY s.id, t.orden`, [shiftIds]);
      filas.forEach((f) => {
        if (!turnos.has(f.id)) turnos.set(f.id, { id: f.id, nombre: f.nombre, tramos: [] });
        turnos.get(f.id).tramos.push({ inicio: f.inicio, fin: f.fin, cruza_medianoche: f.cruza_medianoche });
      });
    }
  } catch (err) {
    if (!SIN_TABLA.has(err.code)) throw err;
  }
  return { ciclos, turnos };
}

// Turnos de una empresa con sus tramos (para la pantalla).
async function listarTurnos(db, tenantId) {
  const [filas] = await db.query(
    `SELECT s.id, s.nombre, s.color, s.activo, t.orden, TIME_FORMAT(t.inicio, '%H:%i') AS inicio,
            TIME_FORMAT(t.fin, '%H:%i') AS fin, t.cruza_medianoche
     FROM shift_definitions s LEFT JOIN shift_definition_tramos t ON t.shift_id = s.id
     WHERE s.tenant_id = ? ORDER BY s.nombre, t.orden`, [tenantId]);
  const porId = new Map();
  filas.forEach((f) => {
    if (!porId.has(f.id)) porId.set(f.id, { id: f.id, nombre: f.nombre, color: f.color, activo: !!f.activo, tramos: [] });
    if (f.inicio) porId.get(f.id).tramos.push({ inicio: f.inicio, fin: f.fin, cruzaMedianoche: !!f.cruza_medianoche });
  });
  return [...porId.values()];
}

module.exports = { cargarCiclos, listarTurnos, SIN_TABLA };
