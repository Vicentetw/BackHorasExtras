const geoip = require('geoip-lite');

// Fase 19 (firewall por pais): filtro de "ruido" para /api/public -- la
// UNICA superficie del sistema alcanzable sin ninguna cuenta (ver
// routes/public.js). No es una barrera de seguridad fuerte (cualquiera
// con una VPN de Argentina la esquiva), es para bajar el volumen de
// bots/scanners automatizados que hoy pegan desde cualquier pais sin
// ningun motivo real de negocio -- el usuario explicito: "hoy no voy a
// vender fuera, ni a chinos ni a rusia".
//
// Deliberadamente en el propio proceso Node (geoip-lite trae su base de
// datos empaquetada, sin llamar a ningun servicio externo por request,
// sin sumar latencia real) en vez de un WAF de borde (Cloudflare) --
// eso queda como upgrade el dia que haya un dominio propio delante de
// Render (ver conversacion). Esto funciona HOY sin comprar nada.

// Le saca el prefijo IPv6-mapeado que agrega Node para conexiones IPv4
// (ej. '::ffff:190.2.3.4') -- sin esto geoip-lite no reconoce la IPv4 de
// adentro.
function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// Devuelve el codigo de pais (ISO 3166-1 alpha-2, ej. 'AR') o null si no
// se pudo resolver -- IPs privadas/de loopback (127.0.0.1, 192.168.x,
// desarrollo local) SIEMPRE dan null aca, es el comportamiento esperado
// de geoip-lite (no tienen geolocalizacion real), no un error.
function resolveCountry(ip) {
  const clean = normalizeIp(ip);
  if (!clean) return null;
  const result = geoip.lookup(clean);
  return result ? result.country : null;
}

function parseList(csv) {
  if (!csv) return [];
  return String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Soporta IP exacta y CIDR IPv4 (ej. '190.2.3.0/24') -- suficiente para
// el caso real (una oficina con IP fija, un rango del proveedor de
// internet). CIDR de IPv6 no soportado a proposito (caso raro para este
// uso, se puede sumar despues si hace falta) -- una excepcion IPv6 solo
// funciona como match exacto.
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchesCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function isIpException(ip, exceptions) {
  const clean = normalizeIp(ip);
  return exceptions.some((entry) => (entry.includes('/') ? matchesCidr(clean, entry) : entry === clean));
}

// Regla central. allowedCountriesCsv vacio/no configurado = firewall
// DESACTIVADO (permite todo) -- a proposito, para que activarlo sea un
// paso explicito del superadmin y nunca bloquee a todo el mundo antes
// de que alguien lo configure a mano por primera vez.
//
// Si no se puede resolver el pais (IP privada, base de datos sin ese
// rango) se permite igual (fail-open): un falso positivo bloqueando a
// un cliente real de Argentina es peor que dejar pasar a alguien que no
// se pudo identificar -- para eso esta el resto de las capas (captcha,
// rate-limit, permisos).
// resolveCountryFn inyectable solo para tests -- evita que el suite
// dependa de que rangos de IP concretos tenga cargados el geoip-lite
// bundleado (esos datos van cambiando de version a version).
function checkAccess({ ip, allowedCountriesCsv, allowedIpsCsv, resolveCountryFn = resolveCountry }) {
  const allowedCountries = parseList(allowedCountriesCsv).map((c) => c.toUpperCase());
  const exceptions = parseList(allowedIpsCsv);

  if (isIpException(ip, exceptions)) {
    return { allowed: true, reason: 'ip_exception', country: null };
  }
  if (allowedCountries.length === 0) {
    return { allowed: true, reason: 'firewall_disabled', country: null };
  }

  const country = resolveCountryFn(ip);
  if (!country) {
    return { allowed: true, reason: 'country_unknown', country: null };
  }
  if (allowedCountries.includes(country)) {
    return { allowed: true, reason: 'country_allowed', country };
  }
  return { allowed: false, reason: 'country_blocked', country };
}

module.exports = { checkAccess, resolveCountry, isIpException, parseList, normalizeIp };
