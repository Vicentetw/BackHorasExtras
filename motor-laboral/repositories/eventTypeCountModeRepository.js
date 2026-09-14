// Historial de vigencias (corridos/habiles) por motivo -- ver migracion
// 20260916_event_type_count_modes.sql y leaveDaysCalculations.js.
const { contarDiasLicencia } = require('../services/leaveDaysCalculations');

async function findByEventType(eventTypeId, db) {
  const [rows] = await db.query(
    `SELECT etcm.id, etcm.event_type_id, etcm.modo, etcm.vigente_desde, etcm.created_at,
            etcm.created_by, au.email AS created_by_email
     FROM event_type_count_modes etcm
     LEFT JOIN app_users au ON au.id = etcm.created_by
     WHERE etcm.event_type_id = ?
     ORDER BY etcm.vigente_desde DESC`,
    [eventTypeId]
  );
  return rows;
}

// Para el calculo (leaveDaysCalculations.contarDiasLicencia) solo hace
// falta {modo, vigente_desde}, sin el resto de columnas de auditoria.
async function findVigenciasParaCalculo(eventTypeId, db) {
  const [rows] = await db.query(
    `SELECT modo, vigente_desde FROM event_type_count_modes WHERE event_type_id = ?`,
    [eventTypeId]
  );
  return rows;
}

async function create({ eventTypeId, modo, vigenteDesde, createdBy }, db) {
  const [result] = await db.query(
    `INSERT INTO event_type_count_modes (event_type_id, modo, vigente_desde, created_by) VALUES (?, ?, ?, ?)`,
    [eventTypeId, modo, vigenteDesde, createdBy ?? null]
  );
  return result.insertId;
}

// Feriados en un rango -- mismo criterio que ya usa /attendance-range:
// fecha exacta dentro del rango, O recurrente (se repite todos los anios
// en ese mes/dia) sin importar en que anio se cargo originalmente. OJO:
// igual que el resto del sistema hoy, esto NO filtra por tenant_id (los
// feriados son globales en la base actual) -- se mantiene ese mismo
// criterio a proposito, para no divergir del calculo de asistencia.
async function findFeriadosEnRango(fechaDesde, fechaHasta, db) {
  const [rows] = await db.query(
    `SELECT date, recurring FROM holidays WHERE date BETWEEN ? AND ? OR recurring = 1`,
    [fechaDesde, fechaHasta]
  );
  const fechas = new Set();
  const recurrentesMesDia = new Set();
  rows.forEach((h) => {
    if (h.recurring) recurrentesMesDia.add(h.date.slice(5));
    else fechas.add(h.date);
  });
  return { fechas, recurrentesMesDia };
}

// Orquesta lo de arriba: trae las vigencias del motivo + los feriados del
// rango y le pide a la funcion pura que cuente los dias. Punto unico que
// usan tanto el preview (GET) como el guardado real (POST/PUT) de
// employee_events -- asi el numero que se ve antes de guardar es siempre
// el mismo que se termina guardando.
async function computeDiasLicencia(eventTypeId, fechaDesde, fechaHasta, db) {
  const [vigencias, feriados] = await Promise.all([
    findVigenciasParaCalculo(eventTypeId, db),
    findFeriadosEnRango(fechaDesde, fechaHasta, db),
  ]);
  return contarDiasLicencia(fechaDesde, fechaHasta, vigencias, feriados);
}

module.exports = {
  findByEventType,
  findVigenciasParaCalculo,
  create,
  findFeriadosEnRango,
  computeDiasLicencia,
};
