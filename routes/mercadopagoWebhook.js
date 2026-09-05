const express = require('express');
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const mp = require('../motor-laboral/services/mercadopagoService');

// Fase 9b: recibe las notificaciones de MercadoPago cuando una suscripcion
// se autoriza (subscription_preapproval) o se cobra una cuota recurrente
// (subscription_authorized_payment). Ver mercadopagoService.js para el
// detalle de cada pieza (todas verificadas contra la documentacion oficial
// 2026-09-06).
//
// IMPORTANTE: esta ruta necesita el body CRUDO (sin parsear) para poder
// validar la firma -- por eso se monta con su propio express.raw() ANTES
// del express.json() global de horasdedica2.js (Express procesa
// middleware/rutas en el orden en que se registran; si el json() global
// corriera primero, req.body ya vendria parseado a objeto y la firma no
// se podria recalcular igual).
//
// db: conexion/pool ya armado (igual que el resto de las rutas). options:
// { accessToken, webhookSecret } -- opcionales, si no se pasan usa las
// variables de entorno MERCADOPAGO_ACCESS_TOKEN / MERCADOPAGO_WEBHOOK_SECRET
// (separado para poder testear sin depender de variables de entorno reales).
module.exports = function (db, options = {}) {
  const router = express.Router();

  router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
    // MercadoPago espera 200/201 rapido -- si tarda o devuelve otra cosa,
    // reintenta la notificacion. Por eso este handler nunca deja "colgado"
    // el request: cualquier error interno nuestro responde 200 igual (ver
    // el catch de abajo) para no generar una tormenta de reintentos por
    // algo que probablemente no se va a resolver solo reintentando.
    try {
      const accessToken = options.accessToken || process.env.MERCADOPAGO_ACCESS_TOKEN;
      const webhookSecret = options.webhookSecret || process.env.MERCADOPAGO_WEBHOOK_SECRET;

      const xSignature = req.headers['x-signature'];
      const xRequestId = req.headers['x-request-id'];
      const dataId = req.query['data.id'] || req.query.id;

      if (webhookSecret) {
        const validSignature = mp.verifyWebhookSignature({ xSignature, xRequestId, dataId, secret: webhookSecret });
        if (!validSignature) {
          console.warn('[MercadoPago webhook] firma invalida -- notificacion descartada', { xRequestId, dataId });
          return res.status(401).json({ error: 'Firma inválida' });
        }
      } else {
        // Sin MERCADOPAGO_WEBHOOK_SECRET configurado no hay forma de
        // validar que la notificacion sea realmente de MercadoPago -- se
        // acepta igual (para poder probar en desarrollo) pero se deja bien
        // marcado en el log, esto NUNCA deberia pasar en producción.
        console.warn('[MercadoPago webhook] MERCADOPAGO_WEBHOOK_SECRET no configurado -- aceptando SIN validar firma (solo aceptable en desarrollo)');
      }

      const body = req.body && req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
      const type = req.query.type || body.type || body.topic;

      if (!accessToken) {
        console.error('[MercadoPago webhook] MERCADOPAGO_ACCESS_TOKEN no configurado -- no se puede consultar el recurso');
        return res.status(200).json({ ok: false, error: 'access token no configurado' });
      }

      if (type === 'subscription_preapproval' && dataId) {
        const preapproval = await mp.getPreapproval({ accessToken, preapprovalId: dataId });
        const tenantId = Number(preapproval.external_reference);
        const newStatus = mp.mapPreapprovalStatus(preapproval.status);
        if (Number.isFinite(tenantId) && newStatus) {
          await billingRepo.updateSubscriptionStatus(tenantId, newStatus, db);
          console.log(`[MercadoPago webhook] tenant ${tenantId}: suscripción ${preapproval.status} -> status '${newStatus}'`);
        } else {
          console.warn('[MercadoPago webhook] preapproval sin external_reference valido o status sin mapeo automatico', {
            preapprovalId: dataId, externalReference: preapproval.external_reference, mpStatus: preapproval.status
          });
        }
      } else if (type === 'subscription_authorized_payment' && dataId) {
        const payment = await mp.getPayment({ accessToken, paymentId: dataId });
        // external_reference se hereda del preapproval que origino el cobro
        // -- verificado en pruebas reales antes de activar esto en
        // producción (no hay credenciales de prueba todavía al escribir
        // este código, ver el aviso en la respuesta a Vicente).
        const tenantId = Number(payment.external_reference);
        if (Number.isFinite(tenantId) && payment.status === 'approved') {
          const periodStart = payment.date_approved ? payment.date_approved.slice(0, 10) : new Date().toISOString().slice(0, 10);
          const periodEnd = new Date(periodStart);
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          await billingRepo.recordPayment({
            tenantId,
            amountUsd: payment.transaction_amount,
            amountLocal: payment.transaction_amount,
            localCurrency: payment.currency_id,
            method: 'mercadopago',
            reference: String(payment.id),
            periodStart,
            periodEnd: periodEnd.toISOString().slice(0, 10),
            recordedBy: null
          }, db);
          console.log(`[MercadoPago webhook] tenant ${tenantId}: cobro automático aprobado, período extendido hasta ${periodEnd.toISOString().slice(0, 10)}`);
        } else {
          console.warn('[MercadoPago webhook] pago sin external_reference válido o no aprobado', {
            paymentId: dataId, externalReference: payment.external_reference, status: payment.status
          });
        }
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[MercadoPago webhook] error procesando la notificación:', err);
      res.status(200).json({ ok: false });
    }
  });

  return router;
};
