// ============================================================================
// Que Firebase le mande a la persona el email para crear/recuperar su clave
// ============================================================================
//
// POR QUE (hallazgo F-04 de la auditoria de seguridad)
// ----------------------------------------------------
// El alta publica (/api/public/signup) devolvia el link para poner la
// contraseña EN LA RESPUESTA. Cualquiera podia registrarse con el email de
// otra persona y quedarse con el link: una cuenta a nombre ajeno, sin haber
// demostrado nunca que el email era suyo. Ahora el link lo manda Firebase
// por email: solo lo ve quien de verdad lee ese correo.
//
// Se usa la API REST de Firebase Auth (accounts:sendOobCode) con la clave WEB
// del proyecto, que es PUBLICA por diseño (la misma que usa el frontend). El
// email sale con la plantilla configurada en la consola de Firebase
// (Authentication > Templates): ahi se elige el idioma y el texto.
//
// No se mandan emails a dominios reservados para pruebas (RFC 2606:
// example.com/.net/.org, .test, .invalid, .localhost): los tests usan esas
// direcciones y no tiene sentido gastar envios reales en ellas.
const WEB_API_KEY_DEFAULT = 'AIzaSyAJ3oBdp9YIjJvMDOOgcybRwAbc3eGcJwI'; // publica (config web de Firebase)

function esDominioDePrueba(email) {
  const dominio = String(email).split('@')[1] || '';
  return /(^|\.)example\.(com|net|org)$/i.test(dominio) || /\.(test|invalid|localhost)$/i.test(dominio);
}

/**
 * Pide a Firebase que mande el email de "restablecer contraseña" (sirve
 * tambien para ponerla por primera vez). Nunca tira: devuelve si se envio.
 * @returns {Promise<{enviado:boolean, motivo?:string}>}
 */
async function enviarEmailDeContrasena(email, { fetchImpl = fetch } = {}) {
  if (esDominioDePrueba(email)) return { enviado: false, motivo: 'dominio de prueba' };
  const key = process.env.FIREBASE_WEB_API_KEY || WEB_API_KEY_DEFAULT;
  try {
    const res = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
    });
    if (!res.ok) {
      const cuerpo = await res.text().catch(() => '');
      return { enviado: false, motivo: `Firebase respondio ${res.status}: ${cuerpo.slice(0, 200)}` };
    }
    return { enviado: true };
  } catch (err) {
    return { enviado: false, motivo: err.message };
  }
}

module.exports = { enviarEmailDeContrasena, esDominioDePrueba };
