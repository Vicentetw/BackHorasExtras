// ============================================================================
// Registro de los avisos de MercadoPago
// ============================================================================
//
// POR QUE EXISTE
// --------------
// Dos motivos, y los dos son problemas reales que ya se dieron.
//
// 1. IDEMPOTENCIA. MercadoPago REINTENTA: si el servidor no contesta rapido,
//    o contesta con error, manda la misma notificacion otra vez. Sin un
//    registro de lo ya procesado, el mismo pago se registra dos veces y cada
//    registro EXTIENDE EL PERIODO -- el cliente queda pago hasta dentro de
//    dos meses habiendo pagado uno.
//
// 2. DIAGNOSTICO. Reportado en la practica: se pago y no quedo registro de
//    nada. Sin este log no hay donde mirar: no se puede distinguir si
//    MercadoPago nunca aviso, si aviso y fallo el procesamiento, o si aviso
//    de algo que el codigo no reconocio. Los tres se ven igual desde afuera
//    -- o sea, no se ven.
//
// Se guarda el payload crudo a proposito: cuando algo no cierra, el JSON
// original es la unica fuente de verdad.

// Deja constancia de que el evento llego, ANTES de procesarlo. Devuelve
// { id, yaProcesado }.
//
// Si el mismo evento ya habia llegado, no se inserta otra fila: se suma un
// intento a la que existe. Asi queda registrado que MercadoPago reintento
// (dato util para entender por que) sin duplicar la operacion.
async function registrarRecepcion({ eventId, eventType, action, resourceId, signatureValid, payload }, db) {
  const [previo] = await db.query(
    `SELECT id, processing_status FROM mercadopago_events
     WHERE event_type = ? AND resource_id = ?`,
    [eventType || null, resourceId || null]
  );

  if (previo.length > 0) {
    const fila = previo[0];
    await db.query(
      'UPDATE mercadopago_events SET attempts = attempts + 1 WHERE id = ?', [fila.id]);
    // Solo cuenta como "ya procesado" si la vez anterior salio bien. Si habia
    // quedado en error, este reintento es una segunda oportunidad -- que es
    // justamente para lo que MercadoPago reintenta.
    return { id: fila.id, yaProcesado: fila.processing_status === 'procesado' };
  }

  const [r] = await db.query(
    `INSERT INTO mercadopago_events
       (event_id, event_type, action, resource_id, signature_valid, payload, processing_status)
     VALUES (?, ?, ?, ?, ?, ?, 'recibido')`,
    [eventId || null, eventType || null, action || null, resourceId || null,
     signatureValid === null || signatureValid === undefined ? null : (signatureValid ? 1 : 0),
     payload ? JSON.stringify(payload) : null]
  );
  return { id: r.insertId, yaProcesado: false };
}

async function marcarResultado(id, { status, tenantId, paymentRecordId, httpStatus, error }, db) {
  await db.query(
    `UPDATE mercadopago_events
     SET processing_status = ?, tenant_id = ?, payment_record_id = ?,
         http_status = ?, error_message = ?, processed_at = NOW()
     WHERE id = ?`,
    [status, tenantId ?? null, paymentRecordId ?? null, httpStatus ?? null,
     error ? String(error).slice(0, 2000) : null, id]
  );
}

// Para la pantalla de "Eventos MercadoPago" (punto 13 de la especificacion).
async function listar({ tenantId = null, limit = 100 } = {}, db) {
  const params = [];
  let where = '';
  if (tenantId !== null) { where = 'WHERE e.tenant_id = ?'; params.push(tenantId); }
  params.push(Number(limit) || 100);
  const [rows] = await db.query(
    `SELECT e.*, t.name AS tenant_name
     FROM mercadopago_events e
     LEFT JOIN tenants t ON t.id = e.tenant_id
     ${where}
     ORDER BY e.received_at DESC
     LIMIT ?`, params);
  return rows;
}

module.exports = { registrarRecepcion, marcarResultado, listar };
