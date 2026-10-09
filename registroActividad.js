// ============================================================================
// Registro de actividad: quién hizo qué, en qué empresa (2026-10-09).
// Tabla: migrations/20261017_registro_actividad.sql
// ============================================================================
//
// QUE PROBLEMA RESUELVE
// ---------------------
// El superadmin puede trabajar dentro de una empresa (modo soporte, ver
// appUserMiddleware.js). Si después alguien dice "ese feriado lo cargó el
// superadmin", hay que poder mostrar quién fue de verdad. Y lo mismo entre
// las personas de una empresa: cada cambio queda con su autor.
//
// COMO FUNCIONA
// -------------
// Un middleware mira TODOS los pedidos que cambian algo (POST, PUT, PATCH,
// DELETE) de un usuario identificado. No toca el pedido: espera a que la
// respuesta termine (evento 'finish' de Express) y recién ahí guarda una
// fila con el resultado (si salió bien o no). Así:
//   - no hay que acordarse de agregar auditoría en cada ruta nueva: cualquier
//     ruta que se agregue queda registrada sola;
//   - guardar el registro nunca demora ni rompe la respuesta: si falla (por
//     ejemplo, falta la migración), se avisa en el log del servidor y listo.
//
// La auditoría más fina que ya existía (manual_entry_log, user_exclusion_log,
// con el valor de antes y de después) sigue igual: esto es el "quién y
// cuándo" general, no la reemplaza.
//
// QUE NO SE GUARDA
// ----------------
// Contraseñas, tokens, claves, firmas: se sacan antes de guardar (ver
// `limpiar`). Y el detalle se corta a 4000 caracteres: una importación de
// fichajes puede mandar miles de filas y no hace falta copiarlas todas acá.

const db = require('./db');

const METODOS_QUE_CAMBIAN = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LARGO_MAXIMO_DETALLE = 4000;
const CLAVE_SECRETA = /pass|contrase|token|secret|clave|firma|authorization|api[_-]?key/i;

// Pedidos POST que no cambian nada (solo calculan o consultan) y no hace
// falta registrar: harían ruido en el registro.
const SOLO_CONSULTA = [
  /\/simulate$/,
  /\/api\/ayuda/,
  /\/chat/,
];

// Qué se está tocando, en palabras de quien usa el sistema. El primero que
// coincide gana, por eso lo más específico va arriba.
const QUE_ES = [
  [/\/api\/holidays\/varias-empresas/, 'un feriado en varias empresas'],
  [/\/api\/holidays/, 'un feriado'],
  [/\/api\/labor-engine\/admin\/templates\/asistente/, 'un horario (asistente)'],
  [/\/api\/labor-engine\/admin\/templates\/\d+\/ciclo/, 'el ciclo de un horario rotativo'],
  [/\/api\/labor-engine\/admin\/(templates|blocks)/, 'una plantilla de horario'],
  [/\/api\/labor-engine\/admin\/employees\/bulk-assign-calendar/, 'el horario de varios empleados'],
  [/\/api\/labor-engine\/admin\/employees\/\d+\/calendar/, 'el horario de un empleado'],
  [/\/api\/labor-engine\/admin\/tenants/, 'una empresa'],
  [/\/api\/labor-engine/, 'la configuración de horarios/convenios'],
  [/\/api\/employees/, 'un empleado'],
  [/\/api\/employee-events/, 'una novedad de empleado'],
  [/\/api\/leave-balances/, 'un saldo de licencias'],
  [/\/api\/employee-categories/, 'una categoría'],
  [/\/api\/ciudades/, 'una ciudad'],
  [/\/api\/sucursales/, 'una sucursal'],
  [/\/api\/app-users/, 'un usuario'],
  [/\/api\/roles/, 'un rol'],
  [/\/api\/matching/, 'una vinculación de fichajes (matching)'],
  [/\/api\/import|\/import\//, 'una importación'],
  [/\/api\/manual-checkins|\/(add|update|delete)\/manual/, 'un fichaje o carga manual'],
  [/\/marker-corrections/, 'una corrección de marcador'],
  [/\/config\/user-exclusion|\/config\/toggle-user-exclusion/, 'una exclusión'],
  [/\/config\/special-users/, 'un usuario especial'],
  [/\/campana/, 'la campaña'],
  [/\/api\/regimen-horas-extra/, 'el régimen de horas extra'],
  [/\/api\/liquidacion-horas-extra/, 'la liquidación de horas extra'],
  [/\/api\/portal-empleados/, 'el portal del empleado'],
  [/\/api\/solicitudes-alta/, 'una solicitud de alta'],
  [/\/api\/billing/, 'la facturación'],
  [/\/api\/agent-keys/, 'una clave del agente de fichajes'],
  [/\/config\//, 'la configuración'],
];

function describir(metodo, ruta) {
  const encontrado = QUE_ES.find(([re]) => re.test(ruta));
  const que = encontrado ? encontrado[1] : ruta;
  if (metodo === 'DELETE') return `Borró ${que}`;
  if (metodo === 'PUT' || metodo === 'PATCH') return `Modificó ${que}`;
  // POST a /config/... es "guardar una opción", no "crear".
  if (/\/config\//.test(ruta)) return `Cambió ${que}`;
  return `Creó/cargó ${que}`;
}

// Copia del cuerpo sin nada secreto. Recorre objetos y listas; las listas
// largas se resumen (en una importación interesa cuántas filas, no cada una).
function limpiar(valor, profundidad = 0) {
  if (valor == null || typeof valor !== 'object') return valor;
  if (profundidad > 4) return '…';
  if (Array.isArray(valor)) {
    const primeros = valor.slice(0, 20).map((v) => limpiar(v, profundidad + 1));
    return valor.length > 20 ? [...primeros, `… y ${valor.length - 20} más`] : primeros;
  }
  const out = {};
  for (const [k, v] of Object.entries(valor)) {
    out[k] = CLAVE_SECRETA.test(k) ? '[oculto]' : limpiar(v, profundidad + 1);
  }
  return out;
}

function detalleDe(req) {
  const datos = {};
  if (req.query && Object.keys(req.query).length) datos.consulta = limpiar(req.query);
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) datos.datos = limpiar(req.body);
  if (req.file) datos.archivo = req.file.originalname;
  if (!Object.keys(datos).length) return null;
  const texto = JSON.stringify(datos);
  return texto.length > LARGO_MAXIMO_DETALLE ? `${texto.slice(0, LARGO_MAXIMO_DETALLE)}…` : texto;
}

// Empresa afectada. Un usuario normal (o el superadmin trabajando en una
// empresa): la suya. El superadmin en modo plataforma: la que mandó en el
// pedido, si mandó alguna (ej. alta de un feriado eligiendo empresa).
function empresaDe(req) {
  const u = req.appUser;
  if (!u.isSuperadmin) return u.tenantId ?? null;
  const elegida = (req.body && (req.body.tenant_id ?? req.body.tenantId)) ?? req.query.tenantId ?? req.params?.tenantId;
  const n = Number(elegida);
  return Number.isInteger(n) && n > 0 ? n : null;
}

let avisoFaltaTabla = false;

/** Guarda una fila. Nunca lanza: un registro que falla no rompe nada. */
async function registrar(conexion, fila) {
  try {
    await conexion.query(
      // Hora en UTC explícita: no depende de la zona horaria del servidor de
      // la base; la pantalla la muestra en la hora local de quien mira.
      `INSERT INTO registro_actividad
         (creado_en, tenant_id, app_user_id, email, como_soporte, metodo, ruta, descripcion, estado, detalle, ip)
       VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fila.tenantId ?? null, fila.appUserId ?? null, fila.email ?? null, fila.comoSoporte ? 1 : 0,
        fila.metodo, String(fila.ruta).slice(0, 255), fila.descripcion ? String(fila.descripcion).slice(0, 255) : null,
        fila.estado ?? null, fila.detalle ?? null, fila.ip ? String(fila.ip).slice(0, 64) : null]
    );
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') {
      if (!avisoFaltaTabla) {
        avisoFaltaTabla = true;
        console.warn('Registro de actividad: falta la migración 20261017_registro_actividad.sql (no se registra nada hasta correrla).');
      }
      return;
    }
    console.error('Registro de actividad: no se pudo guardar:', err.message);
  }
}

/** Datos comunes de quién hace el pedido (para usar también desde una ruta). */
function autorDe(req) {
  const u = req.appUser || {};
  return {
    appUserId: u.id ?? null,
    email: u.soporte ? u.soporte.email : (u.email ?? null),
    comoSoporte: !!u.soporte,
    ip: req.ip,
  };
}

function middlewareRegistroActividad(req, res, next) {
  if (!METODOS_QUE_CAMBIAN.has(req.method) || !req.appUser) return next();
  const ruta = (req.originalUrl || req.url).split('?')[0];
  if (SOLO_CONSULTA.some((re) => re.test(ruta))) return next();
  res.on('finish', () => {
    registrar(db, {
      ...autorDe(req),
      tenantId: empresaDe(req),
      metodo: req.method,
      ruta,
      descripcion: describir(req.method, ruta),
      estado: res.statusCode,
      detalle: detalleDe(req),
    });
  });
  return next();
}

module.exports = { middlewareRegistroActividad, registrar, autorDe, describir, limpiar };
