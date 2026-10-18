// /api/segundo-factor -- el segundo factor de la PROPIA cuenta (2026-10-18).
// Ver motor-laboral/services/segundoFactor.js.
//
// La inscripción (escanear el código QR y confirmar el primer código) la hace
// el navegador directamente con Firebase: el servidor nunca ve el secreto del
// celular. Acá solo se informa el estado, para que la pantalla sepa qué
// mostrar. Estas rutas se pueden usar aunque el segundo factor sea
// obligatorio y la sesión todavía no lo tenga (RUTAS_LIBRES).
const express = require('express');
const { initFirebaseAdmin } = require('../firebaseAuth');
const { getAuth } = require('firebase-admin/auth');
const sf = require('../motor-laboral/services/segundoFactor');

module.exports = function segundoFactorRoutes(db) {
  const router = express.Router();

  router.get('/estado', async (req, res) => {
    if (!req.appUser) return res.status(401).json({ error: 'Iniciá sesión' });
    const u = req.appUser;
    try {
      // El usuario REAL: el modo soporte no cambia quién es.
      const real = u.soporte ? { isSuperadmin: true, employeeId: null, tenantId: null } : u;
      const nivel = real.isSuperadmin ? await sf.nivelDePlataforma(db) : await sf.nivelDeEmpresa(db, real.tenantId);
      let inscripto = false;
      let firebaseHabilitado = null;
      try {
        initFirebaseAdmin();
        const auth = getAuth();
        inscripto = ((await sf.inscriptos(auth, [req.user.uid])).get(req.user.uid) || 0) > 0;
        firebaseHabilitado = (await sf.estadoFirebase(auth)).totpHabilitado;
      } catch (err) {
        console.warn('segundo factor: no se pudo consultar Firebase:', err.message);
      }
      res.json({
        nivel,
        // Portal del empleado: nunca.
        disponible: real.employeeId == null && nivel !== 'apagado' && firebaseHabilitado !== false,
        exigido: sf.exigidoPara(real, { nivelEmpresa: nivel, nivelPlataforma: nivel }),
        inscripto,
        sesionConSegundoFactor: sf.sesionConSegundoFactor(req.user),
        firebaseHabilitado,
      });
    } catch (err) {
      console.error('ERROR estado segundo factor:', err);
      res.status(500).json({ error: 'No se pudo leer el estado del segundo factor' });
    }
  });

  return router;
};
