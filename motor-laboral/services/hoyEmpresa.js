// ============================================================================
// "Hoy" segun la zona horaria de la EMPRESA, no la del servidor
// ============================================================================
//
// Render corre en UTC. `new Date().toISOString().slice(0, 10)` en el servidor
// da la fecha UTC: en Argentina, desde las 21:00 ya es "mañana". El mismo
// error aparecio en el frontend (Presentismo abria en el dia siguiente a las
// 23:35, 2026-09-28).
//
// Cada empresa tiene su zona en tenants.timezone (default
// America/Argentina/Buenos_Aires). Usar esto cuando un endpoint necesita
// "hoy" y el cliente no mando una fecha. Tambien es lo que va a hacer falta
// para un cliente de otro pais.
const ZONA_DEFAULT = 'America/Argentina/Buenos_Aires';

/** 'AAAA-MM-DD' de `d` en la zona dada. Zona invalida o vacia: Argentina. */
function fechaEnZona(zona, d = new Date()) {
  const formato = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  try {
    return formato(zona || ZONA_DEFAULT);
  } catch (_) {
    return formato(ZONA_DEFAULT); // zona mal escrita en la base: no romper
  }
}

async function hoyDeEmpresa(db, tenantId) {
  let zona = null;
  if (tenantId != null) {
    const [[t]] = await db.query('SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    zona = t ? t.timezone : null;
  }
  return fechaEnZona(zona);
}

module.exports = { fechaEnZona, hoyDeEmpresa, ZONA_DEFAULT };
