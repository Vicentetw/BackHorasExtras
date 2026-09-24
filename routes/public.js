const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const billingRepository = require('../motor-laboral/repositories/billingRepository');
const { computeFreeTrialPeriod } = require('../motor-laboral/services/billingCalculations');
const appUserRepository = require('../motor-laboral/repositories/appUserRepository');
const { verifyTurnstileToken } = require('../motor-laboral/services/turnstileService');
const { askSalesChat } = require('../motor-laboral/services/salesChatService');
const { createCountryFirewallMiddleware } = require('../motor-laboral/middleware/countryFirewallMiddleware');

// Fase 11: landing publica + alta de cliente autoservicio + chatbot de
// ventas. UNICA superficie del sistema alcanzable sin ninguna credencial
// (ver security.js, publicPaths) -- por eso el rate-limit propio, mas
// estricto que el global de 300/min (security.js), y la verificacion de
// Turnstile en el alta.
const CHAT_QUESTION_LIMIT = 6;

// Tope de caracteres por mensaje del chat. Sin esto, el unico limite era el
// 1MB de express.json(): un mensaje de ese tamano se le manda entero a la API
// de Anthropic (se paga por token) y ademas queda guardado en chat_history,
// que se reenvia en cada mensaje siguiente. Una pregunta de verdad sobre
// precios o funcionalidades entra de sobra en 2000 caracteres.
const CHAT_MESSAGE_MAX_CHARS = 2000;

// --- Token del chat (hallazgo F-02) -----------------------------------------
// El chat es la unica ruta del sistema que llama a la API de Anthropic y se
// alcanza sin ninguna cuenta. Antes se identificaba con el `leadId` a secas,
// que es AUTO_INCREMENT y por lo tanto adivinable: cualquiera podia recorrer
// ids ajenos y gastar preguntas con NUESTRA clave.
//
// Ahora hace falta ademas un token aleatorio que se entrega una sola vez, al
// crear el lead. En la base se guarda solo su SHA-256 -- mismo criterio que
// tenant_agent_keys: si se filtra un backup, lo que hay adentro no sirve.
function generarChatToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashChatToken(token) };
}

function hashChatToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Comparacion en tiempo constante, igual que verifyAgentKey. Con 256 bits de
// entropia un timing attack no es realista, pero no cuesta nada y evita tener
// que razonar cada vez si "este caso si importa".
function tokenCoincide(recibido, hashGuardado) {
  if (!recibido || !hashGuardado) return false;
  const a = Buffer.from(hashChatToken(recibido), 'hex');
  const b = Buffer.from(String(hashGuardado), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

  // Filtro por pais/IP -- ver countryFirewallMiddleware.js. Antes que
  // nada mas: no tiene sentido gastar el rate-limit o pegarle a
  // Turnstile por un pedido que ya se va a rechazar igual.
  router.use(createCountryFirewallMiddleware(db));

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

      // El token del chat se crea junto con el lead y se devuelve UNA sola
      // vez, mas abajo. En la base queda solo el hash.
      const chat = generarChatToken();

      const [leadResult] = await db.query(
        `INSERT INTO signup_leads (name, company_name, email, phone, contact_preference, employee_count, clock_count, schedule_type, status, chat_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          name,
          companyName,
          email,
          phone || null,
          contactPreference || 'whatsapp',
          employeeCount || null,
          clockCount || null,
          scheduleType || null,
          chat.hash
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

        res.status(201).json({ ok: true, leadId, chatToken: chat.token, resetLink: created.resetLink });
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
      const { leadId, chatToken, message } = req.body;
      if (!leadId || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'leadId y message son requeridos' });
      }

      if (String(message).length > CHAT_MESSAGE_MAX_CHARS) {
        return res.status(400).json({
          error: `El mensaje es demasiado largo (máximo ${CHAT_MESSAGE_MAX_CHARS} caracteres).`
        });
      }

      const [[lead]] = await db.query(
        'SELECT id, chat_questions_used, chat_history, chat_token_hash FROM signup_leads WHERE id = ?', [leadId]);

      // La MISMA respuesta para "ese lead no existe" y "el token no es el de
      // ese lead". Distinguirlos convertiria esto en un oraculo para saber
      // que ids existen, que es justo el primer paso del ataque que este
      // chequeo viene a cerrar.
      if (!lead || !tokenCoincide(chatToken, lead.chat_token_hash)) {
        return res.status(403).json({ error: 'No se pudo validar la sesión del chat. Recargá la página.' });
      }

      if (lead.chat_questions_used >= CHAT_QUESTION_LIMIT) {
        return res.json({ limitReached: true, questionsLeft: 0 });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY no está configurado en el servidor' });
      }

      const plan = await billingRepository.getDefaultPlan(db);
      if (!plan) return res.status(503).json({ error: 'No hay un plan configurado' });

      // Bug real: antes cada mensaje se mandaba SOLO, sin los anteriores --
      // el modelo no tenia forma de entender un "si" respondiendo a su
      // propia pregunta. El historial de ESTE lead se persiste aca mismo
      // (JSON, acotado solo por CHAT_QUESTION_LIMIT).
      const history = Array.isArray(lead.chat_history) ? lead.chat_history : [];
      const { reply } = await askSalesChat({ apiKey, plan, history, userMessage: message });
      const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];

      await db.query(
        'UPDATE signup_leads SET chat_questions_used = chat_questions_used + 1, chat_history = ? WHERE id = ?',
        [JSON.stringify(updatedHistory), leadId]
      );

      const questionsLeft = CHAT_QUESTION_LIMIT - (lead.chat_questions_used + 1);
      res.json({ reply, questionsLeft, limitReached: questionsLeft <= 0 });
    } catch (err) {
      console.error('ERROR en chat de ventas:', err);
      res.status(502).json({ error: 'No se pudo responder en este momento.' });
    }
  });

  return router;
};
