// ============================================================================
// Avisos al superadmin: que hay pendiente, y como enterarse sin entrar a mirar
// ============================================================================
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// Hay tres cosas que un cliente puede pedir y que solo avanzan si el
// superadmin las ve:
//
//   1. pedir un plan          (plan_requests, estado 'pending')
//   2. pedir el link de pago  (tenant_subscriptions.payment_requested_at)
//   3. pedir la baja          (tenant_subscriptions.cancellation_requested_at)
//
// Hasta hoy ninguna de las tres avisaba nada: quedaban esperando en la
// pantalla de Facturacion, y la unica forma de enterarse era entrar a mirar
// cada tanto. Un cliente que pide un link de pago un viernes a la noche
// podia quedarse esperando el fin de semana entero.
//
// LAS TRES VIAS, Y POR QUE LAS TRES
// ----------------------------------
//   * la CAMPANITA (contarPendientes) sirve estando adentro, en cualquier
//     pantalla, y no depende de ningun permiso ni configuracion;
//   * TELEGRAM avisa al celular en segundos, sin cuenta paga ni dependencias
//     nuevas (es un POST), y el destinatario se configura -- no tiene por que
//     ser siempre la misma persona;
//   * el PUSH del navegador llega aunque el sitio este cerrado.
//
// Ninguna reemplaza a las otras: la campanita no te busca, y un aviso externo
// se puede perder. Las tres miran el MISMO estado, que es este modulo.
//
// REGLA DE ORO: avisar NUNCA puede romper lo que lo disparo
// ----------------------------------------------------------
// Si Telegram no responde, si falta el token, si el destinatario esta mal
// escrito -- el pedido del cliente TIENE que quedar guardado igual. Por eso
// todo lo de afuera va envuelto en try/catch y se registra, pero jamas se
// propaga. Que el aviso falle es un problema; que se pierda el pedido de un
// cliente que quiere pagar es otra cosa.
const CLAVE_TELEGRAM_DESTINO = 'telegramChatIds';

// ---------------------------------------------------------------------------
// Que hay pendiente
// ---------------------------------------------------------------------------
async function contarPendientes(db) {
  const [[planes]] = await db.query(
    "SELECT COUNT(*) k FROM plan_requests WHERE status = 'pending'");
  const [[pagos]] = await db.query(
    'SELECT COUNT(*) k FROM tenant_subscriptions WHERE payment_requested_at IS NOT NULL');
  const [[bajas]] = await db.query(
    'SELECT COUNT(*) k FROM tenant_subscriptions WHERE cancellation_requested_at IS NOT NULL');

  return {
    pedidosDePlan: planes.k,
    pedidosDeLinkDePago: pagos.k,
    pedidosDeBaja: bajas.k,
    total: planes.k + pagos.k + bajas.k,
  };
}

// El detalle, para que la campanita pueda mostrar QUE empresa pidio QUE cosa
// y no solo un numero. Un "3" sin contexto obliga a entrar igual, que es
// justo lo que se quiere evitar.
async function listarPendientes(db) {
  const [planes] = await db.query(
    `SELECT t.id AS tenantId, t.name AS empresa, pr.created_at AS fecha,
            au.email AS pedidoPor
     FROM plan_requests pr
     JOIN tenants t ON t.id = pr.tenant_id
     LEFT JOIN app_users au ON au.id = pr.requested_by
     WHERE pr.status = 'pending'`);

  const [pagos] = await db.query(
    `SELECT t.id AS tenantId, t.name AS empresa, s.payment_requested_at AS fecha
     FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.payment_requested_at IS NOT NULL`);

  const [bajas] = await db.query(
    `SELECT t.id AS tenantId, t.name AS empresa, s.cancellation_requested_at AS fecha
     FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.cancellation_requested_at IS NOT NULL`);

  const item = (tipo, etiqueta) => (r) => ({
    tipo, etiqueta, tenantId: r.tenantId, empresa: r.empresa,
    fecha: r.fecha, pedidoPor: r.pedidoPor || null,
  });

  return [
    ...planes.map(item('plan', 'pidió un plan')),
    ...pagos.map(item('pago', 'pidió el link de pago')),
    ...bajas.map(item('baja', 'pidió la baja')),
  ].sort((a, b) => new Date(a.fecha) - new Date(b.fecha)); // lo más viejo primero
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
// Por que Telegram y no email: un POST contra su API, sin dependencias, sin
// cuenta de proveedor y sin carpeta de spam -- el correo transaccional desde
// un dominio nuevo empieza ahi y uno se entera tarde y mal. Son pocos avisos
// por mes, asi que tampoco hay ruido.
//
// El TOKEN del bot es un secreto y va en una variable de entorno. Los
// DESTINATARIOS no son secretos y cambian seguido (hoy vos, manana tambien
// quien atienda la facturacion), asi que van en app_settings, editables desde
// la pantalla sin tocar Render ni volver a desplegar.
async function destinatariosTelegram(db) {
  const [[fila]] = await db.query(
    'SELECT value FROM app_settings WHERE name = ? AND tenant_id IS NULL',
    [CLAVE_TELEGRAM_DESTINO]);
  if (!fila || !fila.value) return [];
  return String(fila.value).split(',').map((s) => s.trim()).filter(Boolean);
}

async function guardarDestinatariosTelegram(destinos, db) {
  const valor = (destinos || []).map((s) => String(s).trim()).filter(Boolean).join(',');
  await db.query(
    `INSERT INTO app_settings (name, tenant_id, value) VALUES (?, NULL, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [CLAVE_TELEGRAM_DESTINO, valor]);
  return valor ? valor.split(',') : [];
}

async function enviarTelegram(texto, db, { fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { enviados: 0, motivo: 'sin TELEGRAM_BOT_TOKEN' };

  const destinos = await destinatariosTelegram(db);
  if (destinos.length === 0) return { enviados: 0, motivo: 'sin destinatarios configurados' };

  let enviados = 0;
  for (const chatId of destinos) {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
      });
      if (r.ok) enviados++;
      else console.error(`AVISO telegram: ${chatId} respondio ${r.status}`);
    } catch (err) {
      console.error(`AVISO telegram: no se pudo avisar a ${chatId}:`, err.message);
    }
  }
  return { enviados, de: destinos.length };
}

// ---------------------------------------------------------------------------
// El punto de entrada que usan las rutas
// ---------------------------------------------------------------------------
const TEXTOS = {
  plan: (e) => `🆕 <b>${e}</b> pidió un plan.`,
  pago: (e) => `💳 <b>${e}</b> pidió el link de pago.`,
  baja: (e) => `⚠️ <b>${e}</b> pidió la baja.`,
  // Los de abajo NO son pedidos: son cosas que ya pasaron y de las que hay
  // que enterarse igual. Llegan por el webhook de MercadoPago, o sea sin que
  // nadie las haya disparado desde la pantalla -- hasta ahora quedaban
  // unicamente en un log del servidor que nadie mira.
  cobrado: (e) => `💰 <b>${e}</b> pagó.`,
  suscripcion: (e) => `🔄 Cambió el estado de la suscripción de <b>${e}</b>.`,
};

// Se llama DESPUES de guardar el pedido, nunca antes, y su resultado no se
// mira: ver la regla de oro arriba.
// El nombre de la empresa, para que el aviso diga "AVP pagó" y no "la
// empresa 6 pagó". Si falla, no importa: se avisa igual con un texto generico
// -- un problema para leer el nombre no puede impedir el aviso de un pago.
async function nombreDeEmpresa(tenantId, db) {
  try {
    const [[fila]] = await db.query('SELECT name FROM tenants WHERE id = ?', [tenantId]);
    return fila ? fila.name : `Empresa ${tenantId}`;
  } catch {
    return `Empresa ${tenantId}`;
  }
}

async function avisar(tipo, { empresa, detalle } = {}, db) {
  try {
    const arma = TEXTOS[tipo];
    if (!arma) return;
    let texto = arma(empresa || 'Una empresa');
    if (detalle) texto += `\n${detalle}`;
    texto += '\n\nhttps://horasdedicacionavp.web.app/facturacion';
    await enviarTelegram(texto, db);
  } catch (err) {
    console.error('AVISO: fallo al notificar, el pedido igual quedo guardado:', err.message);
  }
}

module.exports = {
  contarPendientes,
  listarPendientes,
  nombreDeEmpresa,
  destinatariosTelegram,
  guardarDestinatariosTelegram,
  enviarTelegram,
  avisar,
  CLAVE_TELEGRAM_DESTINO,
};
