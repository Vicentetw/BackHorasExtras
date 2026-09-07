const express = require('express');
const rateLimit = require('express-rate-limit');
const billingRepository = require('../motor-laboral/repositories/billingRepository');
const { computeFreeTrialPeriod } = require('../motor-laboral/services/billingCalculations');
const appUserRepository = require('../motor-laboral/repositories/appUserRepository');
const { verifyTurnstileToken } = require('../motor-laboral/services/turnstileService');
const { askSalesChat } = require('../motor-laboral/services/salesChatService');

// Fase 11: landing publica + alta de cliente autoservicio + chatbot de
// ventas. UNICA superficie del sistema alcanzable sin ninguna credencial
// (ver security.js, publicPaths) -- por eso el rate-limit propio, mas
// estricto que el global de 300/min (security.js), y la verificacion de
// Turnstile en el alta.
const CHAT_QUESTION_LIMIT = 6;

// Mas estricto que el rate-limit global (300/min): esta es la unica ruta
// del sistema que cualquiera en internet puede llamar sin ninguna cuenta.
const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, esperá un momento y probá de nuevo.' }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados mensajes, esperá un momento y probá de nuevo.' }
});

// Reemplazo manual en vez de una regex de rango unicode para sacar acentos
// (mas simple y sin ambiguedad de encoding que ̀-ͯ sobre NFD) --
// alcanza y sobra para nombres de empresa en español.
const ACCENTS = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n' };

function slugify(str) {
  const noAccents = String(str)
    .toLowerCase()
    .split('')
    .map((ch) => ACCENTS[ch] || ch)
    .join('');
  return noAccents.replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40) || 'empresa';
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

module.exports = function (db) {
  const router = express.Router();

  // Alta autoservicio: arma tenant + suscripcion trial (plan por defecto,
  // 1er mes gratis) + usuario admin, TODO de una, sin que un superadmin
  // intervenga. Reusa upsertSubscription/getDefaultPlan/createInvitedUser
  // -- no reimplementa nada de lo que ya existe para el alta manual.
  router.post('/signup', signupLimiter, async (req, res) => {
    const { turnstileToken, name, companyName, email, phone, contactPreference, employeeCount, clockCount, scheduleType } = req.body;

    if (!name || !companyName || !email) {
      return res.status(400).json({ error: 'name, companyName y email son requeridos' });
    }

    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) {
      return res.status(503).json({ error: 'TURNSTILE_SECRET_KEY no está configurado en el servidor' });
    }

    try {
      const captcha = await verifyTurnstileToken({ token: turnstileToken, remoteIp: req.ip, secretKey });
      if (!captcha.success) {
        return res.status(400).json({ error: 'Verificación anti-bot fallida, recargá la página e intentá de nuevo.' });
      }

      // Chequeo temprano -- evita crear un tenant huerfano si el email ya
      // tiene cuenta (createInvitedUser tambien lo valida, pero mas tarde,
      // despues de ya haber creado tenant+suscripcion).
      const [[existingUser]] = await db.query('SELECT id FROM app_users WHERE email = ?', [email]);
      if (existingUser) {
        return res.status(409).json({ error: 'Ese email ya tiene una cuenta en el sistema.' });
      }

      const [leadResult] = await db.query(
        `INSERT INTO signup_leads (name, company_name, email, phone, contact_preference, employee_count, clock_count, schedule_type, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          name,
          companyName,
          email,
          phone || null,
          contactPreference || 'whatsapp',
          employeeCount || null,
          clockCount || null,
          scheduleType || null
        ]
      );
      const leadId = leadResult.insertId;

      try {
        const code = `${slugify(companyName)}-${randomSuffix()}`;
        const [tenantResult] = await db.query(`INSERT INTO tenants (name, code) VALUES (?, ?)`, [companyName, code]);
        const tenantId = tenantResult.insertId;

        const plan = await billingRepository.getDefaultPlan(db);
        if (!plan) throw new Error('No hay un plan por defecto configurado');

        const { periodStart, periodEnd } = computeFreeTrialPeriod();
        await billingRepository.upsertSubscription(
          tenantId,
          { plan_id: plan.id, status: 'trial', current_period_start: periodStart, current_period_end: periodEnd },
          db
        );

        const created = await appUserRepository.createInvitedUser({ email, tenantId, isSuperadmin: false }, db);

        await db.query(`UPDATE signup_leads SET tenant_id = ?, status = 'provisioned' WHERE id = ?`, [tenantId, leadId]);

        res.status(201).json({ ok: true, leadId, resetLink: created.resetLink });
      } catch (err) {
        await db.query(`UPDATE signup_leads SET status = 'failed', error_message = ? WHERE id = ?`, [
          String(err.message).slice(0, 1000),
          leadId
        ]);
        throw err;
      }
    } catch (err) {
      console.error('ERROR en alta autoservicio:', err);
      res.status(500).json({ error: 'No se pudo crear la cuenta. Escribinos por WhatsApp y te ayudamos a mano.' });
    }
  });

  // Chat de ventas -- gateado por tener un leadId real (el registro de
  // arriba ya filtro bots via Turnstile, no se le vuelve a pedir captcha
  // por mensaje). Limite de preguntas gratis; pasado el limite, la landing
  // muestra el link de WhatsApp en vez de seguir mandando mensajes aca.
  router.post('/chat', chatLimiter, async (req, res) => {
    try {
      const { leadId, message } = req.body;
      if (!leadId || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'leadId y message son requeridos' });
      }

      const [[lead]] = await db.query('SELECT id, chat_questions_used FROM signup_leads WHERE id = ?', [leadId]);
      if (!lead) return res.status(404).json({ error: 'No se encontró el registro' });

      if (lead.chat_questions_used >= CHAT_QUESTION_LIMIT) {
        return res.json({ limitReached: true, questionsLeft: 0 });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY no está configurado en el servidor' });
      }

      const plan = await billingRepository.getDefaultPlan(db);
      if (!plan) return res.status(503).json({ error: 'No hay un plan configurado' });

      const { reply } = await askSalesChat({ apiKey, plan, userMessage: message });

      await db.query('UPDATE signup_leads SET chat_questions_used = chat_questions_used + 1 WHERE id = ?', [leadId]);

      const questionsLeft = CHAT_QUESTION_LIMIT - (lead.chat_questions_used + 1);
      res.json({ reply, questionsLeft, limitReached: questionsLeft <= 0 });
    } catch (err) {
      console.error('ERROR en chat de ventas:', err);
      res.status(502).json({ error: 'No se pudo responder en este momento.' });
    }
  });

  return router;
};
