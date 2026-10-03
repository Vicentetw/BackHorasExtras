// Recibe los reportes de la Politica de Seguridad de Contenido (CSP) del
// frontend y los deja en el log del servidor (Render > Logs).
//
// QUE ES LA CSP: una cabecera que el sitio (firebase.json del frontend) le
// manda al navegador con la lista de lugares de donde la pagina puede cargar
// codigo, estilos, conexiones, iframes. Si alguien logra meter un <script>
// en la pagina (un XSS), el navegador se niega a ejecutarlo porque no esta en
// la lista. Es la defensa mas fuerte contra robo de sesiones.
//
// POR QUE REPORTES: una CSP demasiado estricta tambien rompe cosas legitimas
// (el popup de Google, el captcha, un PDF). Por eso sale primero en modo
// "solo reportar" (Content-Security-Policy-Report-Only): el navegador NO
// bloquea nada, pero avisa aca cada vez que HABRIA bloqueado algo. Cuando los
// logs pasen unos dias limpios con uso real, se cambia a la cabecera que
// bloquea de verdad.
//
// Publica (sin login) porque la manda el navegador por su cuenta. Para que
// nadie pueda inundar el log: cuerpo chico, y cada violacion distinta se
// anota una sola vez por hora (con cuantas veces se repitio).
const express = require('express');

const UNA_HORA = 60 * 60 * 1000;
const MAX_DISTINTAS = 500; // tope de memoria del agrupador
const vistas = new Map(); // clave -> { desde, veces }

// Los navegadores mandan dos formatos: el viejo (report-uri, un objeto
// "csp-report") y el nuevo (Reporting API, una lista de { type, body }).
function extraer(body) {
  const lista = Array.isArray(body) ? body.map((r) => r && r.body) : [body && body['csp-report']];
  return lista.filter(Boolean).map((r) => ({
    directiva: String(r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || '').slice(0, 60),
    bloqueado: String(r['blocked-uri'] || r.blockedURL || '').slice(0, 200),
    pagina: String(r['document-uri'] || r.documentURL || '').replace(/[?#].*$/, '').slice(0, 200),
    modo: String(r.disposition || '').slice(0, 10)
  }));
}

function anotar(v, ahora = Date.now()) {
  const clave = `${v.directiva}|${v.bloqueado}|${v.pagina}`;
  const previa = vistas.get(clave);
  if (previa && ahora - previa.desde < UNA_HORA) {
    previa.veces++;
    return false;
  }
  if (!previa && vistas.size >= MAX_DISTINTAS) vistas.clear();
  const repeticiones = previa ? previa.veces : 0;
  vistas.set(clave, { desde: ahora, veces: 0 });
  console.warn(`[CSP] ${v.modo || 'report'} ${v.directiva} bloquearia "${v.bloqueado}" en ${v.pagina}` +
    (repeticiones ? ` (y se repitio ${repeticiones} veces en la ultima hora)` : ''));
  return true;
}

const router = express.Router();
router.post('/',
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  (req, res) => {
    for (const v of extraer(req.body)) anotar(v);
    res.status(204).end();
  });
// Cuerpo gigante o que no es JSON: se descarta aca, sin llegar al manejador
// global de errores (que lo contaria como una falla del servidor, 500, y lo
// mandaria a Sentry). Es basura de afuera, no un error nuestro.
router.use((err, req, res, next) => {
  if (err && err.type && err.status >= 400 && err.status < 500) return res.status(err.status).end();
  return next(err);
});

module.exports = { router, extraer, anotar };
