// ============================================================================
// Monitoreo de errores (Sentry)
// ============================================================================
//
// QUE PROBLEMA RESUELVE
// ---------------------
// Hasta ahora, si el backend tiraba un error en produccion, el unico aviso
// era que alguien de la empresa escribiera "no me carga Presentismo". El
// error quedaba en el log de Render, que nadie mira salvo que ya sepa que
// hay algo roto. O sea: te enterabas tarde, por el cliente, y sin datos.
//
// Con esto, cada error no atrapado manda un aviso con el archivo y la linea,
// que empresa y que usuario lo sufrio, que estaba pidiendo, y cuantas veces
// paso. Te enteras antes que el cliente y ya sabes donde mirar.
//
// COMO SE PRENDE
// --------------
// Con la variable de entorno SENTRY_DSN. Sin ella, todo esto no hace
// absolutamente nada: ni se conecta, ni pesa, ni puede romper un pedido.
// Eso es a proposito -- el monitoreo nunca debe ser un motivo de caida.
//
//   1. crear una cuenta gratis en sentry.io y un proyecto de tipo Node.js;
//   2. copiar el DSN que da (una URL tipo https://xxxx@o0.ingest.sentry.io/0);
//   3. pegarlo en Render -> el servicio del backend -> Environment ->
//      SENTRY_DSN;
//   4. opcional: SENTRY_ENVIRONMENT (por defecto "production").
//
// QUE NO SE MANDA
// ---------------
// `sendDefaultPii: false` -- no viajan cookies, ni headers de autorizacion,
// ni el cuerpo de los pedidos. Esto procesa datos de asistencia de personas
// reales: lo que se manda es el error y el contexto minimo para ubicarlo
// (empresa, id de usuario de la app, ruta), nunca los datos de los
// empleados.

let Sentry = null;
let activo = false;

function iniciarMonitoreo() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('ℹ️  Monitoreo de errores apagado (falta SENTRY_DSN). Ver monitoreo.js.');
    return false;
  }
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || 'production',
      // No mandar cookies, headers de auth ni cuerpos de pedido.
      sendDefaultPii: false,
      // Solo errores. El "tracing" (medir tiempos de cada pedido) se deja
      // apagado: consume cuota del plan gratuito y para medir rendimiento ya
      // se usa EXPLAIN contra la base, que da mejor informacion.
      tracesSampleRate: 0
    });
    activo = true;
    console.log('✅ Monitoreo de errores activo (Sentry).');
    return true;
  } catch (err) {
    // Si el monitoreo falla al arrancar, el servidor tiene que arrancar
    // igual. Nunca al reves.
    console.error('No se pudo iniciar el monitoreo de errores:', err.message);
    return false;
  }
}

/**
 * Reporta un error. Si el monitoreo esta apagado, no hace nada.
 *
 * @param {Error} err
 * @param {object} [req] pedido de Express, para adjuntar contexto
 */
function reportarError(err, req) {
  if (!activo || !Sentry) return;
  try {
    Sentry.withScope((scope) => {
      if (req) {
        scope.setTag('ruta', `${req.method} ${req.path}`);
        // Identificar la EMPRESA es lo primero que se pregunta uno al ver un
        // error: ¿le pasa a todos o a un cliente?
        if (req.appUser) {
          scope.setTag('empresa', String(req.appUser.tenantId ?? 'superadmin'));
          scope.setUser({ id: String(req.appUser.id) });
        }
      }
      Sentry.captureException(err);
    });
  } catch (_) {
    // Un fallo del monitoreo no puede afectar la respuesta al usuario.
  }
}

module.exports = { iniciarMonitoreo, reportarError };
