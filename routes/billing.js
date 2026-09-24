const express = require('express');
const { requireSuperadmin, resolveTenantId } = require('../appUserMiddleware');
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const { computeInvoiceAmount, resolveEffectiveStatus, DEFAULT_GRACE_DAYS, computeFreeTrialPeriod } = require('../motor-laboral/services/billingCalculations');
const mp = require('../motor-laboral/services/mercadopagoService');
const avisos = require('../avisos');

// Fase 9 (venta): planes configurables (base + precio por empleado) +
// suscripcion por empresa + pagos manuales o por MercadoPago
// (payment_records.method distingue el origen). Config de precios =
// platform-level, no de una empresa en particular, por eso requireSuperadmin
// en casi todo salvo lo que un admin de empresa necesita ver sobre SU
// PROPIA suscripcion (estado, proximo vencimiento, historial).
module.exports = function (db) {
  const router = express.Router();

  // Un admin de empresa puede ver su propia suscripcion; superadmin puede
  // ver la de cualquiera (via ?tenantId= o :tenantId de la URL, segun la ruta).
  function canViewTenant(req, tenantId) {
    if (req.appUser?.isSuperadmin) return true;
    return req.appUser?.tenantId === Number(tenantId);
  }

  // --- La campanita -------------------------------------------------------
  // Lo que alimenta el contador de pendientes de la barra superior. Es solo
  // superadmin porque son pedidos dirigidos A el: un admin de empresa ve el
  // estado de SU pedido en su propia pantalla, no el de los demas.
  //
  // Devuelve el detalle y no solo el numero: un "3" pelado obliga a entrar
  // igual, que es justo lo que esto viene a evitar.
  router.get('/pendientes', requireSuperadmin, async (req, res) => {
    try {
      const [conteo, detalle, novedades] = await Promise.all([
        avisos.contarPendientes(db),
        avisos.listarPendientes(db),
        avisos.listarNovedades(db),
      ]);
      // `total` cuenta SOLO los pendientes, a propósito: es lo que hay para
      // atender. Las novedades ya pasaron y no requieren nada -- si sumaran
      // al contador, el número dejaría de querer decir algo.
      res.json({ ...conteo, detalle, novedades });
    } catch (err) {
      console.error('ERROR contando pendientes:', err);
      res.status(500).json({ error: 'Error al contar los pendientes' });
    }
  });

  // --- A quien se le avisa por Telegram -----------------------------------
  // El token del bot es un secreto y vive en una variable de entorno. Los
  // destinatarios NO son secretos y cambian seguido, asi que se editan desde
  // la pantalla, sin tocar Render ni volver a desplegar.
  router.get('/avisos/telegram', requireSuperadmin, async (req, res) => {
    try {
      res.json({
        destinatarios: await avisos.destinatariosTelegram(db),
        botConfigurado: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      });
    } catch (err) {
      console.error('ERROR leyendo destinatarios de Telegram:', err);
      res.status(500).json({ error: 'Error al leer los destinatarios' });
    }
  });

  router.put('/avisos/telegram', requireSuperadmin, async (req, res) => {
    try {
      const { destinatarios } = req.body;
      if (!Array.isArray(destinatarios)) {
        return res.status(400).json({ error: 'destinatarios debe ser una lista' });
      }
      // Un chat_id de Telegram es un numero entero, y puede ser negativo
      // (los grupos lo son). Se valida antes de guardar: un valor mal escrito
      // no da error al guardarlo, falla despues y en silencio, el dia que
      // hacia falta el aviso.
      const invalidos = destinatarios.filter((d) => !/^-?\d+$/.test(String(d).trim()));
      if (invalidos.length) {
        return res.status(400).json({
          error: `Estos no parecen un chat_id de Telegram (tiene que ser un número): ${invalidos.join(', ')}`
        });
      }
      res.json({ destinatarios: await avisos.guardarDestinatariosTelegram(destinatarios, db) });
    } catch (err) {
      console.error('ERROR guardando destinatarios de Telegram:', err);
      res.status(500).json({ error: 'Error al guardar los destinatarios' });
    }
  });

  // Mandar un mensaje de prueba. Existe porque configurar un bot tiene varios
  // pasos fuera del sistema (crearlo, hablarle, sacar el chat_id) y sin esto
  // uno se entera de que algo quedo mal recien cuando se pierde un aviso real.
  router.post('/avisos/telegram/probar', requireSuperadmin, async (req, res) => {
    try {
      const r = await avisos.enviarTelegram(
        '✅ Prueba de Horas Dedica. Si ves esto, los avisos están funcionando.', db);
      if (r.enviados === 0) {
        return res.status(400).json({ error: `No se pudo enviar: ${r.motivo || 'ningún destinatario respondió'}` });
      }
      res.json({ ok: true, enviados: r.enviados });
    } catch (err) {
      console.error('ERROR probando Telegram:', err);
      res.status(500).json({ error: 'Error al enviar la prueba' });
    }
  });

  // --- Sincronizar con MercadoPago -----------------------------------------
  // CASO REAL que lo motivó (2026-09-24): un cliente pagó 50.000 ARS por un
  // link de pago único, el pago se acreditó bien en MercadoPago (approved,
  // con external_reference y metadata correctas)... y en el sistema no
  // apareció nada. MercadoPago NUNCA llamó al webhook — comprobado
  // consultando el pago por API y viendo la tabla de eventos vacía.
  //
  // Un webhook es un aviso que se puede perder: mal configurado, un corte de
  // red, el servidor dormido, un cambio en el panel. Depender solo de él
  // significa que un pago real puede quedar sin registrar y nadie enterarse.
  //
  // Esto pregunta al revés: "¿qué pagos hubo?", y registra los que falten.
  // Va por el MISMO camino idempotente que el webhook (recordPayment con la
  // clave única), así que correrlo dos veces no duplica nada.
  router.post('/sincronizar-mercadopago', requireSuperadmin, async (req, res) => {
    try {
      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) {
        return res.status(503).json({ error: 'MERCADOPAGO_ACCESS_TOKEN no está configurado en el servidor' });
      }

      // Por defecto, los últimos 30 días. Suficiente para recuperar lo que se
      // haya perdido sin traer el historial entero en cada corrida.
      const dias = Math.min(Math.max(Number(req.body?.dias) || 30, 1), 365);
      const hasta = new Date();
      const desde = new Date(hasta.getTime() - dias * 86400000);
      const fmt = (d) => d.toISOString().slice(0, 10);

      const pagos = await mp.searchPayments({ accessToken, desde: fmt(desde), hasta: fmt(hasta) });

      const registrados = [];
      const yaEstaban = [];
      const ignorados = [];

      for (const p of pagos) {
        const tenantId = Number(p.external_reference);
        if (!Number.isFinite(tenantId)) {
          ignorados.push({ id: p.id, motivo: `external_reference inválido ('${p.external_reference}')` });
          continue;
        }
        if (p.status !== 'approved') {
          ignorados.push({ id: p.id, motivo: `estado '${p.status}'` });
          continue;
        }

        // ¿Ya lo tenemos? Se mira antes de tocar nada, para poder informar
        // cuántos se recuperaron de verdad y no solo "listo".
        const [[existe]] = await db.query(
          "SELECT id FROM payment_records WHERE method = 'mercadopago' AND reference = ?",
          [String(p.id)]);
        if (existe) { yaEstaban.push(p.id); continue; }

        const meses = Number(p.metadata?.meses_que_cubre) || 1;
        const sub = await billingRepo.getSubscriptionByTenant(tenantId, db);
        if (!sub) {
          ignorados.push({ id: p.id, motivo: `la empresa ${tenantId} no tiene suscripción configurada` });
          continue;
        }

        // Mismo criterio que el webhook: el período nuevo arranca cuando
        // termina el vigente, no hoy.
        const hoy = new Date();
        const finActual = sub.current_period_end ? new Date(sub.current_period_end) : null;
        const inicio = finActual && finActual > hoy ? finActual : hoy;
        const fin = new Date(inicio);
        fin.setMonth(fin.getMonth() + meses);

        await billingRepo.recordPayment({
          tenantId,
          amountUsd: p.transaction_amount,
          amountLocal: p.transaction_amount,
          localCurrency: p.currency_id,
          method: 'mercadopago',
          reference: String(p.id),
          periodStart: fmt(inicio),
          periodEnd: fmt(fin),
          recordedBy: null,
        }, db);
        await billingRepo.updateSubscriptionStatus(tenantId, 'active', db);

        registrados.push({ id: p.id, tenantId, monto: p.transaction_amount, moneda: p.currency_id, meses });
        await avisos.avisar('cobrado', {
          empresa: await avisos.nombreDeEmpresa(tenantId, db),
          detalle: `${p.currency_id} ${p.transaction_amount} · recuperado al sincronizar (el webhook no había llegado)`,
        }, db);
      }

      res.json({
        ok: true,
        revisados: pagos.length,
        recuperados: registrados.length,
        yaEstaban: yaEstaban.length,
        detalleRecuperados: registrados,
        detalleIgnorados: ignorados,
      });
    } catch (err) {
      console.error('ERROR sincronizando con MercadoPago:', err);
      res.status(502).json({ error: 'No se pudo sincronizar con MercadoPago: ' + err.message });
    }
  });

  // --- Todos los pagos, de todas las empresas ------------------------------
  // Hasta ahora los pagos solo se veían entrando empresa por empresa, desde
  // el diálogo de "Registrar pago". Con un cliente alcanza; con veinte, no
  // hay forma de responder "¿cuánto entró este mes?" ni "¿quién pagó?".
  //
  // Filtros por query string, todos opcionales: desde, hasta, tenantId,
  // method, q (busca en la referencia o el nombre de la empresa).
  router.get('/payments', requireSuperadmin, async (req, res) => {
    try {
      const { desde, hasta, tenantId, method, q } = req.query;
      const where = [];
      const params = [];

      if (desde) { where.push('p.created_at >= ?'); params.push(`${desde} 00:00:00`); }
      if (hasta) { where.push('p.created_at <= ?'); params.push(`${hasta} 23:59:59`); }
      if (tenantId) { where.push('p.tenant_id = ?'); params.push(Number(tenantId)); }
      if (method) { where.push('p.method = ?'); params.push(String(method)); }
      if (q) {
        where.push('(p.reference LIKE ? OR t.name LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }

      const [rows] = await db.query(
        `SELECT p.id, p.tenant_id, t.name AS tenant_name, p.amount_usd, p.amount_local,
                p.local_currency, p.method, p.reference, p.period_start, p.period_end,
                p.created_at, au.email AS recorded_by_email
         FROM payment_records p
         JOIN tenants t ON t.id = p.tenant_id
         LEFT JOIN app_users au ON au.id = p.recorded_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.created_at DESC
         LIMIT 500`, params);

      // Los totales se calculan sobre LO FILTRADO, no sobre todo: si alguien
      // filtra por un mes, el total tiene que ser el de ese mes. Un total que
      // no coincide con lo que se está mirando es peor que no tenerlo.
      const totalPorMoneda = {};
      rows.forEach((r) => {
        const m = r.local_currency || 'ARS';
        totalPorMoneda[m] = (totalPorMoneda[m] || 0) + Number(r.amount_local || 0);
      });

      res.json({
        pagos: rows,
        cantidad: rows.length,
        totalPorMoneda,
        // Aviso honesto: si se llegó al tope, los totales son parciales.
        truncado: rows.length === 500,
      });
    } catch (err) {
      console.error('ERROR listando pagos:', err);
      res.status(500).json({ error: 'Error al listar los pagos' });
    }
  });

  // Borrar un pago cargado por error. Solo superadmin.
  //
  // Se permite SOLO para pagos manuales: los de MercadoPago son el reflejo de
  // una operación real que existe del otro lado, y borrarlos acá no la
  // deshace -- solo la esconde. Si un pago de MercadoPago está mal, lo que
  // corresponde es un reembolso allá, no un DELETE acá.
  router.delete('/payments/:id', requireSuperadmin, async (req, res) => {
    try {
      const [[pago]] = await db.query(
        'SELECT id, tenant_id, method, reference FROM payment_records WHERE id = ?', [req.params.id]);
      if (!pago) return res.status(404).json({ error: 'Ese pago no existe' });

      if (pago.method !== 'manual') {
        return res.status(409).json({
          error: 'Solo se pueden borrar los pagos cargados a mano. Este vino de MercadoPago: ' +
                 'borrarlo acá no deshace la operación allá, solo la esconde. ' +
                 'Si está mal, corresponde un reembolso en MercadoPago.'
        });
      }

      await db.query('DELETE FROM payment_records WHERE id = ?', [req.params.id]);
      res.json({
        ok: true,
        aviso: 'Pago borrado. Ojo: el período de la suscripción NO se recalcula solo — ' +
               'revisalo y ajustalo si hace falta.'
      });
    } catch (err) {
      console.error('ERROR borrando pago:', err);
      res.status(500).json({ error: 'Error al borrar el pago' });
    }
  });

  router.get('/plans', async (req, res) => {
    try {
      const activeOnly = !req.appUser?.isSuperadmin;
      const plans = await billingRepo.getPlans(db, { activeOnly });
      res.json(plans);
    } catch (err) {
      console.error('ERROR listing plans:', err);
      res.status(500).json({ error: 'Error al listar planes' });
    }
  });

  router.post('/plans', requireSuperadmin, async (req, res) => {
    try {
      const { name, base_price_usd, price_per_employee_usd, min_billed_employees } = req.body;
      if (!name || base_price_usd === undefined || price_per_employee_usd === undefined || !min_billed_employees) {
        return res.status(400).json({ error: 'name, base_price_usd, price_per_employee_usd y min_billed_employees son requeridos' });
      }
      const id = await billingRepo.createPlan({
        name,
        base_price_usd,
        price_per_employee_usd,
        min_billed_employees,
        // Fase 15: tope de empleados incluidos en el plan ("como una
        // telefonia") -- null/undefined = sin limite, a proposito (un plan
        // enterprise a medida puede no tener tope).
        max_employees: req.body.max_employees === undefined || req.body.max_employees === null || req.body.max_employees === ''
          ? null : Number(req.body.max_employees),
        discount_quarterly_pct: req.body.discount_quarterly_pct ?? 5,
        discount_semiannual_pct: req.body.discount_semiannual_pct ?? 10,
        discount_annual_pct: req.body.discount_annual_pct ?? 17,
        active: req.body.active !== false,
        is_default: !!req.body.is_default
      }, db);
      res.status(201).json({ ok: true, id });
    } catch (err) {
      console.error('ERROR creating plan:', err);
      res.status(500).json({ error: 'Error al crear el plan' });
    }
  });

  router.put('/plans/:id', requireSuperadmin, async (req, res) => {
    try {
      const existing = await billingRepo.getPlanById(req.params.id, db);
      if (!existing) return res.status(404).json({ error: 'Plan no encontrado' });
      const { name, base_price_usd, price_per_employee_usd, min_billed_employees } = req.body;
      if (!name || base_price_usd === undefined || price_per_employee_usd === undefined || !min_billed_employees) {
        return res.status(400).json({ error: 'name, base_price_usd, price_per_employee_usd y min_billed_employees son requeridos' });
      }
      await billingRepo.updatePlan(req.params.id, {
        name,
        base_price_usd,
        price_per_employee_usd,
        min_billed_employees,
        max_employees: req.body.max_employees === undefined
          ? existing.max_employees
          : (req.body.max_employees === null || req.body.max_employees === '' ? null : Number(req.body.max_employees)),
        discount_quarterly_pct: req.body.discount_quarterly_pct ?? existing.discount_quarterly_pct,
        discount_semiannual_pct: req.body.discount_semiannual_pct ?? existing.discount_semiannual_pct,
        discount_annual_pct: req.body.discount_annual_pct ?? existing.discount_annual_pct,
        active: req.body.active !== false,
        is_default: !!req.body.is_default
      }, db);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR updating plan:', err);
      res.status(500).json({ error: 'Error al actualizar el plan' });
    }
  });

  router.get('/subscriptions', requireSuperadmin, async (req, res) => {
    try {
      const subscriptions = await billingRepo.getAllSubscriptions(db);
      const defaultGraceDays = DEFAULT_GRACE_DAYS;
      const enriched = subscriptions.map((s) => ({
        ...s,
        effectiveStatus: resolveEffectiveStatus({
          status: s.status,
          currentPeriodEnd: s.current_period_end,
          gracePeriodDays: s.grace_period_days,
          defaultGraceDays
        })
      }));
      res.json(enriched);
    } catch (err) {
      console.error('ERROR listing subscriptions:', err);
      res.status(500).json({ error: 'Error al listar suscripciones' });
    }
  });

  router.get('/subscriptions/:tenantId', async (req, res) => {
    try {
      const { tenantId } = req.params;
      if (!canViewTenant(req, tenantId)) return res.status(403).json({ error: 'No autorizado' });

      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      const employeeCount = await billingRepo.countBillableEmployees(tenantId, db);

      if (!subscription) {
        // Empresa sin suscripcion configurada todavia (tenants que ya
        // existian antes de este sistema, o un usuario dado de alta a mano
        // sin asignarle plan) -- no se la bloquea, se informa que no tiene
        // plan asignado en vez de tirar 404. OJO: esto decia 'trial' antes
        // (bug real, encontrado de paso en Fase 17) -- 'none' es lo que
        // realmente pasa, nada que ver con estar en el mes de prueba.
        return res.json({ tenantId: Number(tenantId), subscription: null, employeeCount, effectiveStatus: 'none' });
      }

      const effectiveStatus = resolveEffectiveStatus({
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        gracePeriodDays: subscription.grace_period_days,
        defaultGraceDays: DEFAULT_GRACE_DAYS
      });

      const invoicePreview = computeInvoiceAmount({
        plan: subscription,
        employeeCount,
        billingPeriod: subscription.billing_period
      });

      res.json({ tenantId: Number(tenantId), subscription, employeeCount, effectiveStatus, invoicePreview });
    } catch (err) {
      console.error('ERROR fetching subscription:', err);
      res.status(500).json({ error: 'Error al leer la suscripción' });
    }
  });

  // Estados que un superadmin puede elegir a mano. 'grace'/'readonly' NO
  // estan acá a proposito -- esos son resultados CALCULADOS a partir de
  // las fechas (ver resolveEffectiveStatus), no algo que se elija.
  const MANUAL_STATUSES = ['trial', 'active', 'canceled', 'free'];

  router.post('/subscriptions/:tenantId', requireSuperadmin, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { plan_id, billing_period, status } = req.body;
      if (!plan_id) return res.status(400).json({ error: 'plan_id es requerido' });
      if (status !== undefined && !MANUAL_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status debe ser uno de: ${MANUAL_STATUSES.join(', ')}` });
      }
      const plan = await billingRepo.getPlanById(plan_id, db);
      if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });

      // Primer mes gratis (pedido del usuario 2026-09-06): si no se manda
      // una fecha explicita, una alta nueva arranca HOY con un mes de
      // regalo, sin importar el plazo de pago que vaya a tener despues
      // (billing_period es para cuando empiece a pagar, no para este
      // primer mes). Despues de este mes, sigue el mismo camino que
      // cualquier otro vencimiento: grace ("pagar al mes vencido") y
      // recien despues solo lectura si no se pago -- ver DEFAULT_GRACE_DAYS.
      let periodStart = req.body.current_period_start || null;
      let periodEnd = req.body.current_period_end || null;
      if (!periodStart && !periodEnd) {
        ({ periodStart, periodEnd } = computeFreeTrialPeriod());
      }

      await billingRepo.upsertSubscription(tenantId, {
        plan_id,
        billing_period: billing_period || 'monthly',
        status: status || 'trial',
        payment_method: req.body.payment_method || 'manual',
        mercadopago_subscription_id: req.body.mercadopago_subscription_id || null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        grace_period_days: req.body.grace_period_days ?? null,
        grace_message: req.body.grace_message || null
      }, db);

      // Asignarle un plan de verdad ES la respuesta a un pedido pendiente
      // (Fase 17) -- se resuelve solo, mismo espiritu que recordCheckoutLink
      // con payment_requested_at.
      const pendingRequest = await billingRepo.getPendingPlanRequestForTenant(tenantId, db);
      if (pendingRequest) await billingRepo.resolvePlanRequest(pendingRequest.id, db);

      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR saving subscription:', err);
      res.status(500).json({ error: 'Error al guardar la suscripción' });
    }
  });

  // Registrar un pago MANUAL (transferencia/efectivo, etc.) -- extiende el
  // periodo vigente a partir del vencimiento actual (o de hoy si ya estaba
  // vencida, para no regalar los dias de atraso).
  router.post('/subscriptions/:tenantId/payments', requireSuperadmin, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada' });

      const employeeCount = await billingRepo.countBillableEmployees(tenantId, db);
      const invoice = computeInvoiceAmount({
        plan: subscription,
        employeeCount,
        billingPeriod: subscription.billing_period
      });

      const today = new Date();
      const currentEnd = subscription.current_period_end ? new Date(subscription.current_period_end) : null;
      const periodStart = currentEnd && currentEnd > today ? currentEnd : today;
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + invoice.months);

      const fmt = (d) => d.toISOString().slice(0, 10);

      const id = await billingRepo.recordPayment({
        tenantId,
        amountUsd: req.body.amount_usd ?? invoice.totalUsd,
        amountLocal: req.body.amount_local || null,
        localCurrency: req.body.local_currency || 'ARS',
        method: 'manual',
        reference: req.body.reference || null,
        periodStart: fmt(periodStart),
        periodEnd: fmt(periodEnd),
        recordedBy: req.appUser?.id || null
      }, db);

      res.status(201).json({ ok: true, id, periodStart: fmt(periodStart), periodEnd: fmt(periodEnd), invoice });
    } catch (err) {
      console.error('ERROR recording payment:', err);
      res.status(500).json({ error: 'Error al registrar el pago' });
    }
  });

  router.get('/subscriptions/:tenantId/payments', async (req, res) => {
    try {
      const { tenantId } = req.params;
      if (!canViewTenant(req, tenantId)) return res.status(403).json({ error: 'No autorizado' });
      const payments = await billingRepo.getPaymentHistory(tenantId, db);
      res.json(payments);
    } catch (err) {
      console.error('ERROR fetching payment history:', err);
      res.status(500).json({ error: 'Error al leer el historial de pagos' });
    }
  });

  // Genera un link de checkout de MercadoPago para que el cliente autorice
  // el cobro recurrente (Suscripciones -- Preapproval API). El monto va en
  // pesos (o lo que se mande) a mano, no se auto-calcula desde el USD de
  // referencia -- el tipo de cambio lo controla el superadmin (ver la
  // conversacion sobre precios en USD vs cobro en ARS). Fase 10: ahora
  // tambien se elige el periodo (mensual/trimestral/semestral/anual) y el
  // link resultante se GUARDA (antes se perdia apenas se cerraba el
  // dialogo) para que el cliente lo vea despues desde su propio panel
  // (/pagos) -- sigue siendo el superadmin quien lo genera y se lo
  // "entrega" viendolo en el panel, no un checkout que el cliente arma
  // solo (evita todo el problema de calcular un precio en ARS de forma
  // segura sin que el cliente lo pueda manipular).
  router.post('/subscriptions/:tenantId/mercadopago-checkout', requireSuperadmin, async (req, res) => {
    try {
      // ORDEN DELIBERADO: primero se valida lo que manda el cliente y
      // recien despues se chequea la configuracion del servidor.
      //
      // Al reves (como estaba hasta el 2026-09-19), un billing_period
      // invalido devolvia 503 "MERCADOPAGO_ACCESS_TOKEN no esta
      // configurado" en cualquier ambiente sin ese token. Dos problemas:
      // el mensaje enganaba a quien llama (el problema es SU request, no
      // la configuracion del server), y el test de este endpoint fallaba
      // SIEMPRE en local y en CI, donde ese token no existe. Ese fallo se
      // venia arrastrando catalogado como "flake de MercadoPago" cuando
      // en realidad era determinista y no llamaba a ninguna API externa.
      //
      // Regla general: un dato invalido del cliente es 400, tenga o no
      // tenga el servidor configurado el servicio externo.
      const { tenantId } = req.params;
      const { payer_email, monthly_amount, currency_id, billing_period } = req.body;
      if (!payer_email || !monthly_amount) {
        return res.status(400).json({ error: 'payer_email y monthly_amount son requeridos' });
      }
      if (billing_period !== undefined && !['monthly', 'quarterly', 'semiannual', 'annual'].includes(billing_period)) {
        return res.status(400).json({ error: "billing_period debe ser 'monthly', 'quarterly', 'semiannual' o 'annual'" });
      }

      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) {
        return res.status(503).json({ error: 'MERCADOPAGO_ACCESS_TOKEN no está configurado en el servidor' });
      }

      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada -- asignale un plan primero' });

      const tenantName = subscription.tenant_name || `Empresa #${tenantId}`;
      const effectiveBillingPeriod = billing_period || subscription.billing_period;
      // back_url es REQUERIDO por MercadoPago (probado contra el sandbox
      // real -- "back_url is required" si se manda undefined, pese a que
      // los ejemplos de la documentacion lo muestran como si fuera
      // opcional). Default al hosting de produccion conocido si no hay
      // FRONTEND_URL configurada, para que nunca falte.
      const backUrl = `${process.env.FRONTEND_URL || 'https://horasdedicacionavp.web.app'}/facturacion`;

      const checkout = await mp.createSubscriptionCheckout({
        accessToken,
        tenantId,
        tenantName,
        payerEmail: payer_email,
        transactionAmount: monthly_amount,
        currencyId: currency_id || 'ARS',
        backUrl,
        billingPeriod: effectiveBillingPeriod
      });

      await billingRepo.upsertSubscription(tenantId, {
        plan_id: subscription.plan_id,
        billing_period: effectiveBillingPeriod,
        status: subscription.status,
        payment_method: 'mercadopago',
        mercadopago_subscription_id: checkout.id,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        grace_period_days: subscription.grace_period_days,
        grace_message: subscription.grace_message
      }, db);
      await billingRepo.recordCheckoutLink(tenantId, checkout.initPoint, db);

      res.status(201).json({ ok: true, mercadopagoSubscriptionId: checkout.id, checkoutUrl: checkout.initPoint });
    } catch (err) {
      console.error('ERROR creating MercadoPago checkout:', err);
      res.status(502).json({ error: err.message || 'Error al crear el checkout de MercadoPago', mpResponse: err.mpResponse });
    }
  });

  // Fase 10 -- el cliente pide la baja desde su propio panel (/pagos). NO
  // se cancela nada todavia: queda pendiente hasta que un superadmin la
  // apruebe (ver approve-cancellation abajo). canViewTenant permite tanto
  // al dueño del tenant como a un superadmin -- en la practica solo lo va
  // a usar el cliente, pero no hace falta una regla aparte para eso.
  // --- Link de pago UNICO (no suscripción) ---------------------------------
  // Pedido real: "por si quieren pagar todo el año o ir pagando mensual pero
  // no suscripción". Hay clientes que no quieren dejar la tarjeta para un
  // débito automático.
  //
  // A diferencia del checkout de suscripción, esto NO deja nada vivo después
  // del pago: se cobra una vez y se termina. Por eso tampoco toca
  // `mercadopago_subscription_id` -- si lo pisara, el día que hubiera que
  // cancelar un débito automático se cancelaría el link equivocado.
  router.post('/subscriptions/:tenantId/mercadopago-payment-link', requireSuperadmin, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { amount, months, currency_id, payer_email } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ error: 'amount es requerido y tiene que ser mayor a cero' });
      }
      const meses = months === undefined ? 1 : Number(months);
      if (!Number.isInteger(meses) || meses < 1 || meses > 36) {
        return res.status(400).json({ error: 'months tiene que ser un número entero entre 1 y 36' });
      }

      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) {
        return res.status(503).json({ error: 'MERCADOPAGO_ACCESS_TOKEN no está configurado en el servidor' });
      }

      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) {
        return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada -- asignale un plan primero' });
      }

      const backUrl = `${process.env.FRONTEND_URL || 'https://horasdedicacionavp.web.app'}/facturacion`;
      const link = await mp.createOneTimePaymentLink({
        accessToken,
        tenantId,
        tenantName: subscription.tenant_name || `Empresa ${tenantId}`,
        amount: Number(amount),
        currencyId: currency_id || 'ARS',
        backUrl,
        mesesQueCubre: meses,
        payerEmail: payer_email || undefined,
      });

      // Se guarda el link para poder volver a copiarlo sin generar otro --
      // generar uno nuevo cada vez deja links viejos dando vueltas, y el
      // cliente puede terminar pagando por el que no era.
      await billingRepo.recordCheckoutLink(tenantId, link.initPoint, db);

      res.json({ ok: true, checkoutUrl: link.initPoint, preferenceId: link.id, mesesQueCubre: meses });
    } catch (err) {
      console.error('ERROR creando link de pago único:', err);
      res.status(502).json({ error: 'No se pudo crear el link de pago: ' + err.message });
    }
  });

  // Anular el link generado por error, para poder hacer otro.
  //
  // Solo borra NUESTRA referencia al link: la preferencia sigue existiendo en
  // MercadoPago y técnicamente se podría pagar si alguien guardó la URL. Por
  // eso el mensaje de la pantalla tiene que ser honesto -- "dejá de usar este
  // link" no es lo mismo que "este link ya no funciona".
  //
  // MercadoPago no permite anular una preferencia de pago ya creada (a
  // diferencia de una suscripción, que sí se cancela). Lo único que se puede
  // hacer de verdad es no mandarla, y si ya se mandó, avisarle al cliente.
  router.delete('/subscriptions/:tenantId/checkout-link', requireSuperadmin, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada' });

      await db.query(
        `UPDATE tenant_subscriptions
         SET last_checkout_url = NULL, last_checkout_generated_at = NULL
         WHERE tenant_id = ?`, [tenantId]);

      res.json({
        ok: true,
        aviso: 'El link se quitó del sistema y el cliente ya no lo ve. ' +
               'Si se lo habías mandado, avisale que no lo use: MercadoPago no permite ' +
               'anular un link de pago ya creado, así que técnicamente sigue siendo pagable.'
      });
    } catch (err) {
      console.error('ERROR quitando el link de pago:', err);
      res.status(500).json({ error: 'Error al quitar el link' });
    }
  });

  router.post('/subscriptions/:tenantId/request-cancellation', async (req, res) => {
    try {
      const { tenantId } = req.params;
      if (!canViewTenant(req, tenantId)) return res.status(403).json({ error: 'No autorizado' });

      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada' });
      if (subscription.status === 'canceled') {
        return res.status(409).json({ error: 'La suscripción ya está dada de baja' });
      }
      if (subscription.cancellation_requested_at) {
        return res.status(409).json({ error: 'Ya hay un pedido de baja pendiente' });
      }

      await billingRepo.requestCancellation(tenantId, req.appUser?.id || null, db);
      await avisos.avisar('baja', { empresa: subscription.tenant_name }, db);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR requesting cancellation:', err);
      res.status(500).json({ error: 'Error al pedir la baja' });
    }
  });

  // Retirar un pedido de baja pendiente -- lo puede hacer tanto el cliente
  // (se arrepiente) como el superadmin (lo rechaza). Mismo efecto en
  // ambos casos: se borra la marca de "pendiente", el status no se toca.
  router.delete('/subscriptions/:tenantId/cancellation-request', async (req, res) => {
    try {
      const { tenantId } = req.params;
      if (!canViewTenant(req, tenantId)) return res.status(403).json({ error: 'No autorizado' });
      await billingRepo.clearCancellationRequest(tenantId, db);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR clearing cancellation request:', err);
      res.status(500).json({ error: 'Error al retirar el pedido de baja' });
    }
  });

  // Solo el superadmin aprueba -- recien aca se bloquea de verdad
  // (status='canceled', ver isFullyBlocked en billingCalculations.js).
  router.post('/subscriptions/:tenantId/approve-cancellation', requireSuperadmin, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada' });

      // HUECO REAL encontrado el 2026-09-23: esto solo ponia
      // status='canceled' en NUESTRA base. A MercadoPago nunca se le avisaba,
      // asi que el debito automatico seguia corriendo y al cliente le
      // seguian cobrando todos los meses despues de darse de baja.
      //
      // El orden importa: PRIMERO se cancela en MercadoPago y recien despues
      // se marca aca. Si se hiciera al reves y MercadoPago fallara, la
      // pantalla diria "dada de baja" mientras al cliente le siguen
      // debitando -- que es exactamente el problema que esto viene a
      // arreglar, pero ahora invisible.
      let avisoMercadoPago = null;
      if (subscription.mercadopago_subscription_id) {
        const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
        if (!accessToken) {
          return res.status(503).json({
            error: 'Esta suscripción se cobra por MercadoPago y falta MERCADOPAGO_ACCESS_TOKEN en el servidor. ' +
                   'No se dio de baja: si se marcara acá sin cancelarla allá, al cliente le seguirían cobrando.'
          });
        }
        try {
          const r = await mp.cancelPreapproval({
            accessToken, preapprovalId: subscription.mercadopago_subscription_id
          });
          avisoMercadoPago = r.yaEstaba
            ? 'La suscripción ya estaba cancelada en MercadoPago.'
            : 'Débito automático cancelado en MercadoPago.';
        } catch (err) {
          console.error('ERROR cancelando en MercadoPago:', err.message, err.mpResponse || '');
          return res.status(502).json({
            error: 'No se pudo cancelar el débito automático en MercadoPago: ' + err.message +
                   '. NO se dio de baja acá tampoco, para que no quede marcada como baja mientras le siguen cobrando.'
          });
        }
      }

      await billingRepo.approveCancellation(tenantId, db);
      await avisos.avisar('suscripcion', {
        empresa: subscription.tenant_name || await avisos.nombreDeEmpresa(tenantId, db),
        detalle: 'Baja aprobada.' + (avisoMercadoPago ? ' ' + avisoMercadoPago : ''),
      }, db);
      res.json({ ok: true, mercadopago: avisoMercadoPago });
    } catch (err) {
      console.error('ERROR approving cancellation:', err);
      res.status(500).json({ error: 'Error al aprobar la baja' });
    }
  });

  // Fase 12 -- el cliente pide desde /pagos que le generen un link de pago
  // (hueco real: antes no tenia forma de avisar, ni de entender por que no
  // veia ningun boton). Solo deja constancia -- el superadmin sigue siendo
  // quien genera el link de verdad (POST mercadopago-checkout, mas abajo),
  // que ya limpia esta marca solo al hacerlo.
  router.post('/subscriptions/:tenantId/request-payment-link', async (req, res) => {
    try {
      const { tenantId } = req.params;
      if (!canViewTenant(req, tenantId)) return res.status(403).json({ error: 'No autorizado' });
      const subscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (!subscription) return res.status(404).json({ error: 'La empresa no tiene una suscripción configurada' });
      await billingRepo.requestPaymentLink(tenantId, db);
      // El aviso va DESPUES de guardar y su resultado no se mira: si Telegram
      // falla, el pedido tiene que quedar igual. Ver avisos.js.
      await avisos.avisar('pago', { empresa: subscription.tenant_name }, db);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR requesting payment link:', err);
      res.status(500).json({ error: 'Error al pedir el link de pago' });
    }
  });

  // Fase 17 -- hueco real reportado por el superadmin: una empresa SIN
  // suscripcion todavia (ni siquiera un trial -- ej. un usuario creado a
  // mano sin asignarle plan) caia en un /acceso-denegado incomprensible en
  // la primera pantalla que probara, sin ninguna forma de pedir un plan.
  // tenantId sale del usuario logueado, nunca del body -- mismo criterio
  // de seguridad que el resto de este archivo.
  router.post('/plan-requests', async (req, res) => {
    try {
      const tenantId = req.appUser?.tenantId;
      if (req.appUser?.isSuperadmin || tenantId == null) {
        return res.status(400).json({ error: 'Tu usuario no tiene una empresa asignada' });
      }
      const existingSubscription = await billingRepo.getSubscriptionByTenant(tenantId, db);
      if (existingSubscription) {
        return res.status(409).json({ error: 'Tu empresa ya tiene un plan asignado' });
      }
      const { phone, contact_preference, employee_count, clock_count, schedule_type } = req.body;
      await billingRepo.createPlanRequest({
        tenantId,
        requestedBy: req.appUser.id,
        phone,
        contactPreference: contact_preference,
        employeeCount: employee_count,
        clockCount: clock_count,
        scheduleType: schedule_type
      }, db);
      const [[empresa]] = await db.query('SELECT name FROM tenants WHERE id = ?', [tenantId]);
      await avisos.avisar('plan', {
        empresa: empresa?.name,
        detalle: [
          employee_count != null ? `${employee_count} empleados` : null,
          clock_count != null ? `${clock_count} reloj(es)` : null,
          phone ? `Tel: ${phone}` : null,
        ].filter(Boolean).join(' · ') || null,
      }, db);
      res.status(201).json({ ok: true });
    } catch (err) {
      if (err.code === 'ALREADY_PENDING') return res.status(409).json({ error: err.message });
      console.error('ERROR creating plan request:', err);
      res.status(500).json({ error: 'Error al enviar el pedido de plan' });
    }
  });

  // El propio tenant puede consultar si tiene un pedido pendiente (para que
  // /pagos sepa que mensaje mostrar); el superadmin ve TODOS via ?all=1.
  router.get('/plan-requests', async (req, res) => {
    try {
      if (req.query.all) {
        if (!req.appUser?.isSuperadmin) return res.status(403).json({ error: 'No autorizado' });
        const rows = await billingRepo.getAllPendingPlanRequests(db);
        return res.json(rows);
      }
      const tenantId = req.appUser?.tenantId;
      if (tenantId == null) return res.json(null);
      const row = await billingRepo.getPendingPlanRequestForTenant(tenantId, db);
      res.json(row);
    } catch (err) {
      console.error('ERROR listing plan requests:', err);
      res.status(500).json({ error: 'Error al consultar los pedidos de plan' });
    }
  });

  router.post('/plan-requests/:id/resolve', requireSuperadmin, async (req, res) => {
    try {
      await billingRepo.resolvePlanRequest(req.params.id, db);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR resolving plan request:', err);
      res.status(500).json({ error: 'Error al resolver el pedido' });
    }
  });

  return router;
};
