// /api/registro: para una persona con cuenta de login (Firebase) que TODAVÍA
// no tiene acceso al sistema. Ver motor-laboral/services/registroService.js.
//
// Seguridad: requiere estar logueado (firebaseAuthMiddleware), pero NO tener
// usuario en el sistema (appUserMiddleware deja pasar solo estas rutas sin
// usuario: ver allí). Nada de acá lee ni escribe datos de una empresa.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const registro = require('../motor-laboral/services/registroService');
const { verifyTurnstileToken } = require('../motor-laboral/services/turnstileService');
const avisos = require('../avisos');

const UN_DIA = 24 * 60 * 60 * 1000;
const numeroDeEntorno = (nombre, porDefecto) => {
  const n = Number(process.env[nombre]);
  return Number.isInteger(n) && n > 0 ? n : porDefecto;
};
const solicitudLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos, esperá un momento y probá de nuevo.' },
});
const solicitudPorDia = rateLimit({
  windowMs: UN_DIA, limit: numeroDeEntorno('SIGNUP_TOPE_DIARIO_POR_IP', 30), standardHeaders: true, legacyHeaders: false,
  message: { error: 'Ya recibimos varias solicitudes desde esta conexión. Escribinos por WhatsApp.' },
});

module.exports = function (db) {
  const router = express.Router();

  const quien = (req) => {
    if (!req.user || !req.user.uid) return null;
    return { uid: req.user.uid, email: req.user.email || null, email_verified: req.user.email_verified === true };
  };
  const sinLogin = (res) => res.status(401).json({ error: 'Iniciá sesión para continuar.' });
  const responderError = (res, err, contexto) => {
    if (err instanceof registro.ErrorDeRegistro) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    console.error(`ERROR registro (${contexto}):`, err);
    return res.status(500).json({ error: 'No se pudo completar. Probá de nuevo o escribinos por WhatsApp.' });
  };

  // Los textos que se aceptan (con versión y huella).
  router.get('/documentos', (req, res) => {
    try {
      res.json({ documentos: registro.documentosLegales() });
    } catch (err) { responderError(res, err, 'documentos'); }
  });

  // Qué tiene que ver esta persona: crear la solicitud, esperar, etc.
  router.get('/estado', async (req, res) => {
    const u = quien(req);
    if (!u) return sinLogin(res);
    try {
      res.json({ ...(await registro.estadoDeLaCuenta(db, u)), email: u.email, emailVerificado: u.email_verified });
    } catch (err) { responderError(res, err, 'estado'); }
  });

  // Enviar la solicitud (datos de la empresa + aceptación de los textos).
  router.post('/solicitud', solicitudPorDia, solicitudLimiter, async (req, res) => {
    const u = quien(req);
    if (!u) return sinLogin(res);
    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) return res.status(503).json({ error: 'TURNSTILE_SECRET_KEY no está configurado en el servidor' });
    try {
      registro.validarSolicitud(u, req.body || {});
      let captcha;
      try {
        captcha = await verifyTurnstileToken({ token: req.body && req.body.turnstileToken, remoteIp: req.ip, secretKey });
      } catch (err) {
        // Cloudflare no respondió bien (le pasa a veces): no es culpa de quien se registra.
        console.error('Registro: no se pudo verificar el captcha:', err.message);
        return res.status(503).json({ error: 'No pudimos verificar el captcha. Esperá unos segundos y probá de nuevo.' });
      }
      if (!captcha.success) return res.status(400).json({ error: 'Verificación anti-bot fallida: recargá la página e intentá de nuevo.' });

      const r = await registro.crearSolicitud(db, u, req.body || {}, { ip: req.ip, navegador: req.get('user-agent') });
      if (r.nueva) {
        // Aviso al superadmin (nunca rompe la solicitud: regla de avisos.js).
        const preferencia = { whatsapp: 'WhatsApp', llamada: 'llamada', email: 'email' }[r.contacto];
        await avisos.avisar('alta', {
          empresa: r.empresa,
          detalle: [`${r.nombre} · ${r.email} · ${r.telefono}`, `Prefiere: ${preferencia}`, 'Se registró en el sistema (email verificado, aceptó los términos)',
            r.empleados ? `${r.empleados} empleados` : null, r.relojes ? `${r.relojes} relojes` : null].filter(Boolean).join('\n'),
        }, db);
      }
      res.status(201).json({ ok: true, estado: 'pendiente' });
    } catch (err) { responderError(res, err, 'solicitud'); }
  });

  return router;
};
