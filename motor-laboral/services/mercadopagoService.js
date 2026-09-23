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
const { PERIOD_MONTHS } = require('./billingCalculations');

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
//
// backUrl es REQUERIDO -- probado contra el sandbox real: sin el, tira
// "back_url is required" (400), aunque los ejemplos de la documentacion
// oficial lo muestran como si fuera opcional.
async function createSubscriptionCheckout({
  accessToken,
  tenantId,
  tenantName,
  payerEmail,
  transactionAmount,
  currencyId,
  backUrl,
  billingPeriod,
  fetchImpl = fetch
}) {
  // frequency/frequency_type de MercadoPago -- antes hardcodeado a 1 mes
  // (unico caso probado originalmente). Fase 10: el superadmin puede elegir
  // trimestral/semestral/anual al generar el link, reutilizando la MISMA
  // tabla mensual->cantidad de meses que ya usa computeInvoiceAmount (no
  // duplicar el mapeo). `transaction_amount` sigue siendo el monto YA
  // calculado para todo el periodo (no el mensual) -- eso lo resuelve quien
  // llama a esta funcion, aca solo se arma el request a MercadoPago.
  const months = PERIOD_MONTHS[billingPeriod] || 1;
  const body = {
    // "reason" tiene 2 restricciones reales de MercadoPago, encontradas
    // probando contra el sandbox (no documentadas explicitamente): maximo
    // 60 caracteres, y el doble guion "--" dispara su filtro de contenido
    // ("Request contains invalid or disallowed content" / invalid_field_content).
    // Se trunca defensivamente por si el nombre de la empresa es largo.
    reason: `Suscripcion - ${tenantName}`.slice(0, 60),
    external_reference: String(tenantId),
    payer_email: payerEmail,
    auto_recurring: {
      frequency: months,
      frequency_type: 'months',
      transaction_amount: Number(transactionAmount),
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

// ============================================================================
// Link de pago UNICO (no suscripcion)
// ============================================================================
//
// Pedido real: "por si quieren pagar todo el año o ir pagando mensual pero no
// suscripcion". Hay clientes que no quieren dejar la tarjeta para un debito
// automatico, y prefieren pagar cuando les toca.
//
// Es otra API: /checkout/preferences, no /preapproval. La diferencia de fondo
// es que aca no queda nada "vivo" despues del pago -- se cobra una vez y se
// termina. No hay nada que cancelar despues, que es justamente lo que el
// cliente quiere evitar.
//
// `mesesQueCubre` viaja en metadata para que el webhook sepa hasta cuando
// extender el periodo. Sin eso habria que adivinar del monto, que es
// exactamente el tipo de suposicion que termina en un cobro mal imputado.
async function createOneTimePaymentLink({
  accessToken,
  tenantId,
  tenantName,
  amount,
  currencyId,
  backUrl,
  mesesQueCubre = 1,
  payerEmail,
  fetchImpl = fetch
}) {
  const meses = Number(mesesQueCubre) || 1;
  const titulo = meses === 1
    ? `Horas Dedica - 1 mes - ${tenantName}`
    : `Horas Dedica - ${meses} meses - ${tenantName}`;

  const body = {
    items: [{
      title: titulo.slice(0, 250),
      quantity: 1,
      unit_price: Number(amount),
      currency_id: currencyId || 'ARS',
    }],
    // Lo que le dice al webhook de que empresa es este pago. Mismo mecanismo
    // que usa la suscripcion.
    external_reference: String(tenantId),
    metadata: { tenant_id: String(tenantId), meses_que_cubre: meses },
    back_urls: { success: backUrl, failure: backUrl, pending: backUrl },
    // Vuelve solo al sitio cuando el pago se aprueba, en vez de dejar al
    // cliente parado en la pantalla de MercadoPago sin saber si termino.
    auto_return: 'approved',
  };
  if (payerEmail) body.payer = { email: payerEmail };

  const res = await fetchImpl(`${MP_API_BASE}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || 'Error creando el link de pago en MercadoPago');
    err.mpResponse = json;
    err.status = res.status;
    throw err;
  }
  return { id: json.id, initPoint: json.init_point, mesesQueCubre: meses };
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

// ============================================================================
// Cancelar la suscripcion EN MercadoPago
// ============================================================================
//
// Hueco real encontrado el 2026-09-23: aprobar una baja desde la pantalla
// solo ponia status='canceled' en NUESTRA base. A MercadoPago nunca se le
// avisaba, asi que el debito automatico seguia corriendo y al cliente le
// seguian cobrando todos los meses despues de haberse dado de baja.
//
// La API es PUT /preapproval/{id} con status 'cancelled' (con dos eles, asi
// lo escribe MercadoPago).
//
// Que una suscripcion YA este cancelada no es un error: si alguien la
// cancelo desde la app de MercadoPago y despues se aprueba la baja aca, el
// resultado buscado ya se cumplio. Se devuelve yaEstaba para que el llamador
// pueda seguir sin tratarlo como falla.
async function cancelPreapproval({ accessToken, preapprovalId, fetchImpl = fetch }) {
  const res = await fetchImpl(`${MP_API_BASE}/preapproval/${preapprovalId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  const json = await res.json().catch(() => ({}));

  if (res.ok) return { ok: true, yaEstaba: json.status === 'cancelled' && false, status: json.status };

  // MercadoPago devuelve 400 cuando ya esta cancelada. No es un fallo.
  const mensaje = String(json.message || '').toLowerCase();
  if (mensaje.includes('cancelled') || mensaje.includes('cancelada')) {
    return { ok: true, yaEstaba: true, status: 'cancelled' };
  }

  const err = new Error(json.message || 'Error cancelando la suscripción en MercadoPago');
  err.mpResponse = json;
  err.status = res.status;
  throw err;
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
  createOneTimePaymentLink,
  getPreapproval,
  cancelPreapproval,
  getPayment,
  mapPreapprovalStatus,
  verifyWebhookSignature
};
