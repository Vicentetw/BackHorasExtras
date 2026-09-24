const express = require('express');
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const mp = require('../motor-laboral/services/mercadopagoService');
const avisos = require('../avisos');
const eventsRepo = require('../motor-laboral/repositories/mercadopagoEventsRepository');

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
    //
    // `evento` se declara acá afuera, y no dentro del try, para que el catch
    // pueda dejar anotado que este evento falló. Si quedara adentro, un error
    // dejaría la fila en 'recibido' para siempre y no se sabría si se llegó a
    // procesar o no.
    let evento = null;
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

      // Se deja constancia ANTES de procesar. Dos motivos:
      //
      //  * IDEMPOTENCIA: MercadoPago reintenta. Si este mismo evento ya se
      //    proceso bien, no se vuelve a procesar -- si no, el pago se
      //    registraria dos veces y cada registro extiende el periodo.
      //  * DIAGNOSTICO: sin este registro no hay donde mirar cuando un pago
      //    no aparece. No se puede distinguir "MercadoPago nunca aviso" de
      //    "aviso y fallo" ni de "aviso algo que no reconocimos": los tres
      //    se ven igual desde afuera, o sea que no se ven.
      try {
        evento = await eventsRepo.registrarRecepcion({
          eventId: body.id ? String(body.id) : (xRequestId || null),
          eventType: type,
          action: body.action || null,
          resourceId: dataId ? String(dataId) : null,
          signatureValid: webhookSecret ? true : null,
          payload: body,
        }, db);

        if (evento.yaProcesado) {
          console.log(`[MercadoPago webhook] ${type}/${dataId} ya estaba procesado -- no se duplica`);
          await eventsRepo.marcarResultado(evento.id, { status: 'duplicado', httpStatus: 200 }, db);
          return res.status(200).json({ ok: true, duplicado: true });
        }
      } catch (err) {
        // Que falle el registro no puede impedir procesar el pago: perder la
        // trazabilidad es malo, perder el pago es peor.
        console.error('[MercadoPago webhook] no se pudo registrar el evento:', err.message);
      }

      const cerrar = async (status, extra = {}) => {
        if (evento) {
          try { await eventsRepo.marcarResultado(evento.id, { status, httpStatus: 200, ...extra }, db); }
          catch (e) { console.error('[MercadoPago webhook] no se pudo marcar el resultado:', e.message); }
        }
      };

      if (!accessToken) {
        console.error('[MercadoPago webhook] MERCADOPAGO_ACCESS_TOKEN no configurado -- no se puede consultar el recurso');
        await cerrar('error', { error: 'MERCADOPAGO_ACCESS_TOKEN no configurado' });
        return res.status(200).json({ ok: false, error: 'access token no configurado' });
      }

      if (type === 'subscription_preapproval' && dataId) {
        const preapproval = await mp.getPreapproval({ accessToken, preapprovalId: dataId });
        const tenantId = Number(preapproval.external_reference);
        const newStatus = mp.mapPreapprovalStatus(preapproval.status);
        if (Number.isFinite(tenantId) && newStatus) {
          await billingRepo.updateSubscriptionStatus(tenantId, newStatus, db);
          console.log(`[MercadoPago webhook] tenant ${tenantId}: suscripción ${preapproval.status} -> status '${newStatus}'`);
          // Un cambio de estado que llega solo: nadie lo disparo desde la
          // pantalla y hasta ahora quedaba unicamente en este log.
          await avisos.avisar('suscripcion', {
            empresa: await avisos.nombreDeEmpresa(tenantId, db),
            detalle: `MercadoPago dice: ${preapproval.status} → queda en "${newStatus}".`,
          }, db);
          await cerrar('procesado', { tenantId });
        } else {
          console.warn('[MercadoPago webhook] preapproval sin external_reference valido o status sin mapeo automatico', {
            preapprovalId: dataId, externalReference: preapproval.external_reference, mpStatus: preapproval.status
          });
          // 'ignorado' y no 'error': llegó bien, simplemente no había nada
          // que hacer con él. Distinguirlos importa para el diagnóstico.
          await cerrar('ignorado', {
            error: `status '${preapproval.status}' sin mapeo automático, o external_reference inválido ('${preapproval.external_reference}')`
          });
        }
      } else if ((type === 'payment' || type === 'payment.updated') && dataId) {
        // PAGO UNICO (no suscripcion). Llega con type 'payment', distinto del
        // cobro recurrente de abajo. Es el que se genera desde
        // /mercadopago-payment-link, para el cliente que no quiere dejar la
        // tarjeta en un debito automatico.
        //
        // Cuantos meses cubre viene en metadata, puesto al crear el link: sin
        // eso habria que deducirlo del monto, que es justo la clase de
        // suposicion que termina en un periodo mal extendido.
        const payment = await mp.getPayment({ accessToken, paymentId: dataId });
        const tenantId = Number(payment.external_reference);
        if (Number.isFinite(tenantId) && payment.status === 'approved') {
          const meses = Number(payment.metadata?.meses_que_cubre) || 1;

          // El periodo nuevo arranca cuando termina el vigente, no hoy: si
          // paga antes de vencer, no se le regalan los dias que le quedaban.
          const sub = await billingRepo.getSubscriptionByTenant(tenantId, db);
          const hoy = new Date();
          const finActual = sub && sub.current_period_end ? new Date(sub.current_period_end) : null;
          const inicio = finActual && finActual > hoy ? finActual : hoy;
          const fin = new Date(inicio);
          fin.setMonth(fin.getMonth() + meses);
          const fmt = (d) => d.toISOString().slice(0, 10);

          const pagoId = await billingRepo.recordPayment({
            tenantId,
            amountUsd: payment.transaction_amount,
            amountLocal: payment.transaction_amount,
            localCurrency: payment.currency_id,
            method: 'mercadopago',
            reference: String(payment.id),
            periodStart: fmt(inicio),
            periodEnd: fmt(fin),
            recordedBy: null,
          }, db);
          // Un pago unico tambien pone al dia a la empresa: sin esto seguiria
          // figurando vencida despues de haber pagado.
          await billingRepo.updateSubscriptionStatus(tenantId, 'active', db);

          console.log(`[MercadoPago webhook] tenant ${tenantId}: pago único aprobado (${meses} mes/es), período hasta ${fmt(fin)}`);
          await avisos.avisar('cobrado', {
            empresa: await avisos.nombreDeEmpresa(tenantId, db),
            detalle: `${payment.currency_id} ${payment.transaction_amount} · pago único por ${meses} mes(es) · ` +
                     `período hasta ${fmt(fin)}`,
          }, db);
          await cerrar('procesado', { tenantId, paymentRecordId: pagoId });
        } else {
          console.warn('[MercadoPago webhook] pago único sin external_reference válido o no aprobado', {
            paymentId: dataId, externalReference: payment.external_reference, status: payment.status
          });
          // Un pago rechazado o pendiente NO es un error nuestro: llegó bien
          // y lo correcto es no registrarlo como cobrado. Queda anotado con
          // su estado, que es lo que después hay que poder mirar.
          await cerrar('ignorado', {
            tenantId: Number.isFinite(tenantId) ? tenantId : null,
            error: `pago en estado '${payment.status}' (no 'approved'), o external_reference inválido ('${payment.external_reference}')`
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
          const pagoId = await billingRepo.recordPayment({
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
          // EL AVISO QUE MAS FALTABA: el cobro por MercadoPago entra solo,
          // sin que nadie toque nada. Antes solo quedaba en este log.
          await avisos.avisar('cobrado', {
            empresa: await avisos.nombreDeEmpresa(tenantId, db),
            detalle: `${payment.currency_id} ${payment.transaction_amount} · ` +
                     `período hasta ${periodEnd.toISOString().slice(0, 10)}`,
          }, db);
          await cerrar('procesado', { tenantId, paymentRecordId: pagoId });
        } else {
          console.warn('[MercadoPago webhook] pago sin external_reference válido o no aprobado', {
            paymentId: dataId, externalReference: payment.external_reference, status: payment.status
          });
          await cerrar('ignorado', {
            tenantId: Number.isFinite(tenantId) ? tenantId : null,
            error: `pago en estado '${payment.status}' (no 'approved'), o external_reference inválido ('${payment.external_reference}')`
          });
        }
      } else {
        // Un tipo de evento que no manejamos. NO es un error: MercadoPago
        // manda muchas cosas. Pero queda anotado, y es justamente lo que hay
        // que mirar cuando un pago "no llegó": puede haber llegado con un
        // tipo que no reconocemos.
        console.log(`[MercadoPago webhook] tipo '${type}' no manejado -- se ignora`);
        await cerrar('ignorado', { error: `tipo de evento no manejado: '${type}'` });
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[MercadoPago webhook] error procesando la notificación:', err);
      // Queda anotado como error, con el motivo. Asi, cuando MercadoPago
      // reintente, `registrarRecepcion` lo deja pasar de nuevo (un evento en
      // error NO cuenta como ya procesado) y este es el segundo intento --
      // que es justamente para lo que MercadoPago reintenta.
      if (evento) {
        try {
          await eventsRepo.marcarResultado(evento.id, {
            status: 'error', httpStatus: 200, error: err.message
          }, db);
        } catch (e) {
          console.error('[MercadoPago webhook] tampoco se pudo anotar el error:', e.message);
        }
      }
      res.status(200).json({ ok: false });
    }
  });

  return router;
};
