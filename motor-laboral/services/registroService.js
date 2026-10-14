// ============================================================================
// Registro dentro del sistema (2026-10-14)
// ============================================================================
//
// Decisión del dueño: cualquiera crea su cuenta en el login (email o Google),
// verifica el email, completa los datos de su empresa y ACEPTA los términos;
// queda "en revisión" y no puede usar nada hasta que el superadmin la
// apruebe (Solicitudes de alta). Aviso por Telegram. Las solicitudes sin
// aprobar se borran a los 30 días; el spam se borra en el momento y se puede
// bloquear (email o dominio).
//
// Por qué así (ver ESTADO_PROYECTO.md, 2026-10-14): la aceptación legal queda
// atada a una persona con email verificado, nadie carga datos antes de
// aceptar, y hay una sola puerta de entrada desde internet.
//
// Tolerante a la migración 20261018: sin ella, lo nuevo responde
// "falta la migración" y nada de lo existente cambia.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { initFirebaseAdmin } = require('../../firebaseAuth');

const DIAS_PARA_BORRAR_SIN_APROBAR = 30;

// --- Textos legales ---------------------------------------------------------
// Se leen de docs/legal/: lo que se muestra y lo que se acepta es el MISMO
// archivo; su huella (SHA-256) queda guardada con la aceptación.
const DOCUMENTOS = [
  { clave: 'terminos', titulo: 'Términos y Condiciones', archivo: 'TERMINOS_Y_CONDICIONES.md' },
  { clave: 'acuerdo_datos', titulo: 'Acuerdo de Tratamiento de Datos', archivo: 'ACUERDO_TRATAMIENTO_DATOS.md' },
  { clave: 'privacidad', titulo: 'Política de Privacidad', archivo: 'POLITICA_PRIVACIDAD.md' },
];
const DIR_LEGAL = path.join(__dirname, '..', '..', 'docs', 'legal');

function documentosLegales() {
  return DOCUMENTOS.map((d) => {
    const texto = fs.readFileSync(path.join(DIR_LEGAL, d.archivo), 'utf8');
    const version = (texto.match(/Versi[oó]n\s+(\d+(?:\.\d+)*)/i) || [])[1] || '0';
    return {
      clave: d.clave, titulo: d.titulo, version, texto,
      hash: crypto.createHash('sha256').update(texto, 'utf8').digest('hex'),
      // Mientras tenga datos sin completar, la pantalla avisa que es un borrador.
      borrador: /\[COMPLETAR/.test(texto),
    };
  });
}

// --- Errores con su código HTTP ---------------------------------------------
class ErrorDeRegistro extends Error {
  constructor(status, mensaje, codigo) { super(mensaje); this.status = status; this.codigo = codigo; }
}
const faltaMigracion = (err) => err && (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE');
const MSJ_FALTA_MIGRACION = 'El registro todavía no está habilitado en este servidor (falta la migración 20261018).';

// --- Bloqueos ----------------------------------------------------------------
const dominioDe = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';

async function estaBloqueado(db, email) {
  const [[b]] = await db.query(
    `SELECT id FROM registro_bloqueos WHERE (tipo = 'email' AND valor = ?) OR (tipo = 'dominio' AND valor = ?) LIMIT 1`,
    [String(email).toLowerCase(), dominioDe(email)]);
  return !!b;
}

// --- Estado de una cuenta de login -------------------------------------------
/**
 * Qué tiene que ver una persona logueada que NO tiene acceso al sistema.
 * @returns {{estado: 'habilitado'|'deshabilitado'|'bloqueado'|'pendiente'|'rechazado'|'sin_solicitud', solicitud?: object}}
 */
async function estadoDeLaCuenta(db, { uid, email }) {
  const [[usuario]] = await db.query('SELECT id, is_active FROM app_users WHERE firebase_uid = ?', [uid]);
  if (usuario) return { estado: usuario.is_active ? 'habilitado' : 'deshabilitado' };
  try {
    if (email && await estaBloqueado(db, email)) return { estado: 'bloqueado' };
    const [[lead]] = await db.query(
      `SELECT id, status, company_name, name, phone, created_at, review_note FROM signup_leads
        WHERE firebase_uid = ? ORDER BY id DESC LIMIT 1`, [uid]);
    if (!lead) return { estado: 'sin_solicitud' };
    if (lead.status === 'blocked') return { estado: 'bloqueado' };
    if (lead.status === 'rejected') return { estado: 'rechazado', solicitud: { empresa: lead.company_name, nota: lead.review_note } };
    return { estado: 'pendiente', solicitud: { empresa: lead.company_name, nombre: lead.name, telefono: lead.phone, enviada: lead.created_at } };
  } catch (err) {
    if (faltaMigracion(err)) return { estado: 'sin_solicitud', faltaMigracion: true };
    throw err;
  }
}

// --- Crear la solicitud --------------------------------------------------------
const recortar = (v, n) => String(v ?? '').trim().slice(0, n);
const entero = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 1000000 ? n : null; };

/**
 * @param usuario  el token de Firebase ya verificado (uid, email, email_verified)
 * @param datos    { empresa, nombre, telefono, contacto, empleados, relojes, horarios, aceptaciones: [{clave, version, hash}], tieneFacultades }
 * @param contexto { ip, navegador }
 */
// Controles que no necesitan la base ni el captcha: se hacen primero, así un
// dato mal cargado nunca depende de un servicio externo.
function validarSolicitud(usuario, datos) {
  if (!usuario.email) throw new ErrorDeRegistro(400, 'Tu cuenta no tiene email. Entrá con email y contraseña o con Google.');
  if (!usuario.email_verified) throw new ErrorDeRegistro(403, 'Primero verificá tu email: te mandamos un link.', 'EMAIL_SIN_VERIFICAR');
  if (!recortar(datos.empresa, 150) || !recortar(datos.nombre, 150) || !recortar(datos.telefono, 50)) {
    throw new ErrorDeRegistro(400, 'Completá el nombre de la empresa, tu nombre y un teléfono.');
  }
  if (datos.tieneFacultades !== true) throw new ErrorDeRegistro(400, 'Tenés que declarar que podés aceptar en nombre de la empresa.');
  const aceptadas = Array.isArray(datos.aceptaciones) ? datos.aceptaciones : [];
  for (const d of documentosLegales()) {
    const a = aceptadas.find((x) => x && x.clave === d.clave);
    if (!a || a.hash !== d.hash) throw new ErrorDeRegistro(400, `Tenés que aceptar la versión vigente de: ${d.titulo}. Recargá la página.`);
  }
}

async function crearSolicitud(db, usuario, datos, contexto) {
  validarSolicitud(usuario, datos);
  const email = String(usuario.email || '').toLowerCase();
  if (!email) throw new ErrorDeRegistro(400, 'Tu cuenta no tiene email. Entrá con email y contraseña o con Google.');
  if (!usuario.email_verified) throw new ErrorDeRegistro(403, 'Primero verificá tu email: te mandamos un link.', 'EMAIL_SIN_VERIFICAR');

  const empresa = recortar(datos.empresa, 150);
  const nombre = recortar(datos.nombre, 150);
  const telefono = recortar(datos.telefono, 50);
  if (!empresa || !nombre || !telefono) throw new ErrorDeRegistro(400, 'Completá el nombre de la empresa, tu nombre y un teléfono.');
  if (datos.tieneFacultades !== true) throw new ErrorDeRegistro(400, 'Tenés que declarar que podés aceptar en nombre de la empresa.');

  // Las aceptaciones tienen que ser de los textos ACTUALES (misma huella).
  const vigentes = documentosLegales();
  const aceptadas = Array.isArray(datos.aceptaciones) ? datos.aceptaciones : [];
  for (const d of vigentes) {
    const a = aceptadas.find((x) => x && x.clave === d.clave);
    if (!a || a.hash !== d.hash) throw new ErrorDeRegistro(400, `Tenés que aceptar la versión vigente de: ${d.titulo}. Recargá la página.`);
  }

  try {
    const [[cuenta]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ? OR LOWER(email) = ?', [usuario.uid, email]);
    if (cuenta) throw new ErrorDeRegistro(409, 'Ese email ya tiene una cuenta en el sistema.');
    if (await estaBloqueado(db, email)) throw new ErrorDeRegistro(403, 'No podemos recibir una solicitud desde esta cuenta.', 'BLOQUEADO');

    const contacto = ['whatsapp', 'llamada', 'email'].includes(datos.contacto) ? datos.contacto : 'whatsapp';
    const valores = [nombre, empresa, telefono, contacto, entero(datos.empleados), entero(datos.relojes), recortar(datos.horarios, 255) || null];

    // Una sola solicitud viva por cuenta: si ya hay una pendiente, se actualiza.
    const [[previa]] = await db.query(`SELECT id FROM signup_leads WHERE firebase_uid = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`, [usuario.uid]);
    let leadId;
    let nueva = false;
    if (previa) {
      leadId = previa.id;
      await db.query(
        `UPDATE signup_leads SET name = ?, company_name = ?, phone = ?, contact_preference = ?, employee_count = ?, clock_count = ?, schedule_type = ?
          WHERE id = ?`, [...valores, leadId]);
    } else {
      const [r] = await db.query(
        `INSERT INTO signup_leads (name, company_name, phone, contact_preference, employee_count, clock_count, schedule_type,
                                   email, status, firebase_uid, origen, email_verificado, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'sistema', 1, ?)`,
        [...valores, email, usuario.uid, recortar(contexto.ip, 64) || null]);
      leadId = r.insertId;
      nueva = true;
    }

    // Prueba de la aceptación: una fila por documento (solo se agrega).
    for (const d of vigentes) {
      await db.query(
        `INSERT INTO aceptaciones_legales (creado_en, firebase_uid, email, signup_lead_id, documento, version, hash_texto, ip, navegador)
         VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [usuario.uid, email, leadId, d.clave, d.version, d.hash, recortar(contexto.ip, 64) || null, recortar(contexto.navegador, 255) || null]);
    }
    return { leadId, nueva, email, empresa, nombre, telefono, contacto, empleados: entero(datos.empleados), relojes: entero(datos.relojes) };
  } catch (err) {
    if (faltaMigracion(err)) throw new ErrorDeRegistro(503, MSJ_FALTA_MIGRACION);
    throw err;
  }
}

// --- Spam: borrar y bloquear ------------------------------------------------
// La cuenta de login se borra / deshabilita SOLO si no tiene acceso al
// sistema (no es un usuario de ninguna empresa).
async function cuentaDeLoginSinAcceso(db, uid) {
  if (!uid) return false;
  const [[u]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [uid]);
  return !u;
}

async function borrarCuentaDeLogin(uid) {
  initFirebaseAdmin();
  try { await admin.auth().deleteUser(uid); return true; } catch (err) {
    if (err && err.code === 'auth/user-not-found') return true;
    console.error('Registro: no se pudo borrar la cuenta de login', err.message);
    return false;
  }
}

/** Borra una solicitud pendiente (spam o vencida) y, si corresponde, su cuenta de login. */
async function borrarSolicitud(db, leadId) {
  const [[lead]] = await db.query('SELECT id, status, firebase_uid FROM signup_leads WHERE id = ?', [leadId]);
  if (!lead) throw new ErrorDeRegistro(404, 'Solicitud no encontrada');
  if (lead.status === 'provisioned') throw new ErrorDeRegistro(409, 'Esa solicitud ya creó una empresa: no se borra desde acá.');
  let loginBorrado = false;
  if (await cuentaDeLoginSinAcceso(db, lead.firebase_uid)) loginBorrado = await borrarCuentaDeLogin(lead.firebase_uid);
  await db.query('DELETE FROM aceptaciones_legales WHERE signup_lead_id = ?', [leadId]).catch((e) => { if (!faltaMigracion(e)) throw e; });
  await db.query('DELETE FROM signup_leads WHERE id = ?', [leadId]);
  return { borrada: true, loginBorrado };
}

/** Bloquea el email (o el dominio) de una solicitud, la marca bloqueada y deshabilita su cuenta de login. */
async function bloquearSolicitud(db, leadId, { porDominio = false, motivo = null } = {}, revisadoPor = null) {
  const [[lead]] = await db.query('SELECT id, status, email, firebase_uid FROM signup_leads WHERE id = ?', [leadId]);
  if (!lead) throw new ErrorDeRegistro(404, 'Solicitud no encontrada');
  if (lead.status === 'provisioned') throw new ErrorDeRegistro(409, 'Esa solicitud ya creó una empresa: no se bloquea desde acá.');
  const dominio = dominioDe(lead.email);
  if (porDominio && ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'live.com'].includes(dominio)) {
    throw new ErrorDeRegistro(400, `No se bloquea un dominio público (${dominio}): bloqueá solo el email.`);
  }
  try {
    await db.query('INSERT IGNORE INTO registro_bloqueos (tipo, valor, motivo, creado_por) VALUES (?, ?, ?, ?)',
      [porDominio ? 'dominio' : 'email', porDominio ? dominio : String(lead.email).toLowerCase(), recortar(motivo, 255) || 'spam', revisadoPor]);
    await db.query(`UPDATE signup_leads SET status = 'blocked', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?`,
      [revisadoPor, recortar(motivo, 500) || 'Bloqueada por spam', leadId]);
  } catch (err) {
    if (faltaMigracion(err)) throw new ErrorDeRegistro(503, MSJ_FALTA_MIGRACION);
    throw err;
  }
  let loginDeshabilitado = false;
  if (await cuentaDeLoginSinAcceso(db, lead.firebase_uid)) {
    initFirebaseAdmin();
    try { await admin.auth().updateUser(lead.firebase_uid, { disabled: true }); loginDeshabilitado = true; } catch (err) {
      if (err && err.code !== 'auth/user-not-found') console.error('Registro: no se pudo deshabilitar la cuenta', err.message);
    }
  }
  return { bloqueada: true, loginDeshabilitado, valor: porDominio ? dominio : lead.email };
}

async function listarBloqueos(db) {
  try {
    const [r] = await db.query('SELECT id, tipo, valor, motivo, creado_en FROM registro_bloqueos ORDER BY creado_en DESC');
    return r;
  } catch (err) { if (faltaMigracion(err)) return []; throw err; }
}

async function quitarBloqueo(db, id) {
  await db.query('DELETE FROM registro_bloqueos WHERE id = ?', [id]);
}

// --- Limpieza: solicitudes del sistema sin aprobar a los 30 días -------------
async function borrarSolicitudesVencidas(db, { dias = DIAS_PARA_BORRAR_SIN_APROBAR } = {}) {
  let vencidas;
  try {
    [vencidas] = await db.query(
      `SELECT id FROM signup_leads WHERE origen = 'sistema' AND status IN ('pending', 'rejected')
         AND created_at < NOW() - INTERVAL ? DAY`, [dias]);
  } catch (err) {
    if (faltaMigracion(err)) return 0;
    throw err;
  }
  let n = 0;
  for (const { id } of vencidas) {
    try { await borrarSolicitud(db, id); n++; } catch (err) { console.error('Limpieza de solicitudes: no se pudo borrar', id, err.message); }
  }
  return n;
}

// Al aprobar: la aceptación queda asociada a la empresa creada.
async function asociarAceptacionesALaEmpresa(db, leadId, tenantId) {
  await db.query('UPDATE aceptaciones_legales SET tenant_id = ? WHERE signup_lead_id = ?', [tenantId, leadId])
    .catch((err) => { if (!faltaMigracion(err)) throw err; });
}

module.exports = {
  DIAS_PARA_BORRAR_SIN_APROBAR, documentosLegales, validarSolicitud, estadoDeLaCuenta, crearSolicitud, borrarSolicitud,
  bloquearSolicitud, listarBloqueos, quitarBloqueo, borrarSolicitudesVencidas, asociarAceptacionesALaEmpresa,
  ErrorDeRegistro, estaBloqueado,
};
