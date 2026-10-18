// ============================================================================
// Segundo factor de autenticación (Fase 1 de PLAN_LISTO_PARA_VENDER.md,
// 2026-10-18)
// ============================================================================
//
// POR QUE
// -------
// Con usuario y contraseña solos, quien consiga la contraseña de un
// administrador (un correo falso, una contraseña repetida en otro sitio) entra
// a los datos de todos los empleados de esa empresa. El segundo factor pide,
// además, un código de 6 dígitos que genera una app en el celular (Google
// Authenticator, Microsoft Authenticator, Authy): el método "TOTP".
// Se eligió TOTP y no SMS: no cuesta por mensaje, funciona sin señal y no se
// puede robar duplicando el chip.
//
// QUIÉN DECIDE (pedido del dueño: "que los pueda habilitar el súper admin")
// ---------------------------------------------------------------------------
// El superadmin, empresa por empresa:
//   - apagado (por defecto): como siempre, nadie ve nada nuevo;
//   - opcional: cada usuario lo puede activar desde "Mi cuenta";
//   - obligatorio: para usar el sistema hay que tenerlo activado.
// Y aparte, para las cuentas de superadmin (la plataforma entera).
// El portal del empleado NUNCA lo pide: frenaría a cientos de personas que
// solo ven su propio mes.
//
// DÓNDE SE EXIGE: EN EL SERVIDOR (appUserMiddleware), no solo en la pantalla.
// Firebase marca en el token de la sesión si se entró con segundo factor
// (`firebase.sign_in_second_factor`). Si la empresa lo exige y la sesión no lo
// tiene, el servidor contesta 403 con codigo SEGUNDO_FACTOR_REQUERIDO y la
// pantalla lleva a activarlo. Así no se lo puede saltear llamando a la API.
//
// Se guarda en app_settings: no necesita migración.
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');

const NIVELES = ['apagado', 'opcional', 'obligatorio'];
const CLAVE_EMPRESA = 'segundo_factor';
const CLAVE_PLATAFORMA = 'segundo_factor_superadmin';
const CODIGO = 'SEGUNDO_FACTOR_REQUERIDO';
// Rutas que se pueden usar sin segundo factor aunque sea obligatorio: cargar
// el propio perfil (la pantalla lo necesita para saber qué mostrar) y ver o
// activar el propio segundo factor.
const RUTAS_LIBRES = ['/api/app-users/me', '/api/segundo-factor'];

const nivelValido = (n) => (NIVELES.includes(n) ? n : null);

// Cache corto: se consulta en CADA pedido de la app. Se borra al guardar.
const cache = new Map(); // clave -> { nivel, hasta }
const TTL_MS = 60 * 1000;

async function leer(db, clave, tenantId) {
  const k = `${clave}|${tenantId ?? 'plataforma'}`;
  const c = cache.get(k);
  if (c && c.hasta > Date.now()) return c.nivel;
  let nivel = 'apagado';
  if (tenantId == null) {
    // Plataforma: solo la fila global (tenant NULL).
    const [[fila]] = await db.query('SELECT value FROM app_settings WHERE name = ? AND tenant_id IS NULL', [clave]);
    nivel = nivelValido(fila && fila.value) || 'apagado';
  } else {
    // Empresa: solo SU fila. Una fila global no le cambia nada a nadie.
    const [[fila]] = await db.query('SELECT value FROM app_settings WHERE name = ? AND tenant_id = ?', [clave, tenantId]);
    nivel = nivelValido(fila && fila.value) || 'apagado';
  }
  cache.set(k, { nivel, hasta: Date.now() + TTL_MS });
  return nivel;
}

const nivelDeEmpresa = (db, tenantId) => (tenantId == null ? Promise.resolve('apagado') : leer(db, CLAVE_EMPRESA, tenantId));
const nivelDePlataforma = (db) => leer(db, CLAVE_PLATAFORMA, null);

async function guardarNivelDeEmpresa(db, tenantId, nivel) {
  await setAppSetting(CLAVE_EMPRESA, tenantId, nivelValido(nivel) || 'apagado', db);
  cache.delete(`${CLAVE_EMPRESA}|${tenantId}`);
}

async function guardarNivelDePlataforma(db, nivel) {
  await setAppSetting(CLAVE_PLATAFORMA, null, nivelValido(nivel) || 'apagado', db);
  cache.delete(`${CLAVE_PLATAFORMA}|plataforma`);
}

/** Pura. ¿Esta sesión entró con segundo factor? (token ya verificado por Firebase) */
function sesionConSegundoFactor(tokenDecodificado) {
  return !!(tokenDecodificado && tokenDecodificado.firebase && tokenDecodificado.firebase.sign_in_second_factor);
}

/**
 * Pura. ¿A este usuario se le exige? Portal del empleado: nunca.
 * @param {{isSuperadmin:boolean, employeeId:any}} appUser  el usuario REAL (no el "modo soporte")
 */
function exigidoPara(appUser, { nivelEmpresa, nivelPlataforma }) {
  if (!appUser) return false;
  if (appUser.isSuperadmin) return nivelPlataforma === 'obligatorio';
  if (appUser.employeeId != null) return false;
  return nivelEmpresa === 'obligatorio';
}

const rutaLibre = (ruta) => RUTAS_LIBRES.some((r) => ruta === r || ruta.startsWith(r + '/'));

// ---------------------------------------------------------------------------
// Firebase (Identity Platform): el método TOTP tiene que estar prendido en el
// PROYECTO. Prenderlo no obliga a nadie: solo permite que quien quiera lo
// active. Lo prende el superadmin con un botón (pantalla Seguridad).
// ---------------------------------------------------------------------------
function totpHabilitadoEn(config) {
  const mfa = config && config.multiFactorConfig;
  return !!(mfa && (mfa.providerConfigs || []).some((p) => p.state === 'ENABLED' && p.totpProviderConfig));
}

async function estadoFirebase(auth) {
  const config = await auth.projectConfigManager().getProjectConfig();
  return { totpHabilitado: totpHabilitadoEn(config.toJSON ? config.toJSON() : config) };
}

async function habilitarEnFirebase(auth) {
  await auth.projectConfigManager().updateProjectConfig({
    multiFactorConfig: {
      // adjacentIntervals: cuántos códigos de antes y de después se aceptan
      // (cada uno dura 30 s): 5 tolera relojes de celular algo atrasados.
      providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 5 } }],
    },
  });
  return estadoFirebase(auth);
}

/** Factores inscriptos de varias cuentas (uid -> cantidad), en lotes de 100. */
async function inscriptos(auth, uids) {
  const out = new Map();
  const lista = [...new Set(uids.filter(Boolean))];
  for (let i = 0; i < lista.length; i += 100) {
    const r = await auth.getUsers(lista.slice(i, i + 100).map((uid) => ({ uid })));
    for (const u of r.users) out.set(u.uid, (u.multiFactor && u.multiFactor.enrolledFactors || []).length);
  }
  return out;
}

/** Saca todos los segundos factores de una cuenta (perdió el celular). */
async function resetear(auth, uid) {
  await auth.updateUser(uid, { multiFactor: { enrolledFactors: null } });
  // Cierra las sesiones abiertas: la próxima vez entra y, si es obligatorio,
  // vuelve a activarlo con el celular nuevo.
  await auth.revokeRefreshTokens(uid);
}

module.exports = {
  NIVELES, CODIGO, RUTAS_LIBRES, nivelValido,
  nivelDeEmpresa, nivelDePlataforma, guardarNivelDeEmpresa, guardarNivelDePlataforma,
  sesionConSegundoFactor, exigidoPara, rutaLibre, totpHabilitadoEn,
  estadoFirebase, habilitarEnFirebase, inscriptos, resetear,
};
