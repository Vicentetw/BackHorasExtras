const express = require('express');
const { requireSuperadmin, resolveTenantId } = require('../appUserMiddleware');
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const { computeInvoiceAmount, resolveEffectiveStatus, DEFAULT_GRACE_DAYS } = require('../motor-laboral/services/billingCalculations');

// Fase 9 (venta): planes configurables (base + precio por empleado) +
// suscripcion por empresa + pagos manuales (MercadoPago se suma despues,
// mismo esquema -- payment_records.method ya distingue el origen). Config
// de precios = platform-level, no de una empresa en particular, por eso
// requireSuperadmin en casi todo salvo lo que un admin de empresa necesita
// ver sobre SU PROPIA suscripcion (estado, proximo vencimiento, historial).
module.exports = function (db) {
  const router = express.Router();

  // Un admin de empresa puede ver su propia suscripcion; superadmin puede
  // ver la de cualquiera (via ?tenantId= o :tenantId de la URL, segun la ruta).
  function canViewTenant(req, tenantId) {
    if (req.appUser?.isSuperadmin) return true;
    return req.appUser?.tenantId === Number(tenantId);
  }

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
        // existian antes de este sistema) -- no se la bloquea, se informa
        // que no tiene plan asignado en vez de tirar 404.
        return res.json({ tenantId: Number(tenantId), subscription: null, employeeCount, effectiveStatus: 'trial' });
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

  router.post('/subscriptions/:tenantId', requireSuperadmin, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { plan_id, billing_period, status } = req.body;
      if (!plan_id) return res.status(400).json({ error: 'plan_id es requerido' });
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
        const today = new Date();
        const oneMonthOut = new Date(today);
        oneMonthOut.setMonth(oneMonthOut.getMonth() + 1);
        periodStart = today.toISOString().slice(0, 10);
        periodEnd = oneMonthOut.toISOString().slice(0, 10);
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

  return router;
};
