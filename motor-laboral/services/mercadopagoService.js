// Integracion con MercadoPago Suscripciones (Preapproval API) -- Fase 9b.
// Referencia verificada contra la documentacion oficial (2026-09-06):
// https://www.mercadopago.com.mx/developers/en/reference/subscriptions/_preapproval/post
// https://www.mercadopago.com.co/developers/en/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments
// https://www.mercadopago.com.br/developers/en/prompt-library/implementation-of-a-mercado-pago-webhooks-notification-receiver
//
// Se usa fetch() directo a la REST API en vez del paquete npm `mercadopago`
// -- evita sumar una dependencia nueva cuya superficie exacta de la
// version actual no se pudo verificar del todo, y deja el request/response
// explicito y facil de debuggear. La API REST en si esta bien documentada
// y es estable (Bearer token + JSON), no hace falta un SDK para esto.
//
// Todas las funciones que llaman a la API reciben `fetchImpl` inyectable
// (default: fetch global) para poder testear la logica de negocio sin
// pegarle a MercadoPago de verdad (no tenemos credenciales reales todavia).
const crypto = require('crypto');

const MP_API_BASE = 'https://api.mercadopago.com';

// Crea una suscripcion "sin plan asociado" con pago PENDIENTE -- el flujo
// mas simple para arrancar: se genera un link (init_point) que el
// superadmin le manda al cliente (email/whatsapp), el cliente lo abre,
// carga su tarjeta en MercadoPago y autoriza el cobro recurrente. Recien
// ahi el webhook nos avisa que quedo 'authorized'.
//
// tenantId se manda como external_reference -- es lo que despues nos deja
// saber, cuando llega el webhook, a que empresa pertenece esta suscripcion
// (MercadoPago no sabe nada de nuestro modelo de tenants).
async function createSubscriptionCheckout({
  accessToken,
  tenantId,
  tenantName,
  payerEmail,
  monthlyAmountUsd,
  currencyId,
  backUrl,
  fetchImpl = fetch
}) {
  const body = {
    reason: `Suscripción Sistema de Asistencia -- ${tenantName}`,
    external_reference: String(tenantId),
    payer_email: payerEmail,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: Number(monthlyAmountUsd),
      currency_id: currencyId || 'ARS'
    },
    back_url: backUrl,
    status: 'pending'
  };

  const res = await fetchImpl(`${MP_API_BASE}/preapproval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message || 'Error creando la suscripción en MercadoPago');
    err.mpResponse = json;
    err.status = res.status;
    throw err;
  }
  // id: identificador de la suscripcion en MercadoPago (lo guardamos en
  // tenant_subscriptions.mercadopago_subscription_id). init_point: el link
  // de checkout para que el cliente autorice.
  return { id: json.id, initPoint: json.init_point, status: json.status };
}

async function getPreapproval({ accessToken, preapprovalId, fetchImpl = fetch }) {
  const res = await fetchImpl(`${MP_API_BASE}/preapproval/${preapprovalId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message || 'Error consultando la suscripción en MercadoPago');
    err.mpResponse = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

async function getPayment({ accessToken, paymentId, fetchImpl = fetch }) {
  const res = await fetchImpl(`${MP_API_BASE}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.message || 'Error consultando el pago en MercadoPago');
    err.mpResponse = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

// preapproval.status (MercadoPago) -> nuestro tenant_subscriptions.status.
// 'authorized' es el unico que nos importa activar -- 'pending' (todavia
// no autorizo), 'paused'/'cancelled' se resuelven a mano por ahora (no hay
// suficiente informacion para decidir solo si eso deberia ser 'grace' o
// 'canceled' -- mejor que lo vea un superadmin).
function mapPreapprovalStatus(mpStatus) {
  if (mpStatus === 'authorized') return 'active';
  return null; // sin cambio automatico -- se deja tal cual esta
}

// Valida el header x-signature de un webhook de MercadoPago. Formula
// verificada contra la doc oficial: manifest = "id:{id};request-id:{req};ts:{ts};",
// HMAC-SHA256 hex con el secret de la app, comparado contra v1 en tiempo
// constante (evita timing attacks). Devuelve true/false -- no lanza.
function verifyWebhookSignature({ xSignature, xRequestId, dataId, secret }) {
  if (!xSignature || !xRequestId || !dataId || !secret) return false;

  const parts = Object.fromEntries(
    xSignature.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim(), v?.trim()];
    })
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(v1, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

module.exports = {
  createSubscriptionCheckout,
  getPreapproval,
  getPayment,
  mapPreapprovalStatus,
  verifyWebhookSignature
};
