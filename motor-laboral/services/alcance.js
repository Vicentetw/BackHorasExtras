// Usuarios limitados a algunas áreas (2026-10-26, punto Q de
// REVISION_PROFUNDA_2026-10-26.md, sección 8; migración 20261025_areas).
//
// Un usuario con áreas elegidas (tabla app_user_areas) ve y toca SOLO a los
// empleados de esas áreas. Un usuario sin áreas ve toda la empresa, como
// siempre: para él este archivo no hace nada (ni una consulta de más).
//
// CÓMO SE CUIDA QUE NO SE ESCAPE NADA: es una LISTA BLANCA, igual que el
// portal del empleado. Para un usuario limitado, cada ruta tiene que estar en
// REGLAS; la que no está responde 403. Si mañana se agrega una pantalla y
// nadie se acuerda de esto, la pantalla nueva queda cerrada para él (no
// muestra gente de más). Cada regla dice qué hace:
//   libre     no tiene datos de personas (catálogos, configuración, su perfil).
//   filtrar   la respuesta trae personas: se dejan solo las de sus áreas (y se
//             recalculan los totales que las suman).
//   persona   la ruta es sobre UNA persona (o varias) que viene en el pedido:
//             si alguna no es de sus áreas, 403.
// Las listas paginadas (Empleados, Justificaciones) se filtran en su propia
// consulta: filtrar una página ya armada dejaría mal la paginación. Ver
// condicionDeAreas() y su uso en routes/employees.js y horasdedica.js.
//
// test/alcance-areas.test.js recorre las rutas con un usuario limitado y
// verifica que no aparezca nadie de otra área.

const ERROR = 'Tu usuario ve solo algunas áreas, y esto es de toda la empresa: lo hace un administrador.';
const AJENO = 'Esa persona no es de tus áreas.';

// ---------------------------------------------------------------------------
// Qué áreas ve un usuario (null = toda la empresa). Sin la migración, null.
let sinTabla = 0;
async function areasDeUsuario(db, userId) {
  if (Date.now() - sinTabla < 60_000) return null;
  try {
    const [filas] = await db.query('SELECT area_id FROM app_user_areas WHERE user_id = ?', [userId]);
    return filas.length ? filas.map((f) => Number(f.area_id)) : null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') { sinTabla = Date.now(); return null; }
    throw err;
  }
}

// Los empleados que ve (por legajo, por id interno y por número de reloj).
// Se calcula una vez por pedido.
async function visibles(db, req) {
  if (req._visibles) return req._visibles;
  const [filas] = await db.query(
    `SELECT e.id, e.employee_id AS legajo, uem.USERID AS userId
       FROM employees e
       LEFT JOIN user_employee_map uem ON uem.employee_id = e.id AND uem.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.area_id IN (?)`, [req.appUser.tenantId, req.appUser.areas]);
  const v = { legajos: new Set(), ids: new Set(), userIds: new Set() };
  for (const f of filas) {
    v.legajos.add(String(f.legajo));
    v.ids.add(Number(f.id));
    if (f.userId != null) v.userIds.add(Number(f.userId));
  }
  req._visibles = v;
  return v;
}

const limitado = (req) => !!(req.appUser && !req.appUser.isSuperadmin && req.appUser.areas && req.appUser.areas.length);

// Para las consultas paginadas: "AND <columna> IN (...)" o nada.
function condicionDeAreas(req, columna) {
  if (!limitado(req)) return { sql: '', params: [] };
  return { sql: ` AND ${columna} IN (?)`, params: [req.appUser.areas] };
}

// ---------------------------------------------------------------------------
// Ayudantes para filtrar respuestas.
const porLegajo = (lista, v, campo = 'employeeId') => (lista || []).filter((x) => v.legajos.has(String(x[campo])));
const porId = (lista, v, campo = 'employee_id') => (lista || []).filter((x) => v.ids.has(Number(x[campo])));
const legajoODeId = (lista, v) => (lista || []).filter((x) => (x.legajo != null ? v.legajos.has(String(x.legajo)) : v.ids.has(Number(x.employeeId ?? x.employee_id))));

// Se cargan tarde para no crear dependencias circulares al arrancar.
const resumenDelDia = (attendance) => require('./attendanceService').buildSummary(attendance);
const totalesLiquidacion = (filas) => require('../../routes/liquidacionHorasExtra').totales(filas);

// Busca a quién pertenece una fila guardada (para editar o borrar por id).
async function duenoDe(db, sql, id) {
  const [[f]] = await db.query(sql, [id]);
  return f || null;
}

// ---------------------------------------------------------------------------
// Las reglas. Se evalúan en orden; la primera que coincide manda.
//   m: métodos, r: expresión de la ruta (req.path).
const GET = ['GET'];
const REGLAS = [
  // --- libres: sin datos de personas ---
  { m: GET, r: /^\/api\/app-users\/me$/, libre: true },
  { m: ['GET', 'PUT'], r: /^\/api\/app-users\/me\/preferencias(\/[a-z0-9._-]+)?$/, libre: true },
  { m: ['GET', 'POST'], r: /^\/api\/segundo-factor(\/|$)/, libre: true },
  { m: GET, r: /^\/api\/puesta-en-marcha$/, libre: true },
  { m: GET, r: /^\/api\/(ciudades|sucursales|employee-categories|holidays|areas|sync-status)$/, libre: true },
  { m: GET, r: /^\/api\/event-types$/, libre: true },
  { m: GET, r: /^\/api\/event-types\/\d+\/cupos$/, libre: true },
  // Estado de los cupos por persona (employeeId = legajo).
  { m: GET, r: /^\/api\/event-types\/cupos\/estado$/, filtrar: (b, v) => ({ ...b, filas: porLegajo(b.filas, v) }) },
  // Cuánto usó una persona de un motivo: employeeId = id interno (licencias) o userId = número de reloj (justificaciones).
  { m: GET, r: /^\/api\/event-types\/\d+\/consumo$/,
    persona: async (req, v) => [req.query.employeeId != null ? v.ids.has(Number(req.query.employeeId)) : v.userIds.has(Number(req.query.userId))] },
  { m: GET, r: /^\/api\/leave-balances\/vacation-scale$/, libre: true },
  { m: GET, r: /^\/api\/employee-events\/preview-dias$/, libre: true }, // cuenta días de un rango, sin personas
  { m: GET, r: /^\/api\/labor-engine\/admin\/templates\/\d+\/(blocks|ciclo)$/, libre: true },
  { m: GET, r: /^\/config\/schedule\/[\d-]+$/, libre: true },
  // "Ver el reloj" muestra lo que pasó en el aparato alrededor de un fichaje,
  // con OTRAS personas: para un limitado, cerrado (la pantalla no lo ofrece).
  { m: GET, r: /^\/api\/ver-reloj$/, cerrada: true },
  { m: GET, r: /^\/api\/labor-engine\/admin\/(templates|templates\/uso|turnos|conventions|conventions\/\d+\/regimes|day-type-rules)$/, libre: true },
  { m: GET, r: /^\/api\/billing\//, libre: true },
  { m: GET, r: /^\/api\/config-horas-extra$/, libre: true },
  // /config/*: opciones de la empresa. Las que traen personas tienen su
  // propia regla más abajo o quedan cerradas.
  { m: GET, r: /^\/config\/(excluded-users|special-users|user-exclusion\/|toggle-user-exclusion)/, cerrada: true },
  { m: GET, r: /^\/config\/manual-entries$/,
    persona: async (req, v) => [v.userIds.has(Number(req.query.userId))] },
  { m: GET, r: /^\/config\/user-exclusions$/, libre: true }, // filtrada en su consulta (horasdedica.js)
  { m: GET, r: /^\/config\/[a-z-]+$/, libre: true },

  // --- listas con personas: se filtran ---
  { m: GET, r: /^\/api\/employees$/, libre: true }, // filtrada en su consulta (routes/employees.js)
  { m: GET, r: /^\/api\/manual-checkins$/, libre: true }, // filtrada en su consulta (horasdedica.js)
  { m: GET, r: /^\/api\/employees\/stats$/, reemplazar: estadisticasDeEmpleados },
  { m: GET, r: /^\/api\/labor-engine\/attendance\/[\d-]+$/,
    filtrar: (b, v) => { const attendance = porLegajo(b.attendance, v); return { ...b, attendance, summary: resumenDelDia(attendance) }; } },
  { m: GET, r: /^\/attendance-range$/, filtrar: (b, v) => ({ ...b, data: porLegajo(b.data, v) }) },
  { m: GET, r: /^\/movements-range$/, filtrar: (b, v) => ({ ...b, rows: porLegajo(b.rows, v), summary: porLegajo(b.summary, v) }) },
  { m: GET, r: /^\/campana-range$/, filtrar: (b, v) => ({ ...b, rows: porLegajo(b.rows, v) }) },
  { m: GET, r: /^\/api\/fichajes-del-dia$/,
    filtrar: (b, v) => ({ ...b, empleados: Object.fromEntries(Object.entries(b.empleados || {}).filter(([leg]) => v.legajos.has(String(leg)))) }) },
  { m: GET, r: /^\/api\/employee-events$/, filtrar: (b, v) => ({ ...b, events: porId(b.events, v) }) },
  { m: GET, r: /^\/api\/employee-events\/vencimientos$/, filtrar: (b, v) => ({ ...b, filas: legajoODeId(b.filas, v) }) },
  { m: GET, r: /^\/api\/leave-balances$/, filtrar: (b, v) => ({ ...b, balances: legajoODeId(b.balances, v) }) },
  { m: GET, r: /^\/api\/liquidacion-horas-extra$/,
    filtrar: (b, v) => {
      const filas = porLegajo(b.filas, v, 'legajo');
      const r = { ...b, filas, totales: totalesLiquidacion(filas) };
      if (b.diferencias) r.diferencias = porLegajo(b.diferencias, v, 'legajo');
      return r;
    } },
  { m: GET, r: /^\/api\/liquidacion-horas-extra\/cierres$/, libre: true },
  { m: GET, r: /^\/api\/horas-extra-revisar$/,
    filtrar: (b, v) => {
      const dias = porLegajo(b.dias, v, 'legajo');
      const pend = dias.filter((d) => !d.revisado);
      return { ...b, dias, pendientes: pend.length, minutosPendientes: pend.reduce((s, d) => s + (Number(d.minutos) || 0), 0) };
    } },
  { m: GET, r: /^\/api\/labor-engine\/admin\/employees$/, filtrar: (b, v) => porLegajo(b, v, 'employee_id') },
  { m: GET, r: /^\/api\/config-horas-extra\/autorizados$/, filtrar: (b, v) => porLegajo(b, v, 'legajo') },
  // H1: horas extra sin habilitar (employeeId = legajo).
  { m: GET, r: /^\/api\/config-horas-extra\/sin-habilitar$/, filtrar: (b, v) => ({ ...b, personas: porLegajo(b.personas, v) }) },

  // --- sobre una persona ---
  { m: GET, r: /^\/api\/fichajes-persona$/, persona: async (req, v) => [v.legajos.has(String(req.query.legajo))] },
  { m: GET, r: /^\/api\/ausencias\/persona$/, persona: async (req, v) => [v.legajos.has(String(req.query.legajo))] },
  { m: GET, r: /^\/api\/leave-balances\/(suggest\/)?\d+(\/\d{4})?$/,
    persona: async (req, v) => [v.legajos.has(req.path.split('/').filter(Boolean)[req.path.includes('/suggest/') ? 3 : 2])] },
  { m: ['POST'], r: /^\/config\/user-exclusions(\/range)?$/, persona: async (req, v) => [v.userIds.has(Number(req.body?.userId))] },
  { m: ['PUT', 'DELETE'], r: /^\/config\/user-exclusions\/\d+$/,
    persona: async (req, v, db) => { const f = await duenoDe(db, 'SELECT userId FROM userexclusions WHERE id = ?', req.path.split('/').pop()); return [!f || v.userIds.has(Number(f.userId))]; } },
  { m: ['POST'], r: /^\/api\/employee-events$/, persona: async (req, v) => [v.ids.has(Number(req.body?.employeeId))] },
  { m: ['PUT', 'DELETE'], r: /^\/api\/employee-events\/\d+$/,
    persona: async (req, v, db) => { const f = await duenoDe(db, 'SELECT employee_id FROM employee_events WHERE id = ?', req.path.split('/').pop()); return [!f || v.ids.has(Number(f.employee_id))]; } },
  { m: ['POST'], r: /^\/api\/leave-balances$/, persona: async (req, v) => [v.ids.has(Number(req.body?.employeeId))] },
  { m: ['POST'], r: /^\/api\/manual-checkins$/, persona: async (req, v) => (Array.isArray(req.body?.entries) ? req.body.entries : []).map((e) => v.legajos.has(String(e?.employeeId))) },
  { m: ['DELETE'], r: /^\/api\/manual-checkins\/\d+$/,
    persona: async (req, v, db) => { const f = await duenoDe(db, 'SELECT USERID FROM Checkins WHERE id = ?', req.path.split('/').pop()); return [!f || v.userIds.has(Number(f.USERID))]; } },
  { m: ['POST'], r: /^\/add\/manual$/, persona: async (req, v) => [v.userIds.has(Number(req.body?.userId))] },
  { m: ['PUT', 'DELETE'], r: /^\/(update|delete)\/manual\/\d+$/,
    persona: async (req, v, db) => { const f = await duenoDe(db, 'SELECT userId FROM ManualEntries WHERE id = ?', req.path.split('/').pop()); return [!f || v.userIds.has(Number(f.userId))]; } },
  { m: ['POST'], r: /^\/salidas\/(justificaciones|autorizaciones)$/, persona: async (req, v) => (Array.isArray(req.body?.items) ? req.body.items : []).map((i) => v.legajos.has(String(i?.legajo))) },
  { m: ['POST'], r: /^\/api\/horas-extra-revisar\/aceptar$/, persona: async (req, v) => [v.legajos.has(String(req.body?.legajo))] },
  { m: ['DELETE'], r: /^\/api\/horas-extra-revisar\/aceptar$/, persona: async (req, v) => [v.legajos.has(String(req.query?.legajo))] },
  { m: ['POST'], r: /^\/api\/regimen-horas-extra\/(autorizaciones|aprobaciones)$/, persona: async (req, v) => [v.legajos.has(String(req.body?.legajo ?? req.body?.employeeId))] },
  { m: ['PUT'], r: /^\/api\/employees\/\d+$/, persona: async (req, v) => [v.ids.has(Number(req.path.split('/').pop()))] },
];

// Empleados: los mismos números que /api/employees/stats, contando solo sus áreas.
async function estadisticasDeEmpleados(req, db) {
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS total, SUM(activo = 1) AS active, SUM(activo = 0) AS inactive,
            SUM(overtime_authorized = 1) AS authorized, SUM(overtime_authorized = 0) AS unauthorized,
            SUM(exclude_from_report = 1) AS excluded
       FROM employees WHERE tenant_id = ? AND area_id IN (?)`, [req.appUser.tenantId, req.appUser.areas]);
  const [[m]] = await db.query(
    `SELECT COUNT(DISTINCT e.id) AS matched FROM employees e
       JOIN user_employee_map uem ON uem.employee_id = e.id AND uem.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.area_id IN (?)`, [req.appUser.tenantId, req.appUser.areas]);
  const n = (x) => Number(x || 0);
  return { total: n(r.total), active: n(r.active), inactive: n(r.inactive), authorized: n(r.authorized), unauthorized: n(r.unauthorized),
    excluded: n(r.excluded), matched: n(m.matched), unmatched: n(r.total) - n(m.matched) };
}

// ---------------------------------------------------------------------------
// El middleware: corre después de appUserMiddleware, para todos.
function alcanceMiddleware(db) {
  return async (req, res, next) => {
    const u = req.appUser;
    // Superadmin, soporte, portal del empleado o sin login: no aplica.
    if (!u || u.isSuperadmin || u.soporte || u.employeeId != null || u.tenantId == null) return next();
    try {
      u.areas = await areasDeUsuario(db, u.id);
      if (!limitado(req)) return next();
      if (req.method === 'OPTIONS') return next();
      const regla = REGLAS.find((x) => x.m.includes(req.method) && x.r.test(req.path));
      if (!regla || regla.cerrada) return res.status(403).json({ error: ERROR, codigo: 'AREA_LIMITADA' });
      if (regla.libre) return next();
      const v = await visibles(db, req);
      if (regla.reemplazar) return res.json(await regla.reemplazar(req, db));
      if (regla.persona) {
        const resultados = await regla.persona(req, v, db);
        if (!resultados.length || resultados.some((ok) => !ok)) return res.status(403).json({ error: AJENO, codigo: 'AREA_AJENA' });
        return next();
      }
      // filtrar: la respuesta se recorta antes de salir. Si algo falla al
      // recortar, no se manda nada (mejor un error que datos de más).
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 400 || body == null) return json(body);
        try {
          return json(regla.filtrar(body, v));
        } catch (err) {
          console.error('alcance: no se pudo filtrar', req.path, err);
          res.status(500);
          return json({ error: 'No se pudo armar la respuesta para tus áreas.' });
        }
      };
      return next();
    } catch (err) {
      console.error('alcanceMiddleware error:', err);
      return res.status(500).json({ error: 'Error resolviendo las áreas del usuario' });
    }
  };
}

module.exports = { alcanceMiddleware, areasDeUsuario, condicionDeAreas, limitado, REGLAS };
