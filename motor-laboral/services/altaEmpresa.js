// ============================================================================
// Aprobar una SOLICITUD DE ALTA (signup_leads) y crear la empresa
// ============================================================================
//
// Decision del dueño del producto (2026-10-01): cualquiera se puede registrar
// en la pagina, pero NADA se activa hasta que el superadmin lo apruebe,
// despues de hablar con la persona. El formulario publico solo guarda la
// solicitud (routes/public.js); esto es lo que corre al aprobarla.
//
// Hace lo mismo que antes hacia el alta automatica, en el mismo orden:
//   1. empresa (tenants)
//   2. mes de prueba con el plan por defecto
//   3. usuario "Administrador de Empresa", que queda como TITULAR (quien paga
//      y el unico que puede pedir la baja)
//   4. Firebase le manda el mail para poner su contraseña
// Los datos los puede corregir el superadmin al aprobar (nombre de la
// empresa, mail), por si en la charla le dieron otros.
const billingRepository = require('../repositories/billingRepository');
const appUserRepository = require('../repositories/appUserRepository');
const { computeFreeTrialPeriod } = require('./billingCalculations');
const { enviarEmailDeContrasena } = require('./firebaseEmail');

const ACENTOS = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n' };
function slugify(str) {
  const sin = String(str).toLowerCase().split('').map((ch) => ACENTOS[ch] || ch).join('');
  return sin.replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40) || 'empresa';
}
const sufijo = () => Math.random().toString(36).slice(2, 8);

class ErrorDeAlta extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

/**
 * @returns {Promise<{tenantId:number, email:string, emailEnviado:boolean}>}
 */
async function aprobarSolicitud(db, leadId, { companyName, email } = {}, revisadoPor = null) {
  const [[lead]] = await db.query('SELECT * FROM signup_leads WHERE id = ?', [leadId]);
  if (!lead) throw new ErrorDeAlta(404, 'Solicitud no encontrada');
  if (lead.status !== 'pending') throw new ErrorDeAlta(409, 'Esa solicitud ya fue resuelta');

  const empresa = String(companyName || lead.company_name).trim();
  const mail = String(email || lead.email).trim().toLowerCase();
  if (!empresa) throw new ErrorDeAlta(400, 'Falta el nombre de la empresa');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new ErrorDeAlta(400, 'El mail no parece válido');
  const [[yaExiste]] = await db.query('SELECT id FROM app_users WHERE LOWER(email) = ?', [mail]);
  if (yaExiste) throw new ErrorDeAlta(409, 'Ese mail ya tiene una cuenta en el sistema.');

  const plan = await billingRepository.getDefaultPlan(db);
  if (!plan) throw new ErrorDeAlta(503, 'No hay un plan por defecto configurado');

  const [t] = await db.query('INSERT INTO tenants (name, code) VALUES (?, ?)', [empresa, `${slugify(empresa)}-${sufijo()}`]);
  const tenantId = t.insertId;
  try {
    const { periodStart, periodEnd } = computeFreeTrialPeriod();
    await billingRepository.upsertSubscription(tenantId,
      { plan_id: plan.id, status: 'trial', current_period_start: periodStart, current_period_end: periodEnd }, db);
    const [[rol]] = await db.query(`SELECT id FROM roles WHERE name = 'Administrador de Empresa' AND is_system = 1`);
    await appUserRepository.createInvitedUser({ email: mail, tenantId, isSuperadmin: false, roleId: rol ? rol.id : null }, db);
    await db.query('UPDATE tenants SET titular_email = ? WHERE id = ?', [mail, tenantId]);
    await db.query(
      `UPDATE signup_leads SET status = 'provisioned', tenant_id = ?, company_name = ?, email = ?, reviewed_by = ?, reviewed_at = NOW()
       WHERE id = ?`, [tenantId, empresa, mail, revisadoPor, leadId]);
  } catch (err) {
    // Que no quede una empresa a medio crear: se deshace lo creado y se anota
    // el motivo en la solicitud, que sigue pendiente (se puede reintentar).
    const deshacer = async (sql) => db.query(sql, [tenantId]).catch(() => {});
    await deshacer('DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM app_users WHERE tenant_id = ?)');
    await deshacer('DELETE FROM app_users WHERE tenant_id = ?');
    await deshacer('DELETE FROM tenant_subscriptions WHERE tenant_id = ?');
    await deshacer('DELETE FROM tenants WHERE id = ?');
    await db.query('UPDATE signup_leads SET error_message = ? WHERE id = ?', [String(err.message).slice(0, 1000), leadId]).catch(() => {});
    throw err;
  }
  const envio = await enviarEmailDeContrasena(mail);
  if (!envio.enviado && envio.motivo !== 'dominio de prueba') {
    await db.query('UPDATE signup_leads SET error_message = ? WHERE id = ?',
      [`Empresa creada, pero no se pudo mandar el mail de contraseña: ${String(envio.motivo).slice(0, 500)}`, leadId]);
  }
  return { tenantId, email: mail, emailEnviado: envio.enviado };
}

async function rechazarSolicitud(db, leadId, motivo, revisadoPor = null) {
  const [[lead]] = await db.query('SELECT status FROM signup_leads WHERE id = ?', [leadId]);
  if (!lead) throw new ErrorDeAlta(404, 'Solicitud no encontrada');
  if (lead.status !== 'pending') throw new ErrorDeAlta(409, 'Esa solicitud ya fue resuelta');
  await db.query(
    `UPDATE signup_leads SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
    [String(motivo).slice(0, 500), revisadoPor, leadId]);
}

module.exports = { aprobarSolicitud, rechazarSolicitud, ErrorDeAlta };
