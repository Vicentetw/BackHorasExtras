// Licencias multi-día (vacaciones, enfermedad, etc.) cargadas en employee_events.
// Se exponen ya resueltas contra `employees.employee_id` (legajo) para poder
// cruzarlas fácilmente con badge/legajo en los distintos reportes de asistencia.

const SELECT_FIELDS = `
  ee.id, ee.employee_id, ee.fecha_desde, ee.fecha_hasta, ee.dias, ee.observaciones,
  e.employee_id AS legajo,
  et.code AS eventTypeCode, et.descripcion AS eventTypeDescripcion
`;

async function findByDate(date, db) {
  const [rows] = await db.query(
    `SELECT ${SELECT_FIELDS}
     FROM employee_events ee
     JOIN employees e ON e.id = ee.employee_id
     LEFT JOIN event_types et ON et.id = ee.event_type_id
     WHERE ee.fecha_desde <= ? AND ee.fecha_hasta >= ?`,
    [date, date]
  );
  return rows;
}

async function findByRange(from, to, db) {
  const [rows] = await db.query(
    `SELECT ${SELECT_FIELDS}
     FROM employee_events ee
     JOIN employees e ON e.id = ee.employee_id
     LEFT JOIN event_types et ON et.id = ee.event_type_id
     WHERE ee.fecha_desde <= ? AND ee.fecha_hasta >= ?`,
    [to, from]
  );
  return rows;
}

module.exports = {
  findByDate,
  findByRange
};
