// Etapa 9 del plan "Motor de reglas de asistencia configurable" (ver
// fases para impletentar avance.txt). Resuelve "Empleado + Fecha ->
// convenio aplicable" -- mismo patron de vigencia (valid_from/valid_to)
// que ya usa scheduleRepository.findAssignedScheduleMapForDate para
// plantillas, aplicado a employee_convention_assignments.
//
// Un empleado sin ninguna fila (o sin ninguna vigente para esa fecha)
// devuelve null -- el llamador sigue usando la configuracion de la
// plantilla directamente, sin convenio (comportamiento por defecto,
// opt-in). El calculo historico queda resuelto SOLO por tener valid_from/
// valid_to: pedir la fecha de un mes ya cerrado devuelve el convenio que
// estaba vigente ESE dia, no el actual.

// employeeId: employees.id (PK interno, no el legajo -- mismo criterio
// que la FK de la tabla). date: 'YYYY-MM-DD'.
async function findActiveAssignment(employeeId, date, db) {
  const [rows] = await db.query(
    `SELECT id, employee_id, tenant_id, convention_id, category_id, valid_from, valid_to
     FROM employee_convention_assignments
     WHERE employee_id = ?
       AND valid_from <= ?
       AND (valid_to IS NULL OR valid_to >= ?)
     ORDER BY valid_from DESC
     LIMIT 1`,
    [employeeId, date, date]
  );
  return rows[0] || null;
}

// Trae, de una sola vez, las asignaciones vigentes de VARIOS empleados
// para una fecha -- evita 1 consulta por empleado en un reporte mensual/
// anual (mismo motivo que ya justifica findAssignedScheduleMapForDate).
// Devuelve un Map employeeId -> fila (o sin entrada si no tiene convenio).
async function findActiveAssignmentsForEmployees(employeeIds, date, db) {
  const map = new Map();
  const safeIds = (employeeIds || []).filter((id) => typeof id === 'number' && !Number.isNaN(id));
  if (safeIds.length === 0) return map;

  const [rows] = await db.query(
    `SELECT id, employee_id, tenant_id, convention_id, category_id, valid_from, valid_to
     FROM employee_convention_assignments
     WHERE employee_id IN (?)
       AND valid_from <= ?
       AND (valid_to IS NULL OR valid_to >= ?)
     ORDER BY employee_id ASC, valid_from DESC`,
    [safeIds, date, date]
  );
  for (const row of rows) {
    if (!map.has(row.employee_id)) map.set(row.employee_id, row);
  }
  return map;
}

module.exports = {
  findActiveAssignment,
  findActiveAssignmentsForEmployees
};
