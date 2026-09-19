// ============================================================================
// Registro de auditoria de cargas manuales (horas extra, licencias,
// exclusiones). Ver migracion 20260927_manual_entries_exclusions_audit.sql.
// ============================================================================
//
// QUE PROBLEMA RESUELVE
// ---------------------
// Cuando alguien carga 8 horas extra a mano, o marca un dia como Vacaciones,
// eso es plata. Si manana el empleado reclama ("yo no pedi esa licencia",
// "esas horas no las autorizo nadie"), hay que poder responder con datos:
// quien lo cargo, cuando, y que decia antes si se modifico. Hasta esta
// version quedaba el dato final y nada mas.
//
// LAS DOS COSAS QUE GUARDAMOS, Y POR QUE SON DISTINTAS
// ----------------------------------------------------
// 1. `created_by` / `updated_by` EN LA FILA ORIGINAL: responde "de quien es
//    esto ahora". Es rapido de consultar y se muestra al lado del dato.
// 2. La TABLA DE LOG (`manual_entry_log`, `user_exclusion_log`): responde
//    "que paso con esto a lo largo del tiempo". Hace falta porque:
//      - un UPDATE pisa el valor viejo: sin log, nadie puede ver que antes
//        decia otra cosa;
//      - un DELETE borra la fila: sin log, no queda NI RASTRO de que esas
//        horas existieron alguna vez.
//    El log es APPEND-ONLY: aca solo se inserta, nunca se actualiza ni se
//    borra. Un log que se puede editar no sirve como prueba de nada.
//
// POR QUE TODO VA DENTRO DE UNA TRANSACCION (`inTransaction`)
// -----------------------------------------------------------
// Si el cambio de datos y su fila de auditoria se hicieran como dos queries
// sueltas, un error entre medio dejaria uno de los dos estados falsos:
//   - se guardan las horas extra pero falla el log -> queda una carga
//     "fantasma", sin autor, que es exactamente el caso que esto viene a
//     evitar;
//   - se escribe el log pero falla el cambio -> el historial dice que paso
//     algo que nunca paso.
// Una transaccion hace que las dos cosas se confirmen juntas o no se
// confirme ninguna. En una base que maneja plata, "todo o nada" no es un
// lujo: es la unica opcion honesta.
//
// (Nota de implementacion: `db` aca es el pool de mysql2/promise. Una
// transaccion necesita LA MISMA conexion para todas sus queries, por eso
// `inTransaction` pide una conexion al pool con `getConnection()` y se la
// pasa al callback. Usar `db.query` adentro del callback seria un bug
// silencioso: esa query saldria por OTRA conexion, fuera de la transaccion.)

/**
 * Corre `fn` dentro de una transaccion y devuelve lo que `fn` devuelva.
 * Si `fn` lanza un error, se revierte TODO lo que haya hecho y el error se
 * vuelve a lanzar para que el endpoint lo maneje como siempre.
 *
 * @param {import('mysql2/promise').Pool} db
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} fn
 */
async function inTransaction(db, fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    // El rollback va en su propio try: si la conexion ya se murio, el
    // rollback tambien falla, y queremos propagar el error ORIGINAL (el que
    // explica que paso de verdad), no el del rollback.
    try { await conn.rollback(); } catch (_) { /* ignorado a proposito */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Quien esta haciendo la operacion. `req.appUser` lo deja el middleware de
 * autenticacion. Devuelve null si no hay usuario identificado -- preferimos
 * un log con autor desconocido antes que ningun log.
 */
function actorId(req) {
  return req && req.appUser ? req.appUser.id : null;
}

/**
 * Serializa la foto "antes" de una fila para la columna JSON `previous_data`.
 * Devuelve null si no hay estado previo (alta), porque en un alta no hay
 * nada anterior que guardar.
 */
function snapshot(row) {
  if (!row) return null;
  return JSON.stringify(row);
}

/**
 * Registra un movimiento sobre ManualEntries (hora extra manual, licencia,
 * dia omitido).
 *
 * @param {object} conn conexion DENTRO de la transaccion (ver inTransaction)
 * @param {object} p
 * @param {number|null} p.tenantId empresa duena del registro
 * @param {number} p.entryId id de la fila de ManualEntries
 * @param {number} p.userId users.USERID del empleado afectado
 * @param {'created'|'updated'|'deleted'} p.action
 * @param {object} p.data como queda la fila (o como estaba, si es un borrado)
 * @param {object|null} [p.previous] como estaba ANTES (solo update/delete)
 * @param {number|null} p.performedBy app_users.id de quien lo hizo
 */
async function logManualEntry(conn, { tenantId, entryId, userId, action, data, previous, performedBy }) {
  await conn.query(
    `INSERT INTO manual_entry_log
       (tenant_id, entry_id, user_id, action, start_datetime, end_datetime,
        duration_minutes, type, note, previous_data, performed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId ?? null,
      entryId,
      userId,
      action,
      data.startDatetime ?? null,
      data.endDatetime ?? null,
      data.durationMinutes ?? null,
      data.type ?? null,
      data.note ?? null,
      snapshot(previous),
      performedBy ?? null
    ]
  );
}

/**
 * Registra un movimiento sobre userexclusions (exclusion/licencia por dia).
 * Misma forma que logManualEntry -- ver ahi la explicacion de cada parte.
 */
async function logUserExclusion(conn, { tenantId, exclusionId, userId, action, data, previous, performedBy }) {
  await conn.query(
    `INSERT INTO user_exclusion_log
       (tenant_id, exclusion_id, user_id, action, exc_date, reason, type,
        event_type_id, exc_from, exc_to, previous_data, performed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      exclusionId ?? null,
      userId,
      action,
      data.excDate ?? null,
      data.reason ?? null,
      data.type ?? null,
      data.eventTypeId ?? null,
      data.excFrom ?? null,
      data.excTo ?? null,
      snapshot(previous),
      performedBy ?? null
    ]
  );
}

module.exports = {
  inTransaction,
  actorId,
  logManualEntry,
  logUserExclusion
};
