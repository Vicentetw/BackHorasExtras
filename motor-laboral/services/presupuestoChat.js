// Tope DIARIO de mensajes del chat de ventas, para toda la pagina.
//
// Por que: cada mensaje del chat se paga (API de Anthropic) y el chat es
// publico. Los limites por persona y por conexion frenan a UN abusador; este
// tope frena un ataque repartido entre muchas conexiones, que es el que deja
// una factura. Al llegar al tope el chat deja de responder (manda a WhatsApp)
// y se avisa por Telegram UNA vez.
//
// Se guarda en app_settings como "AAAA-MM-DD:cantidad" (sin migracion). No es
// un contador exacto bajo concurrencia -- puede pasarse por unos pocos
// mensajes -- y esta bien: es un freno de emergencia, no una facturacion.
const { fechaEnZona, ZONA_DEFAULT } = require('./hoyEmpresa');

const CLAVE = 'chatVentasContadorDiario';
const TOPE_POR_DEFECTO = 300;

function topeDiario() {
  const n = Number(process.env.CHAT_VENTAS_TOPE_DIARIO);
  return Number.isInteger(n) && n > 0 ? n : TOPE_POR_DEFECTO;
}

/**
 * Cuenta un mensaje mas de hoy.
 * @returns {Promise<{permitido:boolean, usados:number, tope:number, recienAlcanzado:boolean}>}
 */
async function consumirMensaje(db, { hoy = fechaEnZona(ZONA_DEFAULT), tope = topeDiario() } = {}) {
  const [[fila]] = await db.query('SELECT value FROM app_settings WHERE name = ? AND tenant_id IS NULL', [CLAVE]);
  const [dia, cantidad] = String(fila ? fila.value : '').split(':');
  const usados = dia === hoy ? Number(cantidad) || 0 : 0;
  if (usados >= tope) return { permitido: false, usados, tope, recienAlcanzado: false };
  const nuevos = usados + 1;
  await db.query(
    `INSERT INTO app_settings (name, tenant_id, value) VALUES (?, NULL, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`, [CLAVE, `${hoy}:${nuevos}`]);
  return { permitido: true, usados: nuevos, tope, recienAlcanzado: nuevos === tope };
}

module.exports = { consumirMensaje, topeDiario, CLAVE, TOPE_POR_DEFECTO };
