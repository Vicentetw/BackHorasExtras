// Calculo de facturacion (Fase 9, venta) -- funciones puras, sin I/O, para
// poder testearlas sin DB. Dos piezas:
//   1. computeInvoiceAmount: cuanto se le cobra a una empresa segun su
//      plan, cantidad de empleados y plazo de pago elegido.
//   2. resolveEffectiveStatus: en que estado esta la suscripcion HOY segun
//      la fecha de vencimiento guardada -- no se persiste un cron aparte,
//      se recalcula en cada request (misma filosofia que el resto del
//      motor: la fuente de verdad son las fechas, no un flag que alguien
//      se puede olvidar de actualizar).
//
// IMPORTANTE: la cantidad de empleados para facturar SIEMPRE sale de la
// tabla `employees` (tenant_id + activos) -- nunca de `users` (fichajes
// crudos del reloj, con ruido/duplicados/gente sin matchear todavia). Ver
// countBillableEmployees en billingRepository.js.

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
// Pedido del usuario 2026-09-06: primer mes gratis (trial) + "pagar al mes
// vencido" -- en vez de exigir el pago ANTES de arrancar el periodo
// siguiente, se le da un mes completo de margen (arrears) despues de
// vencido para que lo pague, y recien ahi (si no pago) pasa a solo
// lectura. 30 dias en vez de un numero chico tipo 10 porque ESTE es el
// comportamiento estandar esperado, no un colchon corto por las dudas.
const DEFAULT_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// plan: fila de `plans` (base_price_usd, price_per_employee_usd,
// min_billed_employees, discount_*_pct). employeeCount: resultado de
// countBillableEmployees. billingPeriod: 'monthly'|'quarterly'|'semiannual'|'annual'.
function computeInvoiceAmount({ plan, employeeCount, billingPeriod }) {
  const months = PERIOD_MONTHS[billingPeriod] || 1;
  const billedEmployees = Math.max(Number(employeeCount) || 0, Number(plan.min_billed_employees));
  const monthlyUsd = Number(plan.base_price_usd) + billedEmployees * Number(plan.price_per_employee_usd);

  const discountPct = billingPeriod === 'quarterly' ? Number(plan.discount_quarterly_pct)
    : billingPeriod === 'semiannual' ? Number(plan.discount_semiannual_pct)
    : billingPeriod === 'annual' ? Number(plan.discount_annual_pct)
    : 0;

  const grossUsd = monthlyUsd * months;
  const totalUsd = grossUsd * (1 - discountPct / 100);

  return {
    billedEmployees,
    monthlyUsd: round2(monthlyUsd),
    months,
    discountPct,
    grossUsd: round2(grossUsd),
    totalUsd: round2(totalUsd)
  };
}

// status/currentPeriodEnd: columnas de tenant_subscriptions.
// gracePeriodDays: override puntual de la empresa (o null -> usa el
// default global). today: inyectable para poder testear sin depender del
// reloj real.
//
// 'trial' (primer mes gratis) NO es un estado "para siempre" exento de
// fechas -- tiene su propio current_period_end (signup + 1 mes) y, al
// vencer, sigue EXACTAMENTE el mismo camino que 'active': grace (el mes de
// margen para pagar, "al mes vencido") y despues readonly si no se pago.
// Solo 'canceled' (corte MANUAL, lo pone un superadmin a mano) ignora las
// fechas -- por eso sigue siendo el unico return temprano.
function resolveEffectiveStatus({ status, currentPeriodEnd, gracePeriodDays, defaultGraceDays, today }) {
  if (status === 'canceled') return status;
  if (!currentPeriodEnd) return status; // sin fecha de vencimiento cargada -- se respeta el status guardado

  const graceDays = gracePeriodDays != null ? Number(gracePeriodDays) : (defaultGraceDays != null ? Number(defaultGraceDays) : DEFAULT_GRACE_DAYS);
  const end = currentPeriodEnd instanceof Date ? currentPeriodEnd : new Date(currentPeriodEnd);
  const graceEnd = new Date(end.getTime() + graceDays * DAY_MS);
  const now = today instanceof Date ? today : (today ? new Date(today) : new Date());

  if (now <= end) return status === 'trial' ? 'trial' : 'active';
  if (now <= graceEnd) return 'grace';
  return 'readonly';
}

// 'readonly' (automatico, se vencio el periodo de gracia): bloquea SOLO
// subir fichajes y crear empleados nuevos -- el resto (ver reportes,
// exportar, justificar, etc.) sigue andando. 'grace' sigue funcionando
// full (solo muestra el cartel), 'trial' funciona full.
function isWriteBlocked(effectiveStatus) {
  return effectiveStatus === 'readonly';
}

// 'canceled' (SOLO manual -- un superadmin lo pone a mano cuando la
// empresa dejo de pagar del todo, no pasa nunca solo): corta el acceso
// entero, para cualquier ruta, no solo las de alta. Distinto de
// 'readonly', que es automatico y mas suave (sigue funcionando para
// consultar). Ver requireActiveSubscription en appUserMiddleware.js.
function isFullyBlocked(effectiveStatus) {
  return effectiveStatus === 'canceled';
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  computeInvoiceAmount,
  resolveEffectiveStatus,
  isWriteBlocked,
  isFullyBlocked
};
