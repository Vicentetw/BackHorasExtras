// Fase 9 (venta): funciones puras de facturacion -- computeInvoiceAmount
// (cuanto se le cobra a una empresa) y resolveEffectiveStatus (en que
// estado esta la suscripcion HOY segun la fecha de vencimiento, sin
// depender de un cron que actualice un flag). Sin DB, sin backend levantado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_GRACE_DAYS,
  computeInvoiceAmount,
  resolveEffectiveStatus,
  isWriteBlocked,
  isFullyBlocked
} = require('../motor-laboral/services/billingCalculations');

const BASE_PLAN = {
  base_price_usd: 18,
  price_per_employee_usd: 2.2,
  min_billed_employees: 5,
  discount_quarterly_pct: 5,
  discount_semiannual_pct: 10,
  discount_annual_pct: 17
};

test('computeInvoiceAmount: empresa chica (menos que el minimo) se factura al piso', () => {
  const r = computeInvoiceAmount({ plan: BASE_PLAN, employeeCount: 2, billingPeriod: 'monthly' });
  assert.equal(r.billedEmployees, 5, 'se factura como si tuviera 5, no 2');
  assert.equal(r.monthlyUsd, 18 + 5 * 2.2);
  assert.equal(r.months, 1);
  assert.equal(r.discountPct, 0);
  assert.equal(r.totalUsd, r.monthlyUsd);
});

test('computeInvoiceAmount: empresa grande (mas que el minimo) se factura por cantidad real', () => {
  const r = computeInvoiceAmount({ plan: BASE_PLAN, employeeCount: 40, billingPeriod: 'monthly' });
  assert.equal(r.billedEmployees, 40);
  assert.equal(r.monthlyUsd, 18 + 40 * 2.2);
});

test('computeInvoiceAmount: trimestral aplica el descuento del plan sobre 3 meses', () => {
  const r = computeInvoiceAmount({ plan: BASE_PLAN, employeeCount: 10, billingPeriod: 'quarterly' });
  const monthly = 18 + 10 * 2.2;
  assert.equal(r.months, 3);
  assert.equal(r.grossUsd, Math.round(monthly * 3 * 100) / 100);
  assert.equal(r.totalUsd, Math.round(monthly * 3 * 0.95 * 100) / 100);
});

test('computeInvoiceAmount: anual aplica el mayor descuento', () => {
  const r = computeInvoiceAmount({ plan: BASE_PLAN, employeeCount: 10, billingPeriod: 'annual' });
  const monthly = 18 + 10 * 2.2;
  assert.equal(r.months, 12);
  assert.equal(r.discountPct, 17);
  assert.equal(r.totalUsd, Math.round(monthly * 12 * 0.83 * 100) / 100);
});

test('resolveEffectiveStatus: canceled se respeta tal cual, sin mirar fechas (corte manual)', () => {
  assert.equal(resolveEffectiveStatus({ status: 'canceled', currentPeriodEnd: '2030-01-01', defaultGraceDays: 10, today: '2026-01-01' }), 'canceled');
  assert.equal(resolveEffectiveStatus({ status: 'canceled', currentPeriodEnd: '2020-01-01', defaultGraceDays: 10, today: '2026-01-01' }), 'canceled');
});

test('resolveEffectiveStatus: "trial" (primer mes gratis) dentro de su periodo sigue siendo trial', () => {
  const r = resolveEffectiveStatus({ status: 'trial', currentPeriodEnd: '2026-09-30', defaultGraceDays: 30, today: '2026-09-15' });
  assert.equal(r, 'trial');
});

test('resolveEffectiveStatus: "trial" vencido sigue el MISMO camino que active -- grace ("pagar al mes vencido")', () => {
  const r = resolveEffectiveStatus({ status: 'trial', currentPeriodEnd: '2026-09-01', defaultGraceDays: 30, today: '2026-09-10' });
  assert.equal(r, 'grace', 'el mes gratis no es "para siempre" -- al vencer entra al mismo circuito de gracia que cualquier otro');
});

test('resolveEffectiveStatus: "trial" vencido y pasado el mes de gracia -> readonly, igual que active', () => {
  const r = resolveEffectiveStatus({ status: 'trial', currentPeriodEnd: '2026-08-01', defaultGraceDays: 30, today: '2026-09-05' });
  assert.equal(r, 'readonly');
});

test('resolveEffectiveStatus: sin fecha de vencimiento cargada, se respeta el status guardado', () => {
  assert.equal(resolveEffectiveStatus({ status: 'active', currentPeriodEnd: null, defaultGraceDays: 10, today: '2026-01-01' }), 'active');
});

test('resolveEffectiveStatus: antes del vencimiento -> active', () => {
  const r = resolveEffectiveStatus({ status: 'active', currentPeriodEnd: '2026-09-30', defaultGraceDays: 10, today: '2026-09-15' });
  assert.equal(r, 'active');
});

test('resolveEffectiveStatus: vencida pero dentro del periodo de gracia -> grace', () => {
  const r = resolveEffectiveStatus({ status: 'active', currentPeriodEnd: '2026-09-01', defaultGraceDays: 10, today: '2026-09-05' });
  assert.equal(r, 'grace');
});

test('resolveEffectiveStatus: vencida y pasado el periodo de gracia -> readonly', () => {
  const r = resolveEffectiveStatus({ status: 'active', currentPeriodEnd: '2026-09-01', defaultGraceDays: 10, today: '2026-09-20' });
  assert.equal(r, 'readonly');
});

test('resolveEffectiveStatus: el periodo de gracia de la empresa pisa el default global', () => {
  // Empresa con SOLO 2 dias de gracia configurados -- al dia 5 ya deberia
  // estar en readonly aunque el default global sea 10.
  const r = resolveEffectiveStatus({ status: 'active', currentPeriodEnd: '2026-09-01', gracePeriodDays: 2, defaultGraceDays: 10, today: '2026-09-05' });
  assert.equal(r, 'readonly');
});

test('resolveEffectiveStatus: usa DEFAULT_GRACE_DAYS si no se pasa defaultGraceDays', () => {
  const end = new Date();
  end.setDate(end.getDate() - (DEFAULT_GRACE_DAYS - 1));
  const r = resolveEffectiveStatus({ status: 'active', currentPeriodEnd: end });
  assert.equal(r, 'grace');
});

test('isWriteBlocked: solo readonly bloquea, grace y active no', () => {
  assert.equal(isWriteBlocked('readonly'), true);
  assert.equal(isWriteBlocked('grace'), false);
  assert.equal(isWriteBlocked('active'), false);
  assert.equal(isWriteBlocked('trial'), false);
  assert.equal(isWriteBlocked('free'), false);
});

// Pedido del usuario 2026-09-06: modo "free" para empresas que nunca se
// facturan (uso interno/particular, ej. AVP) -- a diferencia de 'trial',
// ignora las fechas para siempre, no solo el primer mes.
test('resolveEffectiveStatus: "free" nunca se bloquea, sin importar que tan vencida este la fecha', () => {
  assert.equal(resolveEffectiveStatus({ status: 'free', currentPeriodEnd: '2020-01-01', defaultGraceDays: 10, today: '2026-01-01' }), 'free');
  assert.equal(resolveEffectiveStatus({ status: 'free', currentPeriodEnd: null, today: '2026-01-01' }), 'free');
});

test('isWriteBlocked/isFullyBlocked: "free" no bloquea nada, ni escritura ni acceso entero', () => {
  assert.equal(isWriteBlocked('free'), false);
  assert.equal(isFullyBlocked('free'), false);
});
