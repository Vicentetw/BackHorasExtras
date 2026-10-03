const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const billingRepository = require('../motor-laboral/repositories/billingRepository');
const avisos = require('../avisos');
const { verifyTurnstileToken } = require('../motor-laboral/services/turnstileService');
const { askSalesChat, tratoInapropiado, RESPUESTA_SEGURA } = require('../motor-laboral/services/salesChatService');
const { consumirMensaje } = require('../motor-laboral/services/presupuestoChat');
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

// ---------------------------------------------------------------------------
// LIMITES PROPIOS de la parte publica
// ---------------------------------------------------------------------------
// Esta es la unica superficie del sistema que cualquiera en internet puede
// llamar sin cuenta, y comparte servidor y base con los clientes que pagan.
// Por eso tiene topes propios y mas duros que el resto: si alguien la
// bombardea, se corta ELLA y no Presentismo.
//   por minuto  -> frena rafagas
//   por dia     -> frena al que insiste despacio
// (los valores por dia se pueden subir por variable de entorno: los tests
// corren muchas veces desde la misma maquina.)
const numeroDeEntorno = (nombre, porDefecto) => {
  const n = Number(process.env[nombre]);
  return Number.isInteger(n) && n > 0 ? n : porDefecto;
};
const UN_DIA = 24 * 60 * 60 * 1000;

const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, esperá un momento y probá de nuevo.' }
});
const signupPorDia = rateLimit({
  windowMs: UN_DIA,
  limit: numeroDeEntorno('SIGNUP_TOPE_DIARIO_POR_IP', 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Ya recibimos varias solicitudes desde esta conexión. Escribinos por WhatsApp.' }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados mensajes, esperá un momento y probá de nuevo.' }
});
const chatPorDia = rateLimit({
  windowMs: UN_DIA,
  limit: numeroDeEntorno('CHAT_TOPE_DIARIO_POR_IP', 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Llegaste al límite de mensajes por hoy. Seguimos por WhatsApp.' }
});

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Todo lo que escribe un desconocido se recorta al largo de su columna.
const recortar = (v, max) => String(v ?? '').trim().slice(0, max);
const enteroPositivo = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1000000 ? n : null;
};

// Marca interna de "este mail ya tenia cuenta". NUNCA sale en la respuesta.
const NOTA_YA_TIENE_CUENTA = 'Ya tiene cuenta: la solicitud no tiene efecto (no se creo nada ni se mando ningun mail).';

// El cupo de preguntas se cuenta por MAIL, no por envio del formulario:
// refrescar la pagina o reenviar el formulario no lo reinicia.
const DIAS_DEL_CUPO = 30;

module.exports = function (db) {
  const router = express.Router();

  // Filtro por pais/IP -- ver countryFirewallMiddleware.js. Antes que
  // nada mas: no tiene sentido gastar el rate-limit o pegarle a
  // Turnstile por un pedido que ya se va a rechazar igual.
  router.use(createCountryFirewallMiddleware(db));

  // Reportes de la politica de seguridad (CSP) del frontend: ver cspReport.js.
  router.use('/csp-report', require('./cspReport').router);

  // ALTA: SOLO guarda la SOLICITUD y le avisa al superadmin (Telegram +
  // campanita). Decision del dueño del producto (2026-10-01): nada se activa
  // hasta que el superadmin la apruebe despues de hablar con la persona
  // (routes/solicitudesAlta.js -> motor-laboral/services/altaEmpresa.js).
  // Antes este endpoint creaba empresa, prueba y usuario al instante.
  //
  // Reglas de seguridad:
  //   * la respuesta es IDENTICA para un mail nuevo y para uno que ya tiene
  //     cuenta (F-04): el formulario no sirve para averiguar quien es cliente.
  //     La landing le muestra a todos el mismo texto, que incluye "si ya
  //     tenes cuenta, esta solicitud no tiene efecto";
  //   * no se manda NINGUN mail automatico: antes se mandaba el de recuperar
  //     contraseña, y eso dejaba que cualquiera le hiciera llegar mails
  //     nuestros a un tercero;
  //   * una sola solicitud "viva" por mail: reenviar el formulario actualiza
  //     la que ya existe, no crea otra (ni otro aviso, ni otro cupo de chat).
  router.post('/signup', signupPorDia, signupLimiter, async (req, res) => {
    const b = req.body || {};
    const name = recortar(b.name, 150);
    const companyName = recortar(b.companyName, 150);
    const email = recortar(b.email, 255).toLowerCase();
    const phone = recortar(b.phone, 50) || null;
    const contactPreference = ['whatsapp', 'llamada', 'email'].includes(b.contactPreference) ? b.contactPreference : 'whatsapp';
    const employeeCount = enteroPositivo(b.employeeCount);
    const clockCount = enteroPositivo(b.clockCount);
    const scheduleType = recortar(b.scheduleType, 255) || null;

    if (!name || !companyName || !email) {
      return res.status(400).json({ error: 'name, companyName y email son requeridos' });
    }
    if (!EMAIL_VALIDO.test(email)) {
      return res.status(400).json({ error: 'El mail no parece válido.' });
    }

    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) {
      return res.status(503).json({ error: 'TURNSTILE_SECRET_KEY no está configurado en el servidor' });
    }

    try {
      const captcha = await verifyTurnstileToken({ token: b.turnstileToken, remoteIp: req.ip, secretKey });
      if (!captcha.success) {
        return res.status(400).json({ error: 'Verificación anti-bot fallida, recargá la página e intentá de nuevo.' });
      }

      // El token del chat se crea aca y se devuelve UNA sola vez. En la base
      // queda solo el hash.
      const chat = generarChatToken();

      const [[cuenta]] = await db.query('SELECT id FROM app_users WHERE LOWER(email) = ?', [email]);
      const estado = cuenta ? 'failed' : 'pending';
      const nota = cuenta ? NOTA_YA_TIENE_CUENTA : null;

      // Una sola fila "viva" por mail (y por tipo): si ya hay, se actualiza.
      const [[previa]] = await db.query(
        `SELECT id FROM signup_leads WHERE LOWER(email) = ? AND status = ? AND error_message <=> ? ORDER BY id DESC LIMIT 1`,
        [email, estado, nota]);

      let leadId;
      if (previa) {
        leadId = previa.id;
        await db.query(
          `UPDATE signup_leads SET name = ?, company_name = ?, phone = ?, contact_preference = ?, employee_count = ?,
                  clock_count = ?, schedule_type = ?, chat_token_hash = ? WHERE id = ?`,
          [name, companyName, phone, contactPreference, employeeCount, clockCount, scheduleType, chat.hash, leadId]);
      } else {
        const [r] = await db.query(
          `INSERT INTO signup_leads (name, company_name, email, phone, contact_preference, employee_count, clock_count, schedule_type, status, error_message, chat_token_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, companyName, email, phone, contactPreference, employeeCount, clockCount, scheduleType, estado, nota, chat.hash]);
        leadId = r.insertId;

        // Aviso al superadmin, solo por una solicitud NUEVA de alguien sin
        // cuenta. Nunca rompe el alta (regla de oro de avisos.js).
        if (!cuenta) {
          const preferencia = { whatsapp: 'WhatsApp', llamada: 'llamada', email: 'email' }[contactPreference];
          await avisos.avisar('alta', {
            empresa: companyName,
            detalle: [`${name} · ${email}${phone ? ' · ' + phone : ''}`, `Prefiere: ${preferencia}`,
              employeeCount ? `${employeeCount} empleados` : null, clockCount ? `${clockCount} relojes` : null].filter(Boolean).join('\n'),
          }, db);
        }
      }

      res.status(201).json({ ok: true, leadId, chatToken: chat.token, pendiente: true });
    } catch (err) {
      console.error('ERROR en la solicitud de alta:', err);
      res.status(500).json({ error: 'No se pudo enviar la solicitud. Escribinos por WhatsApp y te ayudamos a mano.' });
    }
  });

  // Valida leadId + token y devuelve la solicitud. La MISMA respuesta para
  // "ese lead no existe" y "el token no es el de ese lead": distinguirlos
  // convertiria esto en un oraculo para saber que ids existen.
  async function leadDelChat(req, res) {
    const { leadId, chatToken } = req.body || {};
    const [[lead]] = leadId ? await db.query(
      'SELECT id, email, chat_questions_used, chat_history, chat_token_hash FROM signup_leads WHERE id = ?', [leadId]) : [[null]];
    if (!lead || !tokenCoincide(chatToken, lead.chat_token_hash)) {
      res.status(403).json({ error: 'No se pudo validar la sesión del chat. Recargá la página.' });
      return null;
    }
    return lead;
  }

  // Preguntas ya usadas por ese MAIL en los ultimos dias (todas sus solicitudes).
  async function preguntasUsadas(lead) {
    const [[uso]] = await db.query(
      `SELECT COALESCE(SUM(chat_questions_used), 0) AS n FROM signup_leads
       WHERE LOWER(email) = LOWER(?) AND created_at >= NOW() - INTERVAL ${DIAS_DEL_CUPO} DAY`, [lead.email]);
    return Math.max(Number(uso.n) || 0, lead.chat_questions_used);
  }

  const historialVisible = (lead) => (Array.isArray(lead.chat_history) ? lead.chat_history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    // Una respuesta vieja con mal trato (anterior al arreglo del 2026-10-01)
    // tampoco se vuelve a mostrar.
    .map((m) => ({ role: m.role, content: m.role === 'assistant' && tratoInapropiado(m.content) ? RESPUESTA_SEGURA : String(m.content) }));

  // Al refrescar la pagina, la landing recupera la conversacion en vez de
  // volver a pedir el formulario (y en vez de regalar otro cupo de preguntas).
  router.post('/chat/estado', chatLimiter, async (req, res) => {
    try {
      const lead = await leadDelChat(req, res);
      if (!lead) return;
      const questionsLeft = Math.max(0, CHAT_QUESTION_LIMIT - await preguntasUsadas(lead));
      res.json({ history: historialVisible(lead), questionsLeft, limitReached: questionsLeft <= 0 });
    } catch (err) {
      console.error('ERROR leyendo el estado del chat:', err);
      res.status(502).json({ error: 'No se pudo recuperar la conversación.' });
    }
  });

  // Chat de ventas -- gateado por tener un leadId real y su token (la
  // solicitud de arriba ya filtro bots via Turnstile). Tres frenos, del mas
  // chico al mas grande: cupo por mail, tope por conexion por dia (chatPorDia)
  // y tope diario global de gasto (presupuestoChat.js).
  router.post('/chat', chatPorDia, chatLimiter, async (req, res) => {
    try {
      const { leadId, message } = req.body || {};
      if (!leadId || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'leadId y message son requeridos' });
      }

      if (String(message).length > CHAT_MESSAGE_MAX_CHARS) {
        return res.status(400).json({
          error: `El mensaje es demasiado largo (máximo ${CHAT_MESSAGE_MAX_CHARS} caracteres).`
        });
      }

      const lead = await leadDelChat(req, res);
      if (!lead) return;

      const usadas = await preguntasUsadas(lead);
      if (usadas >= CHAT_QUESTION_LIMIT) {
        return res.json({ limitReached: true, questionsLeft: 0 });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY no está configurado en el servidor' });
      }

      const plan = await billingRepository.getDefaultPlan(db);
      if (!plan) return res.status(503).json({ error: 'No hay un plan configurado' });

      // Freno de emergencia del gasto: tope diario para toda la pagina.
      const presupuesto = await consumirMensaje(db);
      if (!presupuesto.permitido) {
        return res.json({ limitReached: true, questionsLeft: 0 });
      }
      if (presupuesto.recienAlcanzado) {
        avisos.enviarTelegram(`🚨 El chat de la página llegó al tope diario de ${presupuesto.tope} mensajes. Deja de responder hasta mañana (manda a WhatsApp). Si no es una campaña tuya, puede ser un abuso.`, db)
          .catch(() => {});
      }

      // El historial de ESTE lead se persiste aca mismo (JSON, acotado por
      // CHAT_QUESTION_LIMIT): sin los mensajes anteriores, un "si" del
      // visitante le llegaba al modelo sin contexto.
      const history = Array.isArray(lead.chat_history) ? lead.chat_history : [];
      const { reply } = await askSalesChat({ apiKey, plan, history, userMessage: message });
      const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];

      await db.query(
        'UPDATE signup_leads SET chat_questions_used = chat_questions_used + 1, chat_history = ? WHERE id = ?',
        [JSON.stringify(updatedHistory), lead.id]
      );

      const questionsLeft = Math.max(0, CHAT_QUESTION_LIMIT - (usadas + 1));
      res.json({ reply, questionsLeft, limitReached: questionsLeft <= 0 });
    } catch (err) {
      console.error('ERROR en chat de ventas:', err);
      res.status(502).json({ error: 'No se pudo responder en este momento.' });
    }
  });

  return router;
};
