// ============================================================================
// Creación de cuentas de login: SOLO desde el servidor (2026-10-14)
// ============================================================================
//
// QUÉ PASÓ
// --------
// La primera versión del registro creaba la cuenta desde el navegador
// (createUserWithEmailAndPassword). Para eso Firebase tenía que aceptar altas
// de CUALQUIERA: el captcha y los controles estaban en nuestra pantalla, pero
// un bot puede hablarle a Firebase directo, sin pasar por ella. Así apareció
// pepe@gmail.com, una cuenta que nadie controló.
//
// LA REGLA
// --------
// En Firebase (proyecto asistenciatw) está APAGADO "Enable create (sign-up)":
// el navegador ya no puede crear cuentas. Las crea este archivo, con la llave
// de administrador, y solo después de pasar los controles:
//   1. datos válidos (email, contraseña razonable);
//   2. email ni dominio bloqueados, ni de un servicio de emails descartables;
//   3. captcha y límite de intentos por conexión (en la ruta, routes/public.js).
// Si un control falla, no se crea nada.
//
// MARCA "registro"
// ----------------
// Cada cuenta creada acá lleva la marca (custom claim) `registro: true`. Sirve
// para una sola cosa: la limpieza de los 7 días (abajo) toca ÚNICAMENTE
// cuentas con esa marca. Las cuentas que crea el sistema al invitar a un
// usuario (appUserRepository.js) no la llevan, así que nunca entran en esa
// limpieza.
//
// CON GOOGLE
// ----------
// El navegador consigue de Google un "ID token": un certificado FIRMADO por
// Google que dice "esta persona es fulano@gmail.com, email verificado". Acá
// se comprueba esa firma con la librería oficial de Google (que también
// controla que el certificado sea PARA NUESTRA app y que no esté vencido).
// Recién entonces se crea la cuenta con Google ya vinculado; el navegador
// después entra con ese mismo certificado (eso es un ingreso, no un alta, así
// que Firebase lo permite con el alta cerrada).
const admin = require('firebase-admin');
const { initFirebaseAdmin } = require('../../firebaseAuth');
const { ErrorDeRegistro, estaBloqueado } = require('./registroService');

const DIAS_PARA_BORRAR_SIN_USO = 7;

// El ID de cliente web de Google del proyecto asistenciatw. NO es secreto:
// viaja en la página. Configurable para otra instalación (otro proyecto).
const GOOGLE_CLIENT_ID_DEFAULT = '948260225701-ekc31cbt4favhcmp4v0k4i3tsalealq2.apps.googleusercontent.com';
const googleClientId = () => process.env.GOOGLE_OAUTH_CLIENT_ID || GOOGLE_CLIENT_ID_DEFAULT;

// Servicios de emails "descartables" (duran minutos, sirven para registrarse
// sin dar un email real). No es una lista completa: corta lo más usado. Si
// aparece otro, se agrega acá o se bloquea el dominio desde Solicitudes.
const DOMINIOS_DESCARTABLES = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
  '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempail.com', 'tmpmail.org',
  'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'throwawaymail.com', 'mohmal.com', 'emailondeck.com', 'mintemail.com',
  'mailnesia.com', 'burnermail.io', '1secmail.com', '1secmail.org', '1secmail.net', 'spamgourmet.com',
  'mailcatch.com', 'moakt.com', 'tempr.email', 'discard.email', 'emailfake.com', 'fakemail.net', 'mytemp.email',
  'tempinbox.com', 'mailpoof.com', 'inboxkitten.com', 'byom.de', 'mail.tm', 'linshiyouxiang.net',
]);

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dominioDe = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';

// ---------------------------------------------------------------------------
// Controles que no necesitan ningún servicio: van primero, así un dato mal
// cargado nunca depende de que Cloudflare o Firebase respondan.
// ---------------------------------------------------------------------------
function normalizarEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function validarEmail(email) {
  if (!email || email.length > 254 || !EMAIL_VALIDO.test(email)) throw new ErrorDeRegistro(400, 'El email no es válido.');
  if (DOMINIOS_DESCARTABLES.has(dominioDe(email))) {
    throw new ErrorDeRegistro(400, 'Ese email es de un servicio de emails temporales. Usá un email propio o de tu empresa.', 'DESCARTABLE');
  }
}

function validarCuentaConEmail({ email, password }) {
  const e = normalizarEmail(email);
  validarEmail(e);
  const p = String(password ?? '');
  if (p.length < 8) throw new ErrorDeRegistro(400, 'La contraseña tiene que tener al menos 8 caracteres.');
  if (p.length > 128) throw new ErrorDeRegistro(400, 'La contraseña es demasiado larga (máximo 128 caracteres).');
  // Una contraseña que es el propio email, o un solo carácter repetido, es
  // lo primero que prueba cualquiera.
  if (p.toLowerCase() === e || p.toLowerCase() === e.split('@')[0] || /^(.)\1+$/.test(p)) {
    throw new ErrorDeRegistro(400, 'Esa contraseña es muy fácil de adivinar. Elegí otra.');
  }
  return { email: e, password: p };
}

function validarCuentaConGoogle({ idToken }) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) {
    throw new ErrorDeRegistro(400, 'No llegó la respuesta de Google. Probá de nuevo.');
  }
}

// El bloqueo vive en la tabla de la migración 20261018: sin ella no hay
// bloqueos cargados, y no es motivo para frenar el alta.
async function controlarBloqueo(db, email) {
  try {
    if (await estaBloqueado(db, email)) throw new ErrorDeRegistro(403, 'No podemos crear una cuenta con este email.', 'BLOQUEADO');
  } catch (err) {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) return;
    throw err;
  }
}

const YA_TIENE_CUENTA = 'Ese email ya tiene una cuenta: tocá "Ingresar" (o "¿Olvidaste tu contraseña?").';

// ---------------------------------------------------------------------------
// Alta con email y contraseña
// ---------------------------------------------------------------------------
/**
 * @param deps.auth  admin.auth() (en los tests, uno falso)
 * @returns {{ uid: string, email: string }}
 */
async function crearCuentaConEmail(db, datos, { auth } = {}) {
  const { email, password } = validarCuentaConEmail(datos);
  await controlarBloqueo(db, email);
  auth = auth || (initFirebaseAdmin(), admin.auth());
  let usuario;
  try {
    usuario = await auth.createUser({ email, password, emailVerified: false });
  } catch (err) {
    if (err && err.code === 'auth/email-already-exists') throw new ErrorDeRegistro(409, YA_TIENE_CUENTA, 'YA_EXISTE');
    if (err && (err.code === 'auth/invalid-password' || err.code === 'auth/password-does-not-meet-requirements')) {
      throw new ErrorDeRegistro(400, 'La contraseña no cumple los requisitos: usá al menos 8 caracteres.');
    }
    if (err && err.code === 'auth/invalid-email') throw new ErrorDeRegistro(400, 'El email no es válido.');
    throw err;
  }
  await marcarComoRegistro(auth, usuario.uid);
  return { uid: usuario.uid, email };
}

// ---------------------------------------------------------------------------
// Alta con Google
// ---------------------------------------------------------------------------
// Verifica el ID token con la librería oficial: firma de Google, que sea para
// NUESTRO client id (audience) y que no esté vencido. Devuelve sus datos.
async function verificarTokenDeGoogle(idToken) {
  const { OAuth2Client } = require('google-auth-library');
  const cliente = new OAuth2Client();
  try {
    const ticket = await cliente.verifyIdToken({ idToken, audience: googleClientId() });
    return ticket.getPayload();
  } catch (err) {
    throw new ErrorDeRegistro(400, 'Google no confirmó tu identidad (puede haber vencido). Probá de nuevo.', 'GOOGLE_INVALIDO');
  }
}

/**
 * @param deps.auth             admin.auth() (en los tests, uno falso)
 * @param deps.verificarGoogle  verificarTokenDeGoogle (en los tests, uno falso)
 */
async function crearCuentaConGoogle(db, datos, { auth, verificarGoogle = verificarTokenDeGoogle } = {}) {
  validarCuentaConGoogle(datos);
  const g = await verificarGoogle(datos.idToken);
  const email = normalizarEmail(g && g.email);
  if (!g || !g.sub || !email) throw new ErrorDeRegistro(400, 'Google no informó un email para esta cuenta.');
  // Un email que Google no verificó no prueba nada (cuentas de Google con
  // email de terceros): se pide registrarse con email y contraseña.
  if (g.email_verified !== true) throw new ErrorDeRegistro(400, 'Google no tiene verificado ese email. Creá la cuenta con email y contraseña.');
  validarEmail(email);
  await controlarBloqueo(db, email);

  auth = auth || (initFirebaseAdmin(), admin.auth());
  // ¿Ya existe una cuenta con ese email o con esa cuenta de Google?
  for (const buscar of [() => auth.getUserByEmail(email), () => auth.getUserByProviderUid('google.com', g.sub)]) {
    try {
      await buscar();
      throw new ErrorDeRegistro(409, 'Ese email ya tiene una cuenta: tocá "Ingresar con Google" (o ingresá con tu contraseña).', 'YA_EXISTE');
    } catch (err) {
      if (err instanceof ErrorDeRegistro) throw err;
      if (!err || err.code !== 'auth/user-not-found') throw err;
    }
  }

  const nombre = String(g.name || '').slice(0, 150) || undefined;
  let usuario;
  try {
    usuario = await auth.createUser({ email, emailVerified: true, displayName: nombre });
  } catch (err) {
    // Doble clic: el primer pedido ya la creó.
    if (err && err.code === 'auth/email-already-exists') throw new ErrorDeRegistro(409, YA_TIENE_CUENTA, 'YA_EXISTE');
    throw err;
  }
  try {
    await auth.updateUser(usuario.uid, {
      providerToLink: { providerId: 'google.com', uid: g.sub, email, displayName: nombre },
    });
    await marcarComoRegistro(auth, usuario.uid);
  } catch (err) {
    // Sin Google vinculado la cuenta no sirve (no tiene contraseña): se deshace.
    await auth.deleteUser(usuario.uid).catch(() => {});
    throw err;
  }
  return { uid: usuario.uid, email };
}

async function marcarComoRegistro(auth, uid) {
  await auth.setCustomUserClaims(uid, { registro: true });
}

// ---------------------------------------------------------------------------
// Limpieza: cuentas del registro que en 7 días no hicieron nada
// ---------------------------------------------------------------------------
// "No hicieron nada" = no tienen usuario en el sistema NI ninguna solicitud
// (pendiente, rechazada o bloqueada). Una solicitud pendiente tiene su propia
// regla (30 días, registroService). La Ley 25.326 pide no guardar datos
// personales que no se usan; además así no se juntan cuentas abandonadas.
function esCuentaDeRegistroSinUso(u, ahora, dias = DIAS_PARA_BORRAR_SIN_USO) {
  if (!u || !u.customClaims || u.customClaims.registro !== true) return false;
  const creada = Date.parse(u.metadata && u.metadata.creationTime);
  return Number.isFinite(creada) && ahora - creada > dias * 24 * 60 * 60 * 1000;
}

async function borrarCuentasSinUso(db, { auth, dias = DIAS_PARA_BORRAR_SIN_USO, ahora = Date.now() } = {}) {
  auth = auth || (initFirebaseAdmin(), admin.apps.length ? admin.auth() : null);
  if (!auth) return 0;
  const candidatas = [];
  let pagina;
  do {
    const r = await auth.listUsers(1000, pagina);
    candidatas.push(...r.users.filter((u) => esCuentaDeRegistroSinUso(u, ahora, dias)));
    pagina = r.pageToken;
  } while (pagina);
  if (!candidatas.length) return 0;

  const uids = candidatas.map((u) => u.uid);
  const [conUsuario] = await db.query('SELECT firebase_uid FROM app_users WHERE firebase_uid IN (?)', [uids]);
  let conSolicitud = [];
  try {
    [conSolicitud] = await db.query('SELECT DISTINCT firebase_uid FROM signup_leads WHERE firebase_uid IN (?)', [uids]);
  } catch (err) {
    // Sin la migración 20261018 no puede haber solicitudes del sistema, pero
    // por las dudas no se borra nada si no se puede comprobar.
    if (err && err.code === 'ER_BAD_FIELD_ERROR') return 0;
    throw err;
  }
  const enUso = new Set([...conUsuario, ...conSolicitud].map((r) => r.firebase_uid));
  const borrar = uids.filter((uid) => !enUso.has(uid));
  if (!borrar.length) return 0;
  const r = await auth.deleteUsers(borrar);
  return r.successCount;
}

module.exports = {
  DIAS_PARA_BORRAR_SIN_USO, DOMINIOS_DESCARTABLES, googleClientId,
  validarCuentaConEmail, validarCuentaConGoogle, crearCuentaConEmail, crearCuentaConGoogle,
  verificarTokenDeGoogle, esCuentaDeRegistroSinUso, borrarCuentasSinUso,
};
