const { getAppSetting } = require('../repositories/appSettingsRepository');
const { checkAccess } = require('../services/countryFirewallService');

const SETTING_COUNTRIES = 'firewallAllowedCountries';
const SETTING_IPS = 'firewallAllowedIps';
// Cache corto en memoria -- esto corre en /api/public, la ruta que mas
// trafico de bots puede recibir; sin cache, cada pedido (legitimo o no)
// pegaria 2 SELECT a app_settings solo para el firewall. 60s alcanza de
// sobra para un valor que un superadmin cambia manualmente muy de vez
// en cuando, y el propio panel de administracion avisa que el cambio
// puede tardar hasta un minuto en aplicar.
const CACHE_MS = 60 * 1000;
let cache = { at: 0, countriesCsv: '', ipsCsv: '' };

async function loadSettings(db) {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache;
  const [countriesCsv, ipsCsv] = await Promise.all([
    getAppSetting(SETTING_COUNTRIES, null, db),
    getAppSetting(SETTING_IPS, null, db)
  ]);
  cache = { at: now, countriesCsv: countriesCsv || '', ipsCsv: ipsCsv || '' };
  return cache;
}

// Solo se aplica a /api/public (ver security.js/routes/public.js) -- un
// usuario ya logueado de una empresa real nunca deberia quedar afuera
// por viajar o usar una VPN, la unica superficie sin cuenta es la que
// necesita este filtro.
function createCountryFirewallMiddleware(db) {
  return async function countryFirewallMiddleware(req, res, next) {
    try {
      const { countriesCsv, ipsCsv } = await loadSettings(db);
      const result = checkAccess({ ip: req.ip, allowedCountriesCsv: countriesCsv, allowedIpsCsv: ipsCsv });
      if (!result.allowed) {
        console.warn(`[firewall] bloqueado ${req.ip} (${result.country}) en ${req.method} ${req.path}`);
        return res.status(403).json({ error: 'Este servicio no está disponible desde tu ubicación por el momento.' });
      }
      next();
    } catch (err) {
      // Fail-open: un error del firewall (ej. la base caida un instante)
      // no debe tumbar el alta/chat de ventas -- se deja pasar y se
      // loguea, el resto de las capas (captcha, rate-limit) siguen de pie.
      console.error('[firewall] error evaluando pais/IP, se deja pasar:', err.message);
      next();
    }
  };
}

// Para tests: fuerza a releer app_settings en el proximo pedido.
function invalidateCache() {
  cache = { at: 0, countriesCsv: '', ipsCsv: '' };
}

module.exports = { createCountryFirewallMiddleware, invalidateCache, SETTING_COUNTRIES, SETTING_IPS };
