// Repositorio de facturacion (Fase 9, venta): plans, tenant_subscriptions,
// payment_records. Separado de billingCalculations.js (funciones puras) --
// aca vive todo lo que toca la base.

// El conteo que importa para facturar: SIEMPRE `employees`, nunca `users`
// (fichajes crudos del reloj -- ver la nota grande en billingCalculations.js).
// Mismo criterio de "activo" que ya usa /api/labor-engine/admin/employees.
async function countBillableEmployees(tenantId, db) {
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND (activo = 1 OR activo IS NULL)`,
    [tenantId]
  );
  return row.c;
}

async function getPlans(db, { activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE active = 1' : '';
  const [rows] = await db.query(`SELECT * FROM plans ${where} ORDER BY is_default DESC, id ASC`);
  return rows;
}

async function getPlanById(id, db) {
  const [[row]] = await db.query(`SELECT * FROM plans WHERE id = ?`, [id]);
  return row || null;
}

async function getDefaultPlan(db) {
  const [[row]] = await db.query(`SELECT * FROM plans WHERE is_default = 1 LIMIT 1`);
  return row || null;
}

async function createPlan(data, db) {
  const [result] = await db.query(
    `INSERT INTO plans (name, base_price_usd, price_per_employee_usd, min_billed_employees,
       discount_quarterly_pct, discount_semiannual_pct, discount_annual_pct, active, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name, data.base_price_usd, data.price_per_employee_usd, data.min_billed_employees,
      data.discount_quarterly_pct, data.discount_semiannual_pct, data.discount_annual_pct,
      data.active ? 1 : 0, data.is_default ? 1 : 0
    ]
  );
  if (data.is_default) {
    await db.query(`UPDATE plans SET is_default = 0 WHERE id != ?`, [result.insertId]);
  }
  return result.insertId;
}

async function updatePlan(id, data, db) {
  await db.query(
    `UPDATE plans SET name = ?, base_price_usd = ?, price_per_employee_usd = ?, min_billed_employees = ?,
       discount_quarterly_pct = ?, discount_semiannual_pct = ?, discount_annual_pct = ?, active = ?, is_default = ?
     WHERE id = ?`,
    [
      data.name, data.base_price_usd, data.price_per_employee_usd, data.min_billed_employees,
      data.discount_quarterly_pct, data.discount_semiannual_pct, data.discount_annual_pct,
      data.active ? 1 : 0, data.is_default ? 1 : 0, id
    ]
  );
  if (data.is_default) {
    await db.query(`UPDATE plans SET is_default = 0 WHERE id != ?`, [id]);
  }
}

async function getSubscriptionByTenant(tenantId, db) {
  const [[row]] = await db.query(
    `SELECT s.*, p.name AS plan_name, p.base_price_usd, p.price_per_employee_usd, p.min_billed_employees,
            p.discount_quarterly_pct, p.discount_semiannual_pct, p.discount_annual_pct, t.name AS tenant_name
     FROM tenant_subscriptions s
     JOIN plans p ON p.id = s.plan_id
     JOIN tenants t ON t.id = s.tenant_id
     WHERE s.tenant_id = ?`,
    [tenantId]
  );
  return row || null;
}

async function getAllSubscriptions(db) {
  const [rows] = await db.query(
    `SELECT s.*, p.name AS plan_name, t.name AS tenant_name
     FROM tenant_subscriptions s
     JOIN plans p ON p.id = s.plan_id
     JOIN tenants t ON t.id = s.tenant_id
     ORDER BY t.name ASC`
  );
  return rows;
}

// Alta o reemplazo completo de la suscripcion de una empresa -- una fila
// por tenant (UNIQUE KEY uniq_tenant_subscription), asi que upsert.
async function upsertSubscription(tenantId, data, db) {
  await db.query(
    `INSERT INTO tenant_subscriptions
       (tenant_id, plan_id, billing_period, status, payment_method, mercadopago_subscription_id,
        current_period_start, current_period_end, grace_period_days, grace_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       plan_id = VALUES(plan_id), billing_period = VALUES(billing_period), status = VALUES(status),
       payment_method = VALUES(payment_method), mercadopago_subscription_id = VALUES(mercadopago_subscription_id),
       current_period_start = VALUES(current_period_start), current_period_end = VALUES(current_period_end),
       grace_period_days = VALUES(grace_period_days), grace_message = VALUES(grace_message),
       updated_at = CURRENT_TIMESTAMP`,
    [
      tenantId, data.plan_id, data.billing_period || 'monthly', data.status || 'trial',
      data.payment_method || 'manual', data.mercadopago_subscription_id || null,
      data.current_period_start || null, data.current_period_end || null,
      data.grace_period_days ?? null, data.grace_message || null
    ]
  );
}

async function updateSubscriptionStatus(tenantId, status, db) {
  await db.query(`UPDATE tenant_subscriptions SET status = ? WHERE tenant_id = ?`, [status, tenantId]);
}

// Registrar un pago (manual o MercadoPago) y extender el periodo vigente a
// partir de la fecha de vencimiento actual (o de hoy si ya estaba vencida)
// -- para que pagar tarde no "regale" los dias de atraso.
async function recordPayment({ tenantId, amountUsd, amountLocal, localCurrency, method, reference, periodStart, periodEnd, recordedBy }, db) {
  const [result] = await db.query(
    `INSERT INTO payment_records (tenant_id, amount_usd, amount_local, local_currency, method, reference, period_start, period_end, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, amountUsd, amountLocal || null, localCurrency || 'ARS', method, reference || null, periodStart, periodEnd, recordedBy || null]
  );
  await db.query(
    `UPDATE tenant_subscriptions
     SET status = 'active', current_period_start = ?, current_period_end = ?, last_payment_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [periodStart, periodEnd, tenantId]
  );
  return result.insertId;
}

async function getPaymentHistory(tenantId, db) {
  const [rows] = await db.query(
    `SELECT * FROM payment_records WHERE tenant_id = ? ORDER BY period_start DESC`,
    [tenantId]
  );
  return rows;
}

// Fase 10 -- panel de Pagos del cliente + baja autogestionada.

// El cliente pide la baja desde su propio panel -- NO cancela nada todavia,
// solo deja constancia del pedido. `status` no se toca aca a proposito
// (ver approveCancellation).
async function requestCancellation(tenantId, appUserId, db) {
  await db.query(
    `UPDATE tenant_subscriptions SET cancellation_requested_at = NOW(), cancellation_requested_by = ? WHERE tenant_id = ?`,
    [appUserId, tenantId]
  );
}

// Usado en dos casos distintos: el cliente se arrepiente y retira su propio
// pedido, o el superadmin lo rechaza (le pide que siga pagando en vez de
// aprobar la baja) -- en ambos casos el efecto es el mismo, solo se borra
// la marca de "pedido pendiente", sin tocar el status.
async function clearCancellationRequest(tenantId, db) {
  await db.query(
    `UPDATE tenant_subscriptions SET cancellation_requested_at = NULL, cancellation_requested_by = NULL WHERE tenant_id = ?`,
    [tenantId]
  );
}

// El superadmin aprueba la baja -- reusa updateSubscriptionStatus para el
// bloqueo real, pero A PROPOSITO no limpia cancellation_requested_at:
// queda como marca historica de que este bloqueo vino de un pedido propio
// del cliente (y no de una pausa por falta de pago), para que /pagos
// pueda mostrar el mensaje correcto en cada caso sin una columna aparte.
async function approveCancellation(tenantId, db) {
  await db.query(`UPDATE tenant_subscriptions SET status = 'canceled' WHERE tenant_id = ?`, [tenantId]);
}

// El link que genera el superadmin (payment-dialog.ts) antes no se
// guardaba en ningun lado -- se mostraba una sola vez en el dialogo y se
// perdia. Se persiste aca para que el cliente lo pueda ver despues desde
// /pagos. El periodo elegido se guarda aparte, en el mismo upsertSubscription
// que ya corre justo antes de esto (ver routes/billing.js) -- no se duplica
// aca.
async function recordCheckoutLink(tenantId, checkoutUrl, db) {
  await db.query(
    `UPDATE tenant_subscriptions SET last_checkout_url = ?, last_checkout_generated_at = NOW() WHERE tenant_id = ?`,
    [checkoutUrl, tenantId]
  );
}

module.exports = {
  countBillableEmployees,
  getPlans,
  getPlanById,
  getDefaultPlan,
  createPlan,
  updatePlan,
  getSubscriptionByTenant,
  getAllSubscriptions,
  upsertSubscription,
  updateSubscriptionStatus,
  recordPayment,
  getPaymentHistory,
  requestCancellation,
  clearCancellationRequest,
  approveCancellation,
  recordCheckoutLink
};
