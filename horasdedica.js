require('dotenv').config();
// quitar require('dotenv') si no usas .env local, y configurar variables de entorno en tu hosting
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { securityMiddlewares, apiKeyWarning } = require('./security');
const { resolveTenantId, requirePermission, requireSuperadmin, requireActiveSubscription } = require('./appUserMiddleware');
// Auditoria de cargas manuales (horas extra, licencias, exclusiones): quien
// las creo/modifico/borro y que decian antes. Ver auditLog.js y la migracion
// 20260927_manual_entries_exclusions_audit.sql.
const auditLog = require('./auditLog');
const importRoutes = require('./routes/import.routes');
const matchingRoutes = require('./routes/matching.routes');
const employeesRoutes = require('./routes/employees');
const holidaysRoutes = require('./routes/holidays');
const eventTypesRoutes = require('./routes/eventTypes');
const employeeEventsRoutes = require('./routes/employeeEvents');
const leaveBalancesRoutes = require('./routes/leaveBalances');
const employeeCategoriesRoutes = require('./routes/employeeCategories');
const ciudadesRoutes = require('./routes/ciudades');
const sucursalesRoutes = require('./routes/sucursales');
const appUsersRoutes = require('./routes/appUsers');
const rolesRoutes = require('./routes/roles');
const billingRoutes = require('./routes/billing');
const agentRoutes = require('./routes/agent');
const agentKeysRoutes = require('./routes/agentKeys');
const syncStatusRoutes = require('./routes/syncStatus');
const { insertCheckinsBatch, upsertUsersBatch, MAX_RECORDS_PER_MANUAL_IMPORT } = require('./motor-laboral/services/checkinsIngestService');
const createMotorLaboralRoutes = require('./motor-laboral/index');
const scheduleRepository = require('./motor-laboral/repositories/scheduleRepository');
const userRepository = require('./motor-laboral/repositories/userRepository');
const employeeEventRepository = require('./motor-laboral/repositories/employeeEventRepository');
const attendanceCalc = require('./motor-laboral/services/attendanceCalculations');
const movementsCalc = require('./motor-laboral/services/movementsCalculations');
const overtimeCalc = require('./motor-laboral/services/overtimeCalculations');
const { getAppSetting, setAppSetting } = require('./motor-laboral/repositories/appSettingsRepository');
const { holidayAppliesToEmployee, isNonWorkHoliday } = require('./motor-laboral/services/holidayScope');
// Etapa 12 del plan "Motor de reglas de asistencia configurable" (ver
// "fases para impletentar avance.txt") -- modo de comparacion/sombra.
// Solo se activa para una plantilla puntual con rules_engine_mode='shadow'
// (default 'legacy' para TODAS las existentes -- ver migracion
// 20260924_rules_engine_mode_and_shadow_diffs.sql). NUNCA cambia el
// resultado oficial de /attendance-range, solo agrega informacion.
const dayTypeRuleRepository = require('./motor-laboral/repositories/dayTypeRuleRepository');
const { resolveScheduleSegments } = require('./motor-laboral/services/scheduleResolver');
const { resolveToleranceConfig } = require('./motor-laboral/services/toleranceResolver');
const { computeAttendanceResult } = require('./motor-laboral/services/timeClassifier');
const { buildLegacyComparable, compareAttendanceResults } = require('./motor-laboral/services/shadowComparator');
// Etapa 14 (hallazgo #3 de la auditoria): resuelve la configuracion de
// tolerancia que regia EN LA FECHA calculada, no la actual de la
// plantilla -- ver templateConfigHistoryResolver.js.
const templateConfigHistoryRepository = require('./motor-laboral/repositories/templateConfigHistoryRepository');
const { resolveHistoricalToleranceFields } = require('./motor-laboral/services/templateConfigHistoryResolver');
// Etapa 14 (hallazgo #1 de la auditoria): resuelve el convenio vigente
// de un empleado para poder aplicar sus reglas propias de HE por tipo de
// dia -- antes, ningun modulo de calculo lo consumia.
const conventionAssignmentRepository = require('./motor-laboral/repositories/conventionAssignmentRepository');
const mercadopagoWebhookRoutes = require('./routes/mercadopagoWebhook');
const publicRoutes = require('./routes/public');

const app = express();

// Bug real de produccion (Render, ver ERR_ERL_UNEXPECTED_X_FORWARDED_FOR):
// Render pone la app detras de UN proxy propio, que agrega el header
// X-Forwarded-For con la IP real del cliente -- pero por defecto Express
// NO confia en ese header ('trust proxy' = false), asi que req.ip (y por
// lo tanto express-rate-limit, que lo usa para identificar de quien es
// cada request) devuelve siempre la IP INTERNA del proxy de Render, IGUAL
// para todo el trafico entrante. Consecuencia real: los limites de
// peticiones/minuto (apiRateLimiter 300/min, agentLimiter 30/min en
// routes/agent.js) terminaban compartiendo el mismo cupo entre TODOS los
// clientes (todos los tenants, todos los agentes de sincronizacion, todos
// los navegadores), en vez de un cupo por maquina real como esta pensado.
// 'trust proxy'=1 le dice a Express que confie en UN solo salto de proxy
// (el de Render) -- correcto para este hosting, que tiene un unico proxy
// de entrada; NO usar un numero mas alto ni 'true' (confiaria en
// cualquier X-Forwarded-For que mande el cliente mismo, permitiendo
// falsificar la IP y saltarse el rate-limit).
app.set('trust proxy', 1);

// Fase 9b: el webhook de MercadoPago se registra ANTES de express.json()
// y de securityMiddlewares() a proposito:
//   1) necesita el body CRUDO (sin parsear) para poder validar la firma
//      x-signature -- si express.json() corriera primero, req.body ya
//      vendria convertido a objeto.
//   2) MercadoPago nunca manda nuestro x-api-key ni un token de Firebase
//      (no es un usuario logueado, es el servidor de MercadoPago) -- si
//      pasara por securityMiddlewares() como cualquier otra ruta,
//      authMiddleware lo rechazaria con 401 antes de llegar a esta ruta.
//      La autenticacion de un webhook es la firma HMAC (ver
//      mercadopagoWebhook.js), no las mismas credenciales que un usuario.
// Usa su PROPIO pool (require('./db'), el modulo compartido) en vez del
// pool local `db` de mas abajo -- ese todavia no existe a esta altura del
// archivo (se crea despues de varias rutas), y esta ruta necesita quedar
// registrada antes que nada mas.
app.use('/webhooks/mercadopago', mercadopagoWebhookRoutes(require('./db')));

app.use(express.json({ limit: '1mb' }));
// Fase 11 (landing publica + alta autoservicio): /api/public es la unica
// superficie del sistema pensada para alguien SIN ninguna cuenta todavia
// -- ver security.js para el detalle de que capas salta y cuales no.
// Fase 18: /api/agent tampoco tiene sesion de Firebase (agente desatendido)
// -- se identifica con su propia clave (x-agent-key), verificada dentro de
// routes/agent.js, no con un login humano.
// Fase 20: /health -- endpoint publico, sin login, sin base de datos,
// respuesta inmediata. Lo usa el frontend (app.ts / CurrentUserService)
// como sonda de "¿el servidor de Render ya despertó?": con el plan
// gratuito, si estuvo ~15 min sin uso, el primer pedido tarda 30-60s en
// contestar mientras arranca. Con esto el front puede mostrar una
// pantalla de "despertando..." y reintentar, en vez de fallar y mandar a
// "No tenés permiso". Tambien sirve para monitoreo de uptime.
securityMiddlewares(app, cors, { publicPaths: ['/api/public', '/api/agent', '/health'] });
apiKeyWarning();

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Middleware para loguear todas las requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
// Servir archivos estáticos desde /public en la raíz del proyecto
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
// Servir CSS estático desde la carpeta raíz /css
app.use('/css', express.static(path.join(__dirname, '..', 'css')));
// Servir el HTML de administración copiado en la raíz del repositorio
app.get('/motor-laboral-admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'motor-laboral-admin.html'));
});
// Servir scripts estáticos desde /js en la raíz del repositorio
app.use('/js', express.static(path.join(__dirname, '..', 'js')));
//Importación de rutas de matching e importación de datos

app.use('/api/import', importRoutes);
app.use('/api/matching', matchingRoutes);
app.use('/api/employees', employeesRoutes);

// Limite de tamano para subida de archivos (CSV/Excel de fichajes) -- sin
// esto, multer aceptaba cualquier tamano en memoria (memoryStorage), un
// vector facil de agotamiento de memoria con un solo archivo gigante.
// 50MB para que coincida con lo que ya le promete al usuario
// index.html/informe-horas-extras.html (CHECKINOUT.csv puede acumular
// muchos meses de fichajes) -- estaba en 20MB, mas chico que ese mensaje.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ===============================
   MySQL – Clever Cloud
================================ */
// Bug real de produccion (reportado: "entro solo y Clever Cloud me
// bloquea por maximo 5 conexiones"): este archivo tenia su PROPIO pool
// (connectionLimit:10) totalmente separado del pool compartido de
// './db' (connectionLimit:5) que ya usan appUserMiddleware.js y varios
// routes/*.js (employees, matching, import, etc.). Los dos pools viven
// en el MISMO proceso de Node pero Clever Cloud no sabe que son "el
// mismo programa" -- para el servidor de MySQL son simplemente hasta
// 15 conexiones simultaneas pedidas por un solo usuario, contra un
// limite real de 5 (max_user_connections). Como appUserMiddleware corre
// en CADA request autenticado y despues la ruta en si vuelve a pedir
// conexion (a veces del otro pool), una sola persona cargando una
// pantalla que dispara varios pedidos en paralelo (ej. Presentismo:
// attendance-range + banner de sincronizacion + lista de empleados a la
// vez) ya alcanza para pedir mas de 5 conexiones reales al mismo
// tiempo -- sin ningun otro usuario ni el agente de sincronizacion de
// por medio. Arreglo de raiz: un unico pool compartido para todo el
// proceso (ver './db', que ya tiene el limite real de Clever Cloud).
const db = require('./db');

// Registrar holidays después de db
app.use('/api/holidays', holidaysRoutes(db));
app.use('/api/event-types', eventTypesRoutes(db));
app.use('/api/employee-events', employeeEventsRoutes(db));
app.use('/api/leave-balances', leaveBalancesRoutes(db));
app.use('/api/employee-categories', employeeCategoriesRoutes(db));
app.use('/api/ciudades', ciudadesRoutes(db));
app.use('/api/sucursales', sucursalesRoutes(db));
app.use('/api/app-users', appUsersRoutes(db));
app.use('/api/roles', rolesRoutes(db));
app.use('/api/billing', billingRoutes(db));
app.use('/api/labor-engine', createMotorLaboralRoutes(db));
app.use('/api/public', publicRoutes(db));
app.use('/api/agent', agentRoutes(db));
app.use('/api/agent-keys', agentKeysRoutes(db));
app.use('/api/sync-status', syncStatusRoutes(db));

function parseCheckTime(value) {
  if (!value) return null;

  // Caso: DD/MM/YYYY HH:mm
  if (value.includes('/')) {
    const [date, time] = value.split(' ');
    const [dd, mm, yyyy] = date.split('/');
    return `${yyyy}-${mm}-${dd} ${time}:00`;
  }

  // Caso: YYYY-MM-DD HH:mm o YYYY-MM-DD HH:mm:ss
  if (value.includes('-')) {
    return value.length === 16 ? `${value}:00` : value;
  }

  return null;
}

// parseCheckTimeArgentina se movio a motor-laboral/services/checkinsIngestService.js
// (Fase 18 -- agente de sincronizacion de relojes, reusada tambien desde
// routes/agent.js). Se sigue importando arriba, no se reimplementa aca.

// Normalizo la fecha para que no de error agregar en forma manual
// IMPORTANTE: Las fechas vienen del cliente en hora local (Argentina UTC-3)
// NO deben ser convertidas a UTC, se guardan directamente como vienen
function toMySQLDatetime(value) {
  if (!value) return null;

  // Si ya está en formato YYYY-MM-DD HH:mm:ss, devolverla tal cual
  if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
    return value;
  }

  // Si es un Date o ISO string, extraer la fecha y hora SIN conversión a UTC
  if (value instanceof Date || typeof value === 'string') {
    const d = new Date(value);
    if (isNaN(d)) return null;

    // Extraer componentes SIN usar toISOString() para evitar conversión a UTC
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  return null;
}

// A que empresa pertenece un registro que se esta creando para `userId`.
// Para un usuario normal es su propia empresa (ya validada antes con
// `userBelongsToCallerTenant`). Para el superadmin -- que no tiene empresa
// propia -- se toma la del usuario del reloj.
async function resolveOwnerTenantId(userId, req) {
  const callerTenantId = resolveTenantId(req);
  if (callerTenantId !== null) return callerTenantId;
  const [[owner]] = await db.query('SELECT tenant_id FROM `users` WHERE USERID = ? LIMIT 1', [userId]);
  return owner ? owner.tenant_id : null;
}

// Lee una entrada manual validando que sea de la empresa de quien llama.
// Devuelve null si no existe o si es de otra empresa -- los dos casos se
// responden igual (404) a proposito: contestar "existe pero no es tuya"
// confirmaria la existencia de datos ajenos.
async function loadManualEntryForCaller(entryId, req) {
  const tenantId = resolveTenantId(req);
  const params = [entryId];
  let tenantClause = '';
  if (tenantId !== null) {
    tenantClause = ' AND tenant_id = ?';
    params.push(tenantId);
  }
  const [[row]] = await db.query(
    `SELECT id, tenant_id, userId, startDatetime, endDatetime, durationMinutes, type, note
     FROM ManualEntries WHERE id = ?${tenantClause}`,
    params
  );
  return row || null;
}

// GET /config/manual-entries?userId=X&date=Y -- entradas manuales de ese
// usuario para ese dia (HE manual/Licencia/Omitir). Nuevo (Fase 6.3):
// hacia falta para poder EDITAR una entrada ya cargada desde Presentismo
// (antes solo se veian via GET /data, el motor viejo de index.html) --
// sin esto, el dialogo de Presentismo no tiene forma de saber si ya existe
// una entrada ese dia, y arriesga crear una duplicada en vez de editarla.
app.get('/config/manual-entries', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const { userId, date } = req.query;
    if (!userId || !date) {
      return res.status(400).json({ error: 'userId y date son requeridos' });
    }
    // Filtro por empresa (migracion 20260927). Hasta esa migracion
    // ManualEntries no tenia tenant_id y este endpoint devolvia la entrada de
    // CUALQUIER empresa que tuviera ese mismo USERID -- y `users.USERID` no
    // es unico entre empresas (migracion 20260909), asi que no era hipotetico.
    const tenantId = resolveTenantId(req);
    const params = [userId, date];
    let tenantClause = '';
    if (tenantId !== null) {
      tenantClause = ' AND tenant_id = ?';
      params.push(tenantId);
    }
    const [rows] = await db.query(
      `SELECT id, userId, startDatetime, endDatetime, durationMinutes, type, note
       FROM ManualEntries
       WHERE userId = ? AND DATE(startDatetime) = ?${tenantClause}
       ORDER BY startDatetime ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('ERROR fetching manual entries:', err);
    res.status(500).json({ error: 'Error fetching manual entries' });
  }
});

// Endpoint para agregar horas extras manuales o licencias
app.post('/add/manual', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const {
      userId,
      startDatetime,
      endDatetime,
      durationMinutes,
      type,
      note
    } = req.body;

    // Validaciones básicas
    if (
      !userId ||
      !startDatetime ||
      !endDatetime ||
      typeof durationMinutes !== 'number' ||
      !type
    ) {
      return res.status(400).json({
        error: 'Datos inválidos o incompletos'
      });
    }

    // Normalizar fechas para MySQL
    const start = toMySQLDatetime(startDatetime);
    const end = toMySQLDatetime(endDatetime);

    if (!start || !end) {
      return res.status(400).json({
        error: 'Formato de fecha inválido'
      });
    }

    if (type !== 'omit' && end <= start) {
      return res.status(400).json({
        error: 'endDatetime debe ser mayor que startDatetime'
      });
    }

    // Aislamiento entre empresas: hasta la migracion 20260927 este endpoint
    // no validaba nada -- un administrador de la empresa A podia cargarle
    // horas extra a un empleado de la empresa B mandando su userId.
    if (!(await userBelongsToCallerTenant(Number(userId), req))) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const tenantId = await resolveOwnerTenantId(Number(userId), req);
    const performedBy = auditLog.actorId(req);

    // El alta y su fila de auditoria van juntas en una transaccion: nunca
    // debe quedar una carga de horas sin registro de quien la hizo.
    const insertId = await auditLog.inTransaction(db, async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO ManualEntries
         (tenant_id, userId, startDatetime, endDatetime, durationMinutes, type, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          Number(userId),
          start,
          end,
          Math.round(durationMinutes),
          type,
          note || null,
          performedBy
        ]
      );
      await auditLog.logManualEntry(conn, {
        tenantId,
        entryId: result.insertId,
        userId: Number(userId),
        action: 'created',
        data: { startDatetime: start, endDatetime: end, durationMinutes: Math.round(durationMinutes), type, note: note || null },
        previous: null,
        performedBy
      });
      return result.insertId;
    });

    res.json({
      ok: true,
      message: 'Registro manual guardado correctamente',
      id: insertId
    });

  } catch (err) {
    console.error('ADD MANUAL ERROR:', err);
    res.status(500).json({
      error: 'Error interno al guardar registro manual'
    });
  }
});

/* ===============================
   UPDATE MANUAL ENTRY (editar HE manual/licencia ya cargada)
================================ */
// No existia antes (solo alta/baja) -- lo pide Fase 6: "es necesario poder
// editar" una entrada manual, no solo borrarla y volver a cargarla.
app.put('/update/manual/:id', requirePermission('attendance', 'update'), async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    const { startDatetime, endDatetime, durationMinutes, type, note } = req.body;

    if (
      !startDatetime ||
      !endDatetime ||
      typeof durationMinutes !== 'number' ||
      !type
    ) {
      return res.status(400).json({ error: 'Datos inválidos o incompletos' });
    }

    const start = toMySQLDatetime(startDatetime);
    const end = toMySQLDatetime(endDatetime);
    if (!start || !end) {
      return res.status(400).json({ error: 'Formato de fecha inválido' });
    }
    if (type !== 'omit' && end <= start) {
      return res.status(400).json({ error: 'endDatetime debe ser mayor que startDatetime' });
    }

    // Se lee la fila ANTES de tocarla, por dos motivos: para validar que sea
    // de la empresa de quien llama (antes no se validaba nada, se editaba por
    // id a secas), y para guardar en el log como estaba -- un UPDATE pisa el
    // valor viejo y sin esa foto nadie puede ver despues que antes decia otra
    // cosa.
    const previous = await loadManualEntryForCaller(Number(id), req);
    if (!previous) {
      return res.status(404).json({ error: 'Registro manual no encontrado' });
    }
    const performedBy = auditLog.actorId(req);

    await auditLog.inTransaction(db, async (conn) => {
      await conn.query(
        `UPDATE ManualEntries
         SET startDatetime = ?, endDatetime = ?, durationMinutes = ?, type = ?, note = ?,
             updated_by = ?, updatedAt = NOW()
         WHERE id = ?`,
        [start, end, Math.round(durationMinutes), type, note || null, performedBy, Number(id)]
      );
      await auditLog.logManualEntry(conn, {
        tenantId: previous.tenant_id,
        entryId: Number(id),
        userId: previous.userId,
        action: 'updated',
        data: { startDatetime: start, endDatetime: end, durationMinutes: Math.round(durationMinutes), type, note: note || null },
        previous,
        performedBy
      });
    });

    res.json({ ok: true, id: Number(id) });
  } catch (err) {
    console.error('UPDATE MANUAL ERROR:', err);
    res.status(500).json({ error: 'Error al editar registro manual' });
  }
});

/* ===============================
   DELETE MANUAL ENTRY, ONLY MANUAL
================================ */
app.delete('/delete/manual/:id', requirePermission('attendance', 'delete'), async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    // Igual que en el update: se lee antes para validar la empresa y para
    // dejar la copia completa en el log. Este es el caso donde el log mas
    // importa -- despues del DELETE la fila no existe mas, y sin esta copia
    // no quedaria ningun rastro de que esas horas se cargaron alguna vez.
    const previous = await loadManualEntryForCaller(Number(id), req);
    if (!previous) {
      return res.status(404).json({ error: 'Registro manual no encontrado' });
    }
    const performedBy = auditLog.actorId(req);

    await auditLog.inTransaction(db, async (conn) => {
      await auditLog.logManualEntry(conn, {
        tenantId: previous.tenant_id,
        entryId: previous.id,
        userId: previous.userId,
        action: 'deleted',
        data: previous,
        previous,
        performedBy
      });
      await conn.query(`DELETE FROM ManualEntries WHERE id = ?`, [previous.id]);
    });

    res.json({ ok: true, deletedId: id });

  } catch (err) {
    console.error('DELETE MANUAL ERROR:', err);
    res.status(500).json({ error: 'Error al borrar registro manual' });
  }
});

// Pedido real: "fichaje manual" (no le tomó la huella, corte de luz, reloj
// descompuesto) inserta directo en Checkins -- un cambio con impacto real
// en las horas calculadas de toda la empresa, a diferencia de ManualEntries
// (que solo agrega HE aparte). Por eso queda APAGADO por defecto y requiere
// que un admin de la empresa (permiso settings:update) lo habilite a
// propósito, ademas del permiso attendance:create que ya hace falta para
// usarlo -- doble candado, ver migración 20260920_checkins_manual_audit.
app.get('/config/manual-checkins-enabled', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const value = await getAppSetting('manualCheckinsEnabled', resolveTenantId(req), db);
    res.json({ manualCheckinsEnabled: value === 'true' });
  } catch (err) {
    console.error('ERROR fetching manualCheckinsEnabled:', err);
    res.status(500).json({ error: 'Error fetching manualCheckinsEnabled' });
  }
});

app.post('/config/manual-checkins-enabled', requirePermission('settings', 'update'), async (req, res) => {
  try {
    const enabled = !!req.body.manualCheckinsEnabled;
    await setAppSetting('manualCheckinsEnabled', resolveTenantId(req), String(enabled), db);
    res.json({ ok: true, manualCheckinsEnabled: enabled });
  } catch (err) {
    console.error('ERROR saving manualCheckinsEnabled:', err);
    res.status(500).json({ error: 'Error saving manualCheckinsEnabled' });
  }
});

const MANUAL_CHECKIN_CATEGORIES = ['corte_luz', 'reloj_descompuesto', 'no_tomo_huella', 'otro'];

// Resuelve el USERID de reloj (Checkins.USERID) de un empleado a partir de
// su legajo -- mismo identificador (employeeId) que ya usan /attendance-range
// y /movements-range en este archivo, no el id interno. Un empleado sin
// usuario de reloj vinculado (nunca matcheado, ver /matching) no tiene forma
// de recibir un fichaje -- se lo excluye con un motivo explicito en vez de
// fallar en silencio.
async function resolveCheckinUserId(employeeId, tenantId, db) {
  const [rows] = await db.query(
    `SELECT u.USERID
     FROM employees e
     JOIN user_employee_map ue ON ue.employee_id = e.id
     JOIN users u ON u.USERID = ue.USERID AND u.tenant_id = ue.tenant_id
     WHERE e.employee_id = ? AND e.tenant_id = ?
     LIMIT 1`,
    [employeeId, tenantId]
  );
  return rows.length > 0 ? rows[0].USERID : null;
}

// POST /api/manual-checkins -- alta en bloque (uno o varios empleados, un
// fichaje cada uno). No hay campo "entrada/salida": el motor ya decide eso
// por el ORDEN de los fichajes del dia (igual que un fichaje real de reloj),
// no hace falta que el admin lo indique.
app.post('/api/manual-checkins', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (tenantId === null) {
      return res.status(400).json({ error: 'Falta indicar la empresa (tenantId)' });
    }

    const enabledValue = await getAppSetting('manualCheckinsEnabled', tenantId, db);
    if (enabledValue !== 'true') {
      return res.status(403).json({ error: 'El fichaje manual no está habilitado para esta empresa' });
    }

    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (entries.length === 0) {
      return res.status(400).json({ error: 'entries es requerido y no puede estar vacío' });
    }

    const resolved = [];
    const unresolved = [];
    for (const entry of entries) {
      const { employeeId, checktime, motivoCategoria, motivoDetalle } = entry || {};
      const checkTimeMySQL = toMySQLDatetime(checktime);
      if (!employeeId || !checkTimeMySQL) {
        unresolved.push({ employeeId: employeeId ?? null, reason: 'Fecha/hora inválida' });
        continue;
      }
      if (motivoCategoria && !MANUAL_CHECKIN_CATEGORIES.includes(motivoCategoria)) {
        unresolved.push({ employeeId, reason: `motivoCategoria inválido: ${motivoCategoria}` });
        continue;
      }
      const userId = await resolveCheckinUserId(employeeId, tenantId, db);
      if (userId === null) {
        unresolved.push({ employeeId, reason: 'Este empleado no tiene un usuario de reloj vinculado (ver Matching)' });
        continue;
      }
      resolved.push({ employeeId, userId, checkTimeMySQL, motivoCategoria: motivoCategoria || null, motivoDetalle: motivoDetalle || null });
    }

    if (resolved.length === 0) {
      return res.status(400).json({ error: 'Ningún fichaje pudo cargarse', unresolved });
    }

    const createdBy = req.appUser ? req.appUser.id : null;
    const created = [];
    for (const r of resolved) {
      const [result] = await db.query(
        `INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, source, motivo_categoria, motivo_detalle, created_by)
         VALUES (?, ?, ?, 'manual', ?, ?, ?)`,
        [r.userId, tenantId, r.checkTimeMySQL, r.motivoCategoria, r.motivoDetalle, createdBy]
      );
      await db.query(
        `INSERT INTO manual_checkin_log
           (tenant_id, employee_id, checkin_userid, checktime, motivo_categoria, motivo_detalle, action, performed_by)
         VALUES (?, ?, ?, ?, ?, ?, 'created', ?)`,
        [tenantId, r.employeeId, r.userId, r.checkTimeMySQL, r.motivoCategoria, r.motivoDetalle, createdBy]
      );
      created.push({ id: result.insertId, employeeId: r.employeeId, checktime: r.checkTimeMySQL });
    }

    res.json({ ok: true, created, unresolved });
  } catch (err) {
    console.error('ERROR creating manual checkins:', err);
    res.status(500).json({ error: 'Error interno al cargar fichajes manuales' });
  }
});

// GET /api/manual-checkins -- listado de auditoria (que se cargo, quien, cuando, por que).
app.get('/api/manual-checkins', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { from, to, employeeId } = req.query;

    const params = [];
    let where = `c.source = 'manual'`;
    if (tenantId !== null) {
      where += ' AND c.tenant_id = ?';
      params.push(tenantId);
    }
    if (from) {
      where += ' AND c.CHECKTIME >= ?';
      params.push(`${from} 00:00:00`);
    }
    if (to) {
      where += ' AND c.CHECKTIME <= ?';
      params.push(`${to} 23:59:59`);
    }
    if (employeeId) {
      where += ' AND e.employee_id = ?';
      params.push(employeeId);
    }

    const [rows] = await db.query(
      `SELECT
         c.id, c.CHECKTIME AS checktime, c.motivo_categoria, c.motivo_detalle,
         c.created_at, e.employee_id AS employeeId, COALESCE(e.nombre, u.Name) AS employeeName,
         au.email AS createdByEmail
       FROM Checkins c
       LEFT JOIN users u ON u.USERID = c.USERID AND u.tenant_id = c.tenant_id
       LEFT JOIN user_employee_map ue ON ue.USERID = u.USERID AND ue.tenant_id = u.tenant_id
       LEFT JOIN employees e ON e.id = ue.employee_id
       LEFT JOIN app_users au ON au.id = c.created_by
       WHERE ${where}
       ORDER BY c.CHECKTIME DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('ERROR listing manual checkins:', err);
    res.status(500).json({ error: 'Error al listar fichajes manuales' });
  }
});

// DELETE /api/manual-checkins/:id -- borrado real (no soft-delete, ver
// comentario en la migracion) + una copia completa en manual_checkin_log
// ANTES de borrar, para no perder nunca el rastro de auditoria.
app.delete('/api/manual-checkins/:id', requirePermission('attendance', 'delete'), async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }
  try {
    const tenantId = resolveTenantId(req);
    const params = [Number(id)];
    let tenantClause = '';
    if (tenantId !== null) {
      tenantClause = ' AND tenant_id = ?';
      params.push(tenantId);
    }
    const [rows] = await db.query(
      `SELECT id, tenant_id, USERID, CHECKTIME, motivo_categoria, motivo_detalle
       FROM Checkins WHERE id = ? AND source = 'manual'${tenantClause}`,
      params
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Fichaje manual no encontrado' });
    }
    const row = rows[0];
    const performedBy = req.appUser ? req.appUser.id : null;

    const [empRows] = await db.query(
      `SELECT e.employee_id AS employeeId
       FROM user_employee_map ue
       JOIN employees e ON e.id = ue.employee_id
       WHERE ue.USERID = ? AND ue.tenant_id = ?
       LIMIT 1`,
      [row.USERID, row.tenant_id]
    );
    const employeeId = empRows.length > 0 ? empRows[0].employeeId : null;

    await db.query(
      `INSERT INTO manual_checkin_log
         (tenant_id, employee_id, checkin_userid, checktime, motivo_categoria, motivo_detalle, action, performed_by)
       VALUES (?, ?, ?, ?, ?, ?, 'deleted', ?)`,
      [row.tenant_id, employeeId, row.USERID, row.CHECKTIME, row.motivo_categoria, row.motivo_detalle, performedBy]
    );

    await db.query(`DELETE FROM Checkins WHERE id = ?`, [row.id]);

    res.json({ ok: true, deletedId: row.id });
  } catch (err) {
    console.error('ERROR deleting manual checkin:', err);
    res.status(500).json({ error: 'Error al borrar el fichaje manual' });
  }
});

// Pedido real: "que no puedan subir cualquier archivo" -- el input del
// frontend ya filtraba por accept=".csv", pero eso es solo una sugerencia
// del navegador, no un chequeo real (se salta con cualquier cliente que no
// sea ese formulario puntual). Valida ACA, del lado del servidor: la
// extension del nombre de archivo, y que la PRIMERA linea (encabezado)
// tenga las columnas que hacen falta -- lo mismo protege tanto de un
// vistazo de "subi el .xlsx en vez del .csv" como de "subi el archivo de
// usuarios donde iba el de fichajes". No es un chequeo de seguridad (nada
// de esto se ejecuta ni se guarda en disco, ver `multer.memoryStorage()`
// mas arriba) -- es para agarrar el error humano mas comun con un mensaje
// claro en vez de un 500 generico sin explicar nada.
function validateCsvFile(file, requiredColumns) {
  if (!/\.csv$/i.test(file.originalname || '')) {
    return `El archivo debe ser un .csv (recibido: "${file.originalname || 'sin nombre'}")`;
  }
  const text = file.buffer.toString('utf8');
  // ﻿: algunos editores/planillas guardan un CSV con BOM -- sin sacarlo,
  // la PRIMERA columna del encabezado nunca matchea (queda "﻿USERID").
  const firstLine = (text.split(/\r?\n/)[0] || '').replace(/^﻿/, '');
  const headerCols = firstLine.split(';').map((h) => h.trim());
  const missing = requiredColumns.filter((c) => !headerCols.includes(c));
  if (missing.length > 0) {
    return `El archivo no tiene las columnas esperadas (${missing.join(', ')}) -- ¿es el archivo correcto?`;
  }
  return null;
}

/* ===============================
   IMPORT CHECKINS
================================ */
// Fase 9 (venta): si a la empresa se le vencio el periodo de gracia de
// pago, no puede subir fichajes nuevos. Ver empleados nuevos (no puede
// crearlos) en routes/employees.js -- mismo criterio.
app.post('/import/checkins', requirePermission('attendance', 'create'), requireActiveSubscription, upload.single('file'), async (req, res) => {
  try {
    // Fase 19: tenant obligatorio para insertar -- ver el comentario en
    // checkinsIngestService.js. Un superadmin sin ?tenantId explicito no
    // tiene un default valido (no hay forma de adivinar "de que empresa
    // son estos fichajes"), asi que se le pide que lo especifique en vez
    // de asumir cualquier cosa.
    const effectiveTenantId = resolveTenantId(req);
    if (!effectiveTenantId) {
      return res.status(400).json({ error: 'Falta especificar la empresa (tenantId) para esta importación' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Archivo CSV requerido' });
    }

    const fileError = validateCsvFile(req.file, ['USERID', 'CHECKTIME']);
    if (fileError) {
      return res.status(400).json({ error: fileError });
    }

    const csv = req.file.buffer.toString('utf8');
    const records = parse(csv, {
      columns: true,
      delimiter: ';',
      skip_empty_lines: true,
      trim: true
    });

    if (records.length === 0) {
      return res.status(400).json({ error: 'El archivo no tiene ninguna fila de datos' });
    }

    // Insercion/dedupe extraida a checkinsIngestService.js (Fase 18) --
    // reusada TAL CUAL por el agente automatico (routes/agent.js). Tope
    // mucho mas alto que el del agente (MAX_RECORDS_PER_MANUAL_IMPORT, no
    // MAX_RECORDS_PER_BATCH) -- ver el comentario en checkinsIngestService.js:
    // CHECKINOUT.csv puede acumular "muchos meses de fichajes" (el upload ya
    // acepta hasta 50MB), el tope chico del agente era para un payload JSON
    // de una clave automatica, no para esta subida manual autenticada.
    const result = await insertCheckinsBatch(records, db, effectiveTenantId, MAX_RECORDS_PER_MANUAL_IMPORT);
    res.json({ ok: true, ...result });

  } catch (err) {
    if (err.code === 'DB_BUSY' || err.code === 'DB_UNREACHABLE') {
      console.error('IMPORT CHECKINS:', err.message);
      return res.status(503).json({ error: err.message });
    }
    // Bug real reportado: BATCH_TOO_LARGE y TENANT_REQUIRED caian antes en
    // el 500 generico de mas abajo ("Import checkins failed", sin decir
    // por que) -- se contemplan explicitamente para que el mensaje real
    // (ej. "Máximo 500000 registros por lote") le llegue al usuario.
    if (err.code === 'BATCH_TOO_LARGE') {
      return res.status(413).json({ error: err.message });
    }
    if (err.code === 'TENANT_REQUIRED') {
      return res.status(400).json({ error: err.message });
    }
    console.error('IMPORT CHECKINS FATAL:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Import checkins failed' });
  }
});



/* ===============================
   IMPORT USERS
================================ */
app.post('/import/users', requirePermission('attendance', 'create'), upload.single('file'), async (req, res) => {
  try {
    // Fase 19: mismo motivo que /import/checkins -- ver el comentario ahi.
    const effectiveTenantId = resolveTenantId(req);
    if (!effectiveTenantId) {
      return res.status(400).json({ error: 'Falta especificar la empresa (tenantId) para esta importación' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Archivo CSV requerido' });
    }

    const fileError = validateCsvFile(req.file, ['USERID', 'Badgenumber', 'Name']);
    if (fileError) {
      return res.status(400).json({ error: fileError });
    }

    const csv = req.file.buffer.toString('utf8');
    const records = parse(csv, {
      columns: true,
      delimiter: ';',
      skip_empty_lines: true,
      trim: true
    });

    if (records.length === 0) {
      return res.status(400).json({ error: 'El archivo no tiene ninguna fila de datos' });
    }

    // Upsert extraido a checkinsIngestService.js (Fase 18) -- reusado TAL
    // CUAL por el agente automatico (routes/agent.js). Mismo tope alto que
    // /import/checkins -- ver el comentario ahi.
    const { upserted, skipped } = await upsertUsersBatch(records, db, effectiveTenantId, MAX_RECORDS_PER_MANUAL_IMPORT);
    res.json({ ok: true, users: upserted, skipped, message: 'Importacion completada' });

  } catch (err) {
    if (err.code === 'BATCH_TOO_LARGE') {
      return res.status(413).json({ error: err.message });
    }
    if (err.code === 'TENANT_REQUIRED') {
      return res.status(400).json({ error: err.message });
    }
    console.error('IMPORT USERS ERROR:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Import users failed' });
  }
});

/* ===============================
   TEST
================================ */
app.get('/', (req, res) => {
  res.send('Backend OK');
});

// DELETE ALL CHECKINS (¡cuidado, borra todo!) -- irreversible y afecta a
// TODOS los tenants de una, no un permiso de modulo: solo superadmin.
app.delete('/clear/checkins', requireSuperadmin, async (req, res) => {
  try {
    const [result] = await db.query(`DELETE FROM Checkins`);
    res.json({
      ok: true,
      message: `Se borraron ${result.affectedRows} fichajes`
    });
  } catch (err) {
    console.error('CLEAR CHECKINS ERROR:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error al borrar los fichajes' });
  }
});

/* ===============================
   DEBUG STATUS - Diagnóstico
================================ */
// Sin ningun guard antes -- devuelve una muestra cruda de `users`/`Checkins`
// de TODAS las empresas, sin filtro de tenant. Cualquier app_user logueado
// (de cualquier empresa, cualquier rol) podia ver datos de otra empresa.
// Es una herramienta de diagnostico interno, no algo que use ningun cliente
// -- queda restringida a superadmin.
app.get('/debug/status', requireSuperadmin, async (req, res) => {
  try {
    const [[usersCount]] = await db.query('SELECT COUNT(*) as count FROM users');
    const [[checkinsCount]] = await db.query('SELECT COUNT(*) as count FROM Checkins');
    const [sampleUsers] = await db.query('SELECT * FROM users LIMIT 3');
    const [sampleCheckins] = await db.query('SELECT * FROM Checkins LIMIT 3');

    res.json({
      ok: true,
      usersCount: usersCount.count,
      checkinsCount: checkinsCount.count,
      sampleUsers,
      sampleCheckins
    });
  } catch (err) {
    console.error('DEBUG STATUS ERROR:', err);
    res.status(500).json({ error: 'Error en debug status', details: err.message });
  }
});

/* ===============================
   USERS FOR AUTOCOMPLETE
================================ */
app.get('/users', requirePermission('exclusions', 'read'), async (req, res) => {
  try {
    // Fase 19: `users` ya tiene su propio tenant_id (migracion 20260909) --
    // se filtra directo por eso en vez de indirecto via employees. Es mas
    // simple Y mas correcto que la version anterior: antes, un USERID sin
    // matchear quedaba visible para CUALQUIER empresa (no habia de donde
    // sacarle un tenant_id todavia) -- ahora todo usuario crudo tiene su
    // tenant real desde que el agente lo sincroniza, este matcheado o no.
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'WHERE u.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
    const [users] = await db.query(`
      SELECT u.USERID, u.Badgenumber, u.Name
      FROM users u
      ${tenantClause}
      ORDER BY u.Name
    `, tenantParams);

    res.json(users);

  } catch (err) {
    console.error('USERS ERROR:', err);
    res.status(500).json({ error: 'Error cargando usuarios' });
  }
});

/* ===============================
   DIAGNÓSTICO PARA DEBUG (Endpoint Temporal)
================================ */

// Sin ningun guard antes, y sin filtro de tenant en las consultas internas
// -- cualquier app_user logueado podia diagnosticar el legajo de OTRA
// empresa. Herramienta de soporte interno, no algo que use ningun cliente
// -- queda restringida a superadmin.
app.get('/diagnostic/:badge/:month', requireSuperadmin, async (req, res) => {
  try {
    const { badge, month } = req.params;
    
    console.log(`🔍 DIAGNOSTIC: badge=${badge}, month=${month}`);
    
    const result = {
      badge,
      month,
      checks: {}
    };
    
    // 1. ¿Existe el usuario en tabla users?
    const [[user]] = await db.query(`
      SELECT 
        u.USERID, 
        u.Badgenumber, 
        COALESCE(e.nombre, u.Name) AS Name
      FROM users u
      LEFT JOIN user_employee_map um ON um.USERID = u.USERID
      LEFT JOIN employees e ON e.id = um.employee_id
      WHERE u.Badgenumber = ? 
      LIMIT 1
    `, [badge]);
    
    if (user) {
      result.checks.user_exists = {
        status: '✅ Encontrado',
        data: user
      };
      
      // 2. ¿Tiene matching en user_employee_map?
      const [[mapping]] = await db.query(
        'SELECT uem.USERID, uem.employee_id, e.nombre, e.legajo_alt FROM user_employee_map uem LEFT JOIN employees e ON uem.employee_id = e.id WHERE uem.USERID = ?',
        [user.USERID]
      );
      
      if (mapping) {
        result.checks.matching = {
          status: '✅ Tiene matching',
          data: mapping
        };
      } else {
        result.checks.matching = {
          status: '⚠️ Sin matching en user_employee_map',
          data: null
        };
      }
      
      // 3. ¿Tiene fichajes en el mes?
      const [[checkinCount]] = await db.query(
        'SELECT COUNT(*) as total FROM Checkins WHERE USERID = ? AND DATE_FORMAT(CHECKTIME, "%Y-%m") = ?',
        [user.USERID, month]
      );
      
      result.checks.checkins_in_month = {
        status: checkinCount.total > 0 ? '✅ Fichajes encontrados' : '❌ Sin fichajes',
        count: checkinCount.total
      };
      
      // 4. ¿Está marcado como excluido?
      const isExcluded = user.isExcluded ? 'Sí (excluido)' : 'No';
      result.checks.excluded_status = {
        status: `ℹ️ ${isExcluded}`,
        data: user
      };
      
      // 5. Muestrear fichajes
      if (checkinCount.total > 0) {
        const [sampleCheckins] = await db.query(
          'SELECT USERID, DATE_FORMAT(CHECKTIME, "%Y-%m-%d %H:%i:%s") as CHECKTIME FROM Checkins WHERE USERID = ? AND DATE_FORMAT(CHECKTIME, "%Y-%m") = ? LIMIT 5',
          [user.USERID, month]
        );
        result.checks.sample_checkins = {
          status: `🔎 Muestra de fichajes (primeros 5)`,
          data: sampleCheckins
        };
      }
      
    } else {
      result.checks.user_exists = {
        status: '❌ NO ENCONTRADO',
        data: null
      };
      
      // Sugerir legajos similares
      const [suggestions] = await db.query(
        `SELECT u.Badgenumber, COALESCE(e.nombre, u.Name) AS Name 
         FROM users u
         LEFT JOIN user_employee_map um ON um.USERID = u.USERID
         LEFT JOIN employees e ON e.id = um.employee_id
         WHERE u.Badgenumber LIKE ? 
         LIMIT 5`,
        [`%${badge.slice(-2)}%`]
      );
      result.suggestions = suggestions;
    }
    
    res.json(result);
    
  } catch (err) {
    console.error('DIAGNOSTIC ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   HELPER: Detectar y clasificar fichajes de HE
================================ */
function classifyCheckins(checkinsByUserDay) {
  // checkinsByUserDay = array de checkins para un usuario en un día
  // Cada checkin tiene: { CHECKTIME, checkin_userid, Badgenumber }
  
  const result = [];
  const OVERTIME_START_BADGE = '9';
  const OVERTIME_END_BADGE = '10';
  const CUTOFF_HOUR = 14; // 14:00
  
  // Buscar si hay marcadores 9 y 10
  const hasMarker9 = checkinsByUserDay.some(c => String(c.checkin_userid) === OVERTIME_START_BADGE);
  const hasMarker10 = checkinsByUserDay.some(c => String(c.checkin_userid) === OVERTIME_END_BADGE);
  
  if (hasMarker9 && hasMarker10) {
    // PATRÓN 1: Tiene 9 (inicio) y 10 (fin)
    // 9 → [fichajes reales] → 10 → [más fichajes]
    let inOvertimeMode = false;
    
    for (const c of checkinsByUserDay) {
      const badge = String(c.checkin_userid);
      
      if (badge === OVERTIME_START_BADGE) {
        inOvertimeMode = true;
        continue; // No incluir el marcador 9
      }
      
      if (badge === OVERTIME_END_BADGE) {
        inOvertimeMode = false;
        continue; // No incluir el marcador 10
      }
      
      // Clasificar fichaje
      const checkHour = new Date(c.CHECKTIME).getHours();
      
      result.push({
        ...c,
        overtimeType: inOvertimeMode ? 'marked_overtime' : 'normal',
        checkinType: 'marked' // Fue precedido por 9 o 10
      });
    }
  } else if (hasMarker9 && !hasMarker10) {
    // PATRÓN 2: Solo tiene 9 (inicio sin fin)
    // 9 → [resto del día son HE]
    let inOvertimeMode = false;
    
    for (const c of checkinsByUserDay) {
      const badge = String(c.checkin_userid);
      
      if (badge === OVERTIME_START_BADGE) {
        inOvertimeMode = true;
        continue;
      }
      
      result.push({
        ...c,
        overtimeType: inOvertimeMode ? 'marked_overtime' : 'normal',
        checkinType: 'marked'
      });
    }
  } else {
    // PATRÓN 3: Sin marcadores 9/10 (regla de fallback)
    // Primeros 2 fichajes = entrada/salida normal
    // Resto después de 14:00 = HE
    
    for (let i = 0; i < checkinsByUserDay.length; i++) {
      const c = checkinsByUserDay[i];
      const checkHour = new Date(c.CHECKTIME).getHours();
      const checkMin = new Date(c.CHECKTIME).getMinutes();
      const totalMins = checkHour * 60 + checkMin;
      const cutoffMins = CUTOFF_HOUR * 60; // 840 min
      
      // Primeros 2 = normales, resto > 14:00 = HE
      const isFirstTwo = i < 2;
      const isAfterCutoff = totalMins > cutoffMins;
      
      result.push({
        ...c,
        overtimeType: (isFirstTwo || !isAfterCutoff) ? 'normal' : 'auto_overtime',
        checkinType: 'unmarked'
      });
    }
  }
  
  return result;
}

/* ===============================
   DATA PARA INFORME (ONLINE)
================================ */
app.get('/data', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const { month, badge, name, authorized } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month requerido (YYYY-MM)' });
    }

    console.log(`📥 /data request: month=${month}, badge=${badge}, name=${name}`);

    // ======================
    // USERS FILTRADOS CON INFO DE EMPLEADOS
    // ======================
    let usersSQL = `
      SELECT
        u.USERID,
        u.Badgenumber,
        u.Name,
        u.isExcluded,
        e.id as employee_id,
        e.nombre as employee_nombre,
        e.documento as employee_documento,
        e.tipo_documento as employee_tipo_documento,
        e.direccion as employee_direccion,
        e.fecha_alta as employee_fecha_alta,
        e.fecha_baja as employee_fecha_baja,
        e.activo as employee_activo,
        e.overtime_authorized as employee_overtime_authorized,
        e.exclude_from_report as employee_excluded_from_report,
        e.legajo_alt as employee_legajo_alt,
        uem.match_type
      FROM users u
      LEFT JOIN user_employee_map uem ON u.USERID = uem.USERID AND uem.tenant_id = u.tenant_id
      LEFT JOIN employees e ON uem.employee_id = e.id
      WHERE 1=1
    `;
    const usersParams = [];

    // Fase 19: users ya tiene tenant_id propio (migracion 20260909) -- se
    // filtra directo, igual que /users.
    const effectiveTenantId = resolveTenantId(req);
    if (effectiveTenantId !== null) {
      usersSQL += ' AND u.tenant_id = ?';
      usersParams.push(effectiveTenantId);
    }

    if (badge) {
      usersSQL += ' AND (u.Badgenumber = ? OR uem.employee_id = ?)';
      usersParams.push(badge, badge);
    }

    if (name) {
      usersSQL += ' AND (LOWER(u.Name) LIKE ? OR LOWER(e.nombre) LIKE ?)';
      usersParams.push(`%${name.toLowerCase()}%`, `%${name.toLowerCase()}%`);
    }

    if (authorized !== undefined) {
      usersSQL += authorized === '1'
        ? ' AND e.overtime_authorized = 1'
        : ' AND e.overtime_authorized = 0';
    }

    // Excluir del informe a los empleados marcados como excluidos
    usersSQL += ' AND (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)';

    const [users] = await db.query(usersSQL, usersParams);

    console.log(`👤 Usuarios encontrados: ${users.length}`);

    if (users.length === 0) {
      console.warn('⚠️ No hay usuarios que coincidan con los filtros');
      return res.json({
        users: [],
        checkins: [],
        manuals: []
      });
    }

    const userIds = users.map(u => u.USERID);

    // ======================
    // CHECKINS FILTRADOS - CORREGIDO PARA MATCHING POR BADGENUMBER
    // ======================
    const [checkins] = await db.query(
      `
      SELECT 
        u.USERID as USERID,  -- USERID real del usuario
        DATE_FORMAT(c.CHECKTIME, '%Y-%m-%dT%H:%i:%s') AS CHECKTIME,
        c.USERID as checkin_userid,  -- Badgenumber del checkin
        u.Badgenumber
      FROM Checkins c
      LEFT JOIN users u ON CAST(c.USERID AS CHAR) = CAST(u.Badgenumber AS CHAR)
      WHERE u.USERID IS NOT NULL
        AND u.USERID IN (?)
        AND DATE_FORMAT(c.CHECKTIME, '%Y-%m') = ?
      ORDER BY u.USERID, c.CHECKTIME
      `,
      [userIds, month]
    );

    console.log(`📝 Checkins encontrados para mes ${month}: ${checkins.length}`);

    // ======================
    // MANUALES FILTRADOS
    // ======================
    const [manuals] = await db.query(
      `
      SELECT
        id,
        userId,
        startDatetime,
        endDatetime,
        durationMinutes,
        type,
        note
      FROM ManualEntries
      WHERE userId IN (?)
        AND DATE_FORMAT(startDatetime, '%Y-%m') = ?
      ORDER BY userId, startDatetime
      `,
      [userIds, month]
    );
    
    console.log(`📋 Manuales encontrados para mes ${month}: ${manuals.length}`);
    
    // ======================
    // CLASIFICAR FICHAJES CON LÓGICA DE HE
    // ======================

    // Agrupar por USERID + fecha
    const agrupado = {};

    for (const c of checkins) {
      const fecha = c.CHECKTIME.substring(0, 10); // YYYY-MM-DD
      const key = `${c.USERID}_${fecha}`;

      if (!agrupado[key]) {
        agrupado[key] = [];
      }

      agrupado[key].push(c);
    }

    // PROCESAR CADA DÍA CON DETECCIÓN DE PATRONES 9/10
    const checkinsClasificados = [];

    for (const key in agrupado) {
      const fichajesdiaio = agrupado[key];
      const classified = classifyCheckins(fichajesdiaio);
      checkinsClasificados.push(...classified);
    }

    console.log(`✅ Fichajes clasificados: ${checkinsClasificados.length} (HE detectadas correctamente)`);

    res.json({
      users,
      checkins: checkinsClasificados, // Retorna todos los checkins con clasificación de tipo
      manuals
    });

  } catch (err) {
    console.error('DATA ERROR:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'La base de datos no está respondiendo. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error backend', details: err.message });
  }
});

// ========================================
// ENDPOINTS PARA DASHBOARD
// ========================================

// Candidatos a "usuario ficticio" (marcador): en este reloj, un badge
// marcador tiene Badgenumber puramente numérico y de 1-2 dígitos, con Name
// igual al badge (ej. badge '6', name '6') -- muy distinto de un legajo real
// (siempre 4 dígitos en esta base). Sirve para poblar el selector de
// marcadores.html sin depender de que el admin escriba el número a mano.
app.get('/config/special-users/candidates', requirePermission('settings', 'update'), async (req, res) => {
  try {
    // Fase 19: users/specialusers ya tienen tenant_id (migracion 20260909)
    // -- sin filtrar, esta lista de candidatos mezclaba usuarios crudos de
    // TODAS las empresas.
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND u.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
    const [rows] = await db.query(`
      SELECT u.USERID, u.Badgenumber, u.Name,
             su.category, su.direction, su.\`function\`, su.isActive
      FROM users u
      LEFT JOIN specialusers su ON su.userId = u.USERID AND su.tenant_id = u.tenant_id
      WHERE u.Badgenumber REGEXP '^[0-9]{1,2}$' AND u.Name = u.Badgenumber
        AND u.Badgenumber NOT IN ('1', '2') -- suelen ser el admin del reloj, no un marcador
        ${tenantClause}
      ORDER BY CAST(u.Badgenumber AS UNSIGNED)
    `, tenantParams);
    res.json(rows);
  } catch (err) {
    console.error('ERROR fetching special user candidates:', err);
    res.status(500).json({ error: 'Error fetching special user candidates' });
  }
});

// 1. OBTENER/CREAR CONFIGURACIÓN DE USUARIOS ESPECIALES
app.get('/config/special-users', requirePermission('settings', 'read'), async (req, res) => {
  try {
    // Bug real de seguridad (re-auditoria de venta, Fase 19): sin filtro
    // de tenant, esta lista (la que alimenta la pantalla de Marcadores)
    // mostraba los marcadores configurados por TODAS las empresas.
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND su.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
    const [specialUsers] = await db.query(`
      SELECT su.*, u.Name as userName
      FROM specialusers su
      JOIN users u ON su.userId = u.USERID AND su.tenant_id = u.tenant_id
      WHERE su.isActive = TRUE
      ${tenantClause}
      ORDER BY su.category, su.id
    `, tenantParams);
    res.json(specialUsers);
  } catch (err) {
    console.error('ERROR fetching special users:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error fetching special users' });
  }
});

app.post('/config/special-users', requirePermission('settings', 'update'), async (req, res) => {
  try {
    const { userId, category, direction, function: func } = req.body;

    // Fase 19: users.USERID ya no es unico por si solo (migracion
    // 20260909) -- se resuelve el tenant del que pide y se busca el
    // usuario crudo DENTRO de ese tenant, para no poder marcar como
    // "marcador" el USERID de otra empresa que comparta el mismo numero.
    const effectiveTenantId = resolveTenantId(req);
    if (!effectiveTenantId) {
      return res.status(400).json({ error: 'No se pudo determinar la empresa del usuario logueado' });
    }

    // Verificar que el usuario existe EN ESTA EMPRESA
    const [user] = await db.query(
      `SELECT
        u.USERID,
        u.Badgenumber,
        COALESCE(e.nombre, u.Name) AS Name
       FROM users u
       LEFT JOIN user_employee_map um ON um.USERID = u.USERID AND um.tenant_id = u.tenant_id
       LEFT JOIN employees e ON e.id = um.employee_id
       WHERE u.USERID = ? AND u.tenant_id = ?`,
      [userId, effectiveTenantId]
    );

    if (user.length === 0) {
      return res.status(400).json({ error: 'Usuario no encontrado' });
    }

    if (direction !== undefined && direction !== null && direction !== '' && !['SALIDA', 'REGRESO'].includes(direction)) {
      return res.status(400).json({ error: "direction debe ser 'SALIDA' o 'REGRESO'" });
    }

    await db.query(`
      INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, \`function\`, isActive)
      VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE
        category = VALUES(category),
        direction = VALUES(direction),
        \`function\` = VALUES(\`function\`),
        isActive = TRUE
    `, [userId, effectiveTenantId, user[0].Badgenumber, user[0].Name, category, direction || null, func]);

    res.json({ ok: true, message: 'Usuario especial configurado' });
  } catch (err) {
    console.error('ERROR setting special user:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Error configurando usuario especial' });
  }
});

app.delete('/config/special-users/:userId', requirePermission('settings', 'delete'), async (req, res) => {
  try {
    const { userId } = req.params;
    // Fase 19: sin AND tenant_id, esto podia borrar el marcador de OTRA
    // empresa que comparta el mismo USERID crudo (userId ya no es unico
    // globalmente, migracion 20260909).
    const effectiveTenantId = resolveTenantId(req);
    const params = effectiveTenantId !== null ? [userId, effectiveTenantId] : [userId];
    const query = effectiveTenantId !== null
      ? 'DELETE FROM specialusers WHERE userId = ? AND tenant_id = ?'
      : 'DELETE FROM specialusers WHERE userId = ?';
    const [result] = await db.query(query, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Usuario especial no encontrado' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR deleting special user:', err);
    res.status(500).json({ error: 'Error eliminando usuario especial' });
  }
});

// 2. HORARIO EMPRESA
app.get('/config/schedule/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const [schedule] = await db.query(
      `SELECT * FROM companyschedule WHERE scheduleDate = ?`,
      [date]
    );
    
    res.json(schedule[0] || {
      timeEntrance: '07:00:00',
      timeExit: '13:40:00',
      isWorkDay: true
    });
  } catch (err) {
    console.error('ERROR fetching schedule:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error fetching schedule' });
  }
});

// Fase 4.4 del plan de migracion a Angular: esta ruta no tenia ningun
// requirePermission -- cualquier app_user logueado, sin importar su rol o
// permisos, podia cambiar el horario por defecto de TODA la empresa.
app.post('/config/schedule', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const { scheduleDate, timeEntrance, timeExit, isWorkDay, description } = req.body;
    
    await db.query(`
      INSERT INTO companyschedule (scheduleDate, timeEntrance, timeExit, isWorkDay, description)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        timeEntrance = VALUES(timeEntrance),
        timeExit = VALUES(timeExit),
        isWorkDay = VALUES(isWorkDay),
        description = VALUES(description)
    `, [scheduleDate, timeEntrance, timeExit, isWorkDay, description]);
    
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving schedule:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error saving schedule' });
  }
});

app.get('/config/theme', async (req, res) => {
  try {
    // Antes era una unica fila GLOBAL (ver appSettingsRepository.js) -- el
    // tema que alguien tocaba en la Empresa A se lo cambiaba a la Empresa B
    // tambien. Ahora cada empresa tiene su propia fila (o hereda el
    // default global si todavia no eligio ninguna).
    const value = await getAppSetting('theme', resolveTenantId(req), db);
    res.json({ theme: value || '' });
  } catch (err) {
    console.error('ERROR fetching theme:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Error fetching theme' });
  }
});

app.post('/config/theme', async (req, res) => {
  try {
    const { theme = '' } = req.body;
    await setAppSetting('theme', resolveTenantId(req), theme, db);
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving theme:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Error saving theme' });
  }
});

// 3. EXCLUSIONES DE USUARIOS - CRUD COMPLETO CON PAGINACIÓN

// Bug real de seguridad (auditoria general): NINGUNO de los endpoints de
// abajo chequeaba tenant -- un usuario con permiso 'exclusions:*' de
// CUALQUIER empresa podia crear/editar/borrar una exclusion (llegada
// tarde "justificada", o exclusion permanente de un reporte) para el
// USERID de un empleado de OTRA empresa. Esto alimenta DIRECTO el calculo
// de presentismo (resolveLateJustification) -- no es solo una lectura,
// es poder fabricar o borrar una justificacion ajena.
//
// Dos helpers compartidos por todos: si el USERID/exclusion no tiene
// ningun empleado vinculado, se permite (no hay dueño a quien violarle
// nada -- pasa con USERIDs de reloj todavia sin matchear) -- solo se
// bloquea cuando SI esta vinculado a un empleado de OTRA empresa.
// Fase 19: simplificado para usar users.tenant_id directo (migracion
// 20260909) en vez de ir a buscarlo indirecto via user_employee_map ->
// employees -- ademas de mas simple, esto CIERRA un agujero real: antes,
// un USERID crudo que TODAVIA no estaba vinculado a ningun empleado
// (owner undefined) pasaba el chequeo igual ("!owner" = true, sin
// restriccion) -- ahora que users tiene su propio tenant_id (se carga
// desde el momento en que el agente lo sincroniza, matcheado o no), se
// puede chequear la pertenencia real siempre, este vinculado o no.
async function userBelongsToCallerTenant(userId, req) {
  const effectiveTenantId = resolveTenantId(req);
  if (effectiveTenantId === null) return true; // superadmin, sin restriccion
  const [[owner]] = await db.query('SELECT tenant_id FROM users WHERE USERID = ?', [userId]);
  return !owner || owner.tenant_id === effectiveTenantId;
}

async function exclusionBelongsToCallerTenant(exclusionId, req) {
  const effectiveTenantId = resolveTenantId(req);
  if (effectiveTenantId === null) return true;
  const [[row]] = await db.query('SELECT tenant_id FROM userexclusions WHERE id = ?', [exclusionId]);
  return !row || row.tenant_id === effectiveTenantId;
}

// Version "que ademas trae los datos" de la funcion de arriba. La usan el
// update y el delete, que no solo necesitan saber si pueden tocar la fila
// sino tambien COMO ESTABA, para dejarlo registrado en user_exclusion_log.
// Devuelve null tanto si no existe como si es de otra empresa: las dos cosas
// se responden con el mismo 404, para no confirmar la existencia de datos
// ajenos.
async function loadExclusionForCaller(exclusionId, req) {
  const effectiveTenantId = resolveTenantId(req);
  const params = [exclusionId];
  let tenantClause = '';
  if (effectiveTenantId !== null) {
    tenantClause = ' AND tenant_id = ?';
    params.push(effectiveTenantId);
  }
  const [[row]] = await db.query(
    `SELECT id, tenant_id, userId, excDate, reason, type, event_type_id, excFrom, excTo
     FROM userexclusions WHERE id = ?${tenantClause}`,
    params
  );
  return row || null;
}

// GET /config/user-exclusions?page=1&limit=20&search=...&status=...
// Fase 4.6 del plan de migracion a Angular: se suma userId+excDate como
// filtro exacto opcional -- el frontend (Presentismo/Justificaciones) lo
// usa para el "¿ya existe una exclusion para este usuario+fecha?" antes
// de abrir el formulario en modo editar. Antes de esto, ese chequeo se
// hacia con ?search= + limit=50 y filtrando en el cliente -- si un
// empleado tenia mas de 50 exclusiones historicas, el chequeo podia no
// encontrar la existente (mismo tipo de bug ya corregido para
// employees?employee_id=).
app.get('/config/user-exclusions', requirePermission('exclusions', 'read'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const search = req.query.search || '';
    const status = req.query.status || ''; // 'active', 'expired', 'all'
    const { userId, excDate, dateFrom, dateTo } = req.query;

    const offset = (page - 1) * limit;

    // Construir WHERE
    let where = '';
    let params = [];

    if (search) {
      where = `WHERE (u.Name LIKE ? OR e.nombre LIKE ? OR u.Badgenumber LIKE ? OR ue.reason LIKE ?)`;
      params = [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`];
    }

    if (userId && excDate) {
      where += (where ? ' AND' : 'WHERE') + ' ue.userId = ? AND ue.excDate = ?';
      params.push(userId, excDate);
    } else if (userId && dateFrom && dateTo) {
      // Rango en vez de fecha exacta -- lo usa Licencias (Fase 4.7) para
      // avisar si una licencia multi-dia se superpone con justificaciones
      // puntuales ya cargadas para el mismo empleado.
      where += (where ? ' AND' : 'WHERE') + ' ue.userId = ? AND ue.excDate BETWEEN ? AND ?';
      params.push(userId, dateFrom, dateTo);
    }

    if (status === 'active') {
      where += params.length > 0 ? ' AND' : 'WHERE';
      where += ` ue.excDate >= CURDATE()`;
    } else if (status === 'expired') {
      where += params.length > 0 ? ' AND' : 'WHERE';
      where += ` ue.excDate < CURDATE()`;
    }

    // Fase 19: filtra por ue.tenant_id DIRECTO (userexclusions ya tiene su
    // propia columna, migracion 20260909) en vez de solo por e.tenant_id
    // via el JOIN indirecto -- asi una exclusion de un USERID todavia sin
    // matchear a ningun empleado tambien queda correctamente aislada por
    // empresa (antes, sin match, no habia ningun tenant_id de donde
    // filtrar y quedaba visible para cualquiera).
    const effectiveTenantId = resolveTenantId(req);
    if (effectiveTenantId !== null) {
      where += (where ? ' AND' : 'WHERE') + ' ue.tenant_id = ?';
      params.push(effectiveTenantId);
    }

    // Obtener total
    const [[{ total }]] = await db.query(`
      SELECT COUNT(*) as total
      FROM \`userexclusions\` ue
      JOIN \`users\` u ON ue.userId = u.USERID AND u.tenant_id = ue.tenant_id
      LEFT JOIN \`user_employee_map\` uem ON uem.USERID = u.USERID AND uem.tenant_id = u.tenant_id
      LEFT JOIN \`employees\` e ON e.id = uem.employee_id
      ${where}
    `, params);

    // Obtener datos paginados
    // Nombre: se prioriza employees.nombre (fuente de verdad, matcheado via
    // user_employee_map) por sobre users.Name (viene crudo del reloj y puede
    // ser ambiguo, ej: dos empleados de apellido "PERROTTA").
    const [exclusions] = await db.query(`
      SELECT
        ue.id,
        ue.userId,
        u.Badgenumber,
        COALESCE(e.nombre, u.Name) AS Name,
        ue.excDate,
        ue.reason,
        ue.type,
        ue.event_type_id,
        et.code AS eventTypeCode,
        et.descripcion AS eventTypeDescripcion,
        ue.excFrom,
        ue.excTo,
        ue.createdAt,
        (ue.excDate >= CURDATE()) as isActive
      FROM \`userexclusions\` ue
      JOIN \`users\` u ON ue.userId = u.USERID AND u.tenant_id = ue.tenant_id
      LEFT JOIN \`user_employee_map\` uem ON uem.USERID = u.USERID AND uem.tenant_id = u.tenant_id
      LEFT JOIN \`employees\` e ON e.id = uem.employee_id
      LEFT JOIN \`event_types\` et ON et.id = ue.event_type_id
      ${where}
      ORDER BY ue.excDate DESC, ue.createdAt DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    
    res.json({
      data: exclusions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('ERROR fetching exclusions:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error fetching exclusions' });
  }
});

// POST /config/user-exclusions - Crear exclusión
app.post('/config/user-exclusions', requirePermission('exclusions', 'create'), async (req, res) => {
  try {
    const { userId, excDate, reason, type, eventTypeId, excFrom, excTo } = req.body;

    if (!userId || !excDate) {
      return res.status(400).json({ error: 'userId y excDate son requeridos' });
    }

    // Verificar que el usuario existe
    const [[user]] = await db.query(
      `SELECT USERID, tenant_id FROM \`users\` WHERE USERID = ?`,
      [userId]
    );

    if (!user) {
      return res.status(400).json({ error: 'Usuario no encontrado' });
    }
    if (!(await userBelongsToCallerTenant(userId, req))) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    try {
      // tenant_id sale del USUARIO CRUDO (users.tenant_id, migracion
      // 20260909) -- es el dato real, siempre presente aunque el userId
      // este vinculado o no todavia a un empleado.
      const performedBy = auditLog.actorId(req);
      await auditLog.inTransaction(db, async (conn) => {
        const [result] = await conn.query(`
          INSERT INTO \`userexclusions\` (userId, tenant_id, excDate, reason, type, event_type_id, excFrom, excTo, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [userId, user.tenant_id, excDate, reason || null, type || 'FULL_DAY', eventTypeId || null, excFrom || null, excTo || null, performedBy]);
        await auditLog.logUserExclusion(conn, {
          tenantId: user.tenant_id,
          exclusionId: result.insertId,
          userId,
          action: 'created',
          data: { excDate, reason: reason || null, type: type || 'FULL_DAY', eventTypeId: eventTypeId || null, excFrom: excFrom || null, excTo: excTo || null },
          previous: null,
          performedBy
        });
      });

      res.json({ ok: true, message: 'Exclusión creada' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Este usuario ya tiene una exclusión para esta fecha' });
      }
      throw err;
    }
  } catch (err) {
    console.error('ERROR creating exclusion:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error creando exclusión' });
  }
});

// POST /config/user-exclusions/range - Crear una exclusion por cada dia de
// un rango (Fase 4.6). Reemplaza el patron del dashboard.html original,
// que expandia el rango en el CLIENTE y mandaba un POST por dia en un loop
// sin manejo de fallo parcial: si el dia 3 de 10 fallaba (ej. ya existia),
// el loop seguia igual pero el alert final decia "listo" como si los 10
// se hubieran creado. Aca es un solo request, y la respuesta es honesta:
// dice exactamente cuantos dias se crearon y cuantos se saltearon (y por
// que) -- no es una transaccion todo-o-nada a proposito, porque que un dia
// ya tuviera una exclusion cargada no deberia impedir crear el resto.
app.post('/config/user-exclusions/range', requirePermission('exclusions', 'create'), async (req, res) => {
  try {
    const { userId, dateFrom, dateTo, reason, type, eventTypeId, excFrom, excTo } = req.body;

    if (!userId || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'userId, dateFrom y dateTo son requeridos' });
    }
    if (dateFrom > dateTo) {
      return res.status(400).json({ error: 'dateFrom no puede ser posterior a dateTo' });
    }

    const [[user]] = await db.query(`SELECT USERID, tenant_id FROM \`users\` WHERE USERID = ?`, [userId]);
    if (!user) {
      return res.status(400).json({ error: 'Usuario no encontrado' });
    }
    if (!(await userBelongsToCallerTenant(userId, req))) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const dates = [];
    for (let d = new Date(`${dateFrom}T00:00:00`); d <= new Date(`${dateTo}T00:00:00`); d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    if (dates.length > 366) {
      return res.status(400).json({ error: 'El rango no puede superar un año' });
    }

    let created = 0;
    const skipped = [];
    const performedBy = auditLog.actorId(req);
    for (const excDate of dates) {
      try {
        // Una transaccion POR DIA, no una sola para todo el rango. Es a
        // proposito y respeta lo que ya decia el comentario de arriba: que un
        // dia ya tuviera exclusion cargada no debe impedir crear el resto.
        // Con una transaccion unica para los 366 dias, el primer duplicado
        // tiraria abajo todo lo demas.
        await auditLog.inTransaction(db, async (conn) => {
          const [result] = await conn.query(`
            INSERT INTO \`userexclusions\` (userId, tenant_id, excDate, reason, type, event_type_id, excFrom, excTo, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [userId, user.tenant_id, excDate, reason || null, type || 'FULL_DAY', eventTypeId || null, excFrom || null, excTo || null, performedBy]);
          await auditLog.logUserExclusion(conn, {
            tenantId: user.tenant_id,
            exclusionId: result.insertId,
            userId,
            action: 'created',
            data: { excDate, reason: reason || null, type: type || 'FULL_DAY', eventTypeId: eventTypeId || null, excFrom: excFrom || null, excTo: excTo || null },
            previous: null,
            performedBy
          });
        });
        created++;
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          skipped.push({ excDate, reason: 'Ya existía una exclusión para esa fecha' });
        } else {
          skipped.push({ excDate, reason: 'Error al crear' });
        }
      }
    }

    res.json({ ok: true, totalDays: dates.length, created, skipped });
  } catch (err) {
    console.error('ERROR creating exclusion range:', err);
    res.status(500).json({ error: 'Error creando el rango de exclusiones' });
  }
});

// PUT /config/user-exclusions/:id - Actualizar exclusión
app.put('/config/user-exclusions/:id', requirePermission('exclusions', 'update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, type, eventTypeId, excFrom, excTo } = req.body;

    // Se lee la fila entera (no solo "¿es de mi empresa?") para poder guardar
    // en el log como estaba antes: un UPDATE pisa el motivo y el tipo, y esos
    // son justamente los datos que se discuten en un reclamo.
    const previous = await loadExclusionForCaller(id, req);
    if (!previous) {
      return res.status(404).json({ error: 'Exclusión no encontrada' });
    }
    const performedBy = auditLog.actorId(req);

    await auditLog.inTransaction(db, async (conn) => {
      await conn.query(`
        UPDATE \`userexclusions\`
        SET reason = ?, type = ?, event_type_id = ?, excFrom = ?, excTo = ?,
            updated_by = ?, updatedAt = NOW()
        WHERE id = ?
      `, [reason || null, type || 'FULL_DAY', eventTypeId || null, excFrom || null, excTo || null, performedBy, id]);
      await auditLog.logUserExclusion(conn, {
        tenantId: previous.tenant_id,
        exclusionId: previous.id,
        userId: previous.userId,
        action: 'updated',
        data: { excDate: previous.excDate, reason: reason || null, type: type || 'FULL_DAY', eventTypeId: eventTypeId || null, excFrom: excFrom || null, excTo: excTo || null },
        previous,
        performedBy
      });
    });

    res.json({ ok: true, message: 'Exclusión actualizada' });
  } catch (err) {
    console.error('ERROR updating exclusion:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error actualizando exclusión' });
  }
});

// DELETE /config/user-exclusions/:id - Eliminar exclusión
app.delete('/config/user-exclusions/:id', requirePermission('exclusions', 'delete'), async (req, res) => {
  try {
    const { id } = req.params;

    // La copia al log va ANTES del DELETE: despues la fila no existe mas y
    // no habria de donde sacar los datos.
    const previous = await loadExclusionForCaller(id, req);
    if (!previous) {
      return res.status(404).json({ error: 'Exclusión no encontrada' });
    }
    const performedBy = auditLog.actorId(req);

    await auditLog.inTransaction(db, async (conn) => {
      await auditLog.logUserExclusion(conn, {
        tenantId: previous.tenant_id,
        exclusionId: previous.id,
        userId: previous.userId,
        action: 'deleted',
        data: {
          excDate: previous.excDate,
          reason: previous.reason,
          type: previous.type,
          eventTypeId: previous.event_type_id,
          excFrom: previous.excFrom,
          excTo: previous.excTo
        },
        previous,
        performedBy
      });
      await conn.query(`DELETE FROM \`userexclusions\` WHERE id = ?`, [previous.id]);
    });

    res.json({ ok: true, message: 'Exclusión eliminada' });
  } catch (err) {
    console.error('ERROR deleting exclusion:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error eliminando exclusión' });
  }
});

// GET /config/personal-leave-limit - Límite mensual de salida particular (minutos)
app.get('/config/personal-leave-limit', requirePermission('schedules', 'read'), async (req, res) => {
  try {
    const value = await getAppSetting('personalLeaveMonthlyLimitMinutes', resolveTenantId(req), db);
    res.json({ personalLeaveMonthlyLimitMinutes: value ? Number(value) : 0 });
  } catch (err) {
    console.error('ERROR fetching personal leave limit:', err);
    res.status(500).json({ error: 'Error fetching personal leave limit' });
  }
});

// POST /config/personal-leave-limit
// Mismo hallazgo que /config/schedule: sin esto, cualquier app_user
// logueado podia cambiar el limite mensual de licencia personal de toda
// la empresa. Ahora ademas queda scoped por tenant (ver appSettingsRepository.js).
app.post('/config/personal-leave-limit', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const minutes = Number(req.body.personalLeaveMonthlyLimitMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      return res.status(400).json({ error: 'personalLeaveMonthlyLimitMinutes debe ser un número >= 0' });
    }
    await setAppSetting('personalLeaveMonthlyLimitMinutes', resolveTenantId(req), String(minutes), db);
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving personal leave limit:', err);
    res.status(500).json({ error: 'Error saving personal leave limit' });
  }
});

// GET /config/particular-exit-limit - Tope mensual de horas de Salidas
// particulares (minutos). Nuevo (Fase 6.4) -- distinto de
// personal-leave-limit de arriba, que pese a su nombre en la UI vieja
// ("salida particular") en realidad solo cubre llegadas tarde
// justificadas, no las salidas reales de /movements-range.
app.get('/config/particular-exit-limit', requirePermission('schedules', 'read'), async (req, res) => {
  try {
    const value = await getAppSetting('particularExitMonthlyLimitMinutes', resolveTenantId(req), db);
    res.json({ particularExitMonthlyLimitMinutes: value ? Number(value) : 0 });
  } catch (err) {
    console.error('ERROR fetching particular exit limit:', err);
    res.status(500).json({ error: 'Error fetching particular exit limit' });
  }
});

app.post('/config/particular-exit-limit', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const minutes = Number(req.body.particularExitMonthlyLimitMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      return res.status(400).json({ error: 'particularExitMonthlyLimitMinutes debe ser un número >= 0' });
    }
    await setAppSetting('particularExitMonthlyLimitMinutes', resolveTenantId(req), String(minutes), db);
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving particular exit limit:', err);
    res.status(500).json({ error: 'Error saving particular exit limit' });
  }
});

const PAYROLL_REGIMES = ['weekly', 'biweekly', 'monthly'];

// GET/POST /config/payroll-regime -- Fase 7: que regimen de pago (semanal/
// quincenal/mensual) usa una empresa por defecto, para la pantalla "Horas
// Extra por Regimen". tenant_id NULL = default global (mismo patron que
// vacation_scale/holidays). El regimen puntual de UN empleado se guarda
// aparte, en employees.payroll_regime (NULL = hereda este default).
app.get('/config/payroll-regime', async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const [rows] = await db.query(
      `SELECT tenant_id, regime, week_start_day, biweekly_cut_day1, biweekly_cut_day2
       FROM payroll_regime_settings
       WHERE tenant_id <=> ? OR tenant_id IS NULL
       ORDER BY (tenant_id IS NULL) ASC
       LIMIT 1`,
      [tenantId]
    );
    const row = rows[0] || { regime: 'monthly', week_start_day: 1, biweekly_cut_day1: 1, biweekly_cut_day2: 16 };
    res.json({
      regime: row.regime,
      weekStartDay: row.week_start_day,
      biweeklyCutDay1: row.biweekly_cut_day1,
      biweeklyCutDay2: row.biweekly_cut_day2,
      isGlobalDefault: row.tenant_id == null,
    });
  } catch (err) {
    console.error('ERROR fetching payroll regime config:', err);
    res.status(500).json({ error: 'Error fetching payroll regime config' });
  }
});

app.post('/config/payroll-regime', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { regime, weekStartDay, biweeklyCutDay1, biweeklyCutDay2 } = req.body;

    if (!PAYROLL_REGIMES.includes(regime)) {
      return res.status(400).json({ error: `regime debe ser uno de: ${PAYROLL_REGIMES.join(', ')}` });
    }
    const week = Number(weekStartDay);
    if (!Number.isInteger(week) || week < 0 || week > 6) {
      return res.status(400).json({ error: 'weekStartDay debe ser un entero entre 0 (domingo) y 6 (sábado)' });
    }
    const cut1 = Number(biweeklyCutDay1);
    const cut2 = Number(biweeklyCutDay2);
    if (!Number.isInteger(cut1) || !Number.isInteger(cut2) || cut1 < 1 || cut1 > 28 || cut2 < 1 || cut2 > 28 || cut1 >= cut2) {
      return res.status(400).json({ error: 'Los días de corte quincenal deben ser 1-28, con el primero menor al segundo (ej. 1 y 16)' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM payroll_regime_settings WHERE tenant_id <=> ?`, [tenantId]);
      await conn.query(
        `INSERT INTO payroll_regime_settings (tenant_id, regime, week_start_day, biweekly_cut_day1, biweekly_cut_day2)
         VALUES (?, ?, ?, ?, ?)`,
        [tenantId, regime, week, cut1, cut2]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving payroll regime config:', err);
    res.status(500).json({ error: 'Error saving payroll regime config' });
  }
});

// GET /config/overtime-authorization-mode -- 'all' (todos computan HE,
// ignora employees.overtime_authorized) o 'custom' (respeta el flag por
// empleado). Nuevo (Fase 6.4) -- la columna overtime_authorized existia
// desde antes pero nunca se aplicaba en ningun motor; este modo evita que
// activarlo rompa de golpe el total de HE de una empresa que nunca cargo
// el flag con cuidado (dato sucio por defecto en vez de una decision real).
app.get('/config/overtime-authorization-mode', requirePermission('schedules', 'read'), async (req, res) => {
  try {
    const value = await getAppSetting('overtimeAuthorizationMode', resolveTenantId(req), db);
    res.json({ overtimeAuthorizationMode: value || 'all' });
  } catch (err) {
    console.error('ERROR fetching overtime authorization mode:', err);
    res.status(500).json({ error: 'Error fetching overtime authorization mode' });
  }
});

app.post('/config/overtime-authorization-mode', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const mode = req.body.overtimeAuthorizationMode;
    if (mode !== 'all' && mode !== 'custom') {
      return res.status(400).json({ error: "overtimeAuthorizationMode debe ser 'all' o 'custom'" });
    }
    await setAppSetting('overtimeAuthorizationMode', resolveTenantId(req), mode, db);
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving overtime authorization mode:', err);
    res.status(500).json({ error: 'Error saving overtime authorization mode' });
  }
});

// GET /config/users-with-exclusions - Listar usuarios con estado de exclusión
app.get('/config/users-with-exclusions', requirePermission('exclusions', 'read'), async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND u.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [date, effectiveTenantId] : [date];
    const [usersWithStatus] = await db.query(`
      SELECT
        u.USERID,
        u.Badgenumber,
        u.Name,
        CASE
          WHEN ue.id IS NOT NULL THEN true
          ELSE false
        END as isExcluded,
        ue.reason,
        ue.type
      FROM \`users\` u
      LEFT JOIN \`userexclusions\` ue ON u.USERID = ue.userId AND u.tenant_id = ue.tenant_id AND ue.excDate = ?
      WHERE u.USERID > 10
      ${tenantClause}
      ORDER BY u.Name
    `, tenantParams);
    
    res.json(usersWithStatus);
  } catch (err) {
    console.error('ERROR fetching users with exclusions:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// POST /config/toggle-user-exclusion - Incluir/Excluir usuario para una fecha
app.post('/config/toggle-user-exclusion', requirePermission('exclusions', 'update'), async (req, res) => {
  try {
    const { userId, excDate, reason, type, exclude } = req.body;
    
    if (!userId || !excDate) {
      return res.status(400).json({ error: 'userId y excDate son requeridos' });
    }
    if (!(await userBelongsToCallerTenant(userId, req))) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const [[rawUser]] = await db.query('SELECT tenant_id FROM `users` WHERE USERID = ?', [userId]);
    if (!rawUser) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const performedBy = auditLog.actorId(req);

    if (exclude) {
      // Agregar exclusión
      try {
        await auditLog.inTransaction(db, async (conn) => {
          const [result] = await conn.query(`
            INSERT INTO \`userexclusions\` (userId, tenant_id, excDate, reason, type, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [userId, rawUser.tenant_id, excDate, reason || 'Manual exclusion', type || 'FULL_DAY', performedBy]);
          await auditLog.logUserExclusion(conn, {
            tenantId: rawUser.tenant_id,
            exclusionId: result.insertId,
            userId,
            action: 'created',
            data: { excDate, reason: reason || 'Manual exclusion', type: type || 'FULL_DAY' },
            previous: null,
            performedBy
          });
        });

        res.json({ ok: true, message: 'Usuario excluido', excluded: true });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Ya está excluido', excluded: true });
        }
        throw err;
      }
    } else {
      // Eliminar exclusión -- Fase 19: se suma AND tenant_id, userId ya no
      // es unico entre empresas (migracion 20260909).
      //
      // Este borrado es por (userId, excDate, tenant_id), no por id, asi que
      // puede alcanzar MAS DE UNA fila (la clave unica incluye tambien el
      // `type`). Por eso se leen todas primero y se registra una fila de log
      // por cada una: un solo registro "se borro algo" no alcanzaria para
      // reconstruir que habia.
      const [toDelete] = await db.query(`
        SELECT id, tenant_id, userId, excDate, reason, type, event_type_id, excFrom, excTo
        FROM \`userexclusions\`
        WHERE userId = ? AND excDate = ? AND tenant_id = ?
      `, [userId, excDate, rawUser.tenant_id]);

      await auditLog.inTransaction(db, async (conn) => {
        for (const row of toDelete) {
          await auditLog.logUserExclusion(conn, {
            tenantId: row.tenant_id,
            exclusionId: row.id,
            userId: row.userId,
            action: 'deleted',
            data: {
              excDate: row.excDate,
              reason: row.reason,
              type: row.type,
              eventTypeId: row.event_type_id,
              excFrom: row.excFrom,
              excTo: row.excTo
            },
            previous: row,
            performedBy
          });
        }
        await conn.query(`
          DELETE FROM \`userexclusions\`
          WHERE userId = ? AND excDate = ? AND tenant_id = ?
        `, [userId, excDate, rawUser.tenant_id]);
      });

      res.json({ ok: true, message: 'Usuario incluido', excluded: false });
    }
  } catch (err) {
    console.error('ERROR toggling exclusion:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error actualizando exclusión' });
  }
});

// ========================================
// ENDPOINTS PARA EXCLUSIONES PERMANENTES
// ========================================

// GET /config/excluded-users - Obtener todos los usuarios con estado de exclusión
app.get('/config/excluded-users', requirePermission('exclusions', 'read'), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build search query
    const clauses = [];
    const params = [];
    if (search) {
      clauses.push('(Name LIKE ? OR Badgenumber LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    // Fase 19: users ya tiene tenant_id propio (migracion 20260909) -- se
    // filtra directo por eso, que ademas cierra un agujero de la version
    // anterior (dejaba ver un USERID sin vincular de CUALQUIER empresa,
    // porque antes no habia de donde sacarle un tenant_id).
    const effectiveTenantId = resolveTenantId(req);
    if (effectiveTenantId !== null) {
      clauses.push('u.tenant_id = ?');
      params.push(effectiveTenantId);
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total
       FROM users u
       LEFT JOIN user_employee_map um ON um.USERID = u.USERID AND um.tenant_id = u.tenant_id
       LEFT JOIN employees e ON e.id = um.employee_id
       ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get paginated results
    const [users] = await db.query(
      `SELECT u.USERID, u.Badgenumber, COALESCE(e.nombre, u.Name) AS Name, u.isExcluded
       FROM users u
       LEFT JOIN user_employee_map um ON um.USERID = u.USERID AND um.tenant_id = u.tenant_id
       LEFT JOIN employees e ON e.id = um.employee_id
       ${whereClause} ORDER BY Name LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const totalPages = Math.ceil(total / parseInt(limit));

    res.json({
      data: users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: totalPages
      }
    });
  } catch (err) {
    console.error('ERROR getting excluded users:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

// PUT /config/toggle-user-exclusion-permanent - Toggle exclusión permanente
app.put('/config/toggle-user-exclusion-permanent/:userId', requirePermission('exclusions', 'update'), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { exclude } = req.body;

    if (typeof exclude !== 'boolean') {
      return res.status(400).json({ error: 'exclude debe ser true o false' });
    }

    if (!(await userBelongsToCallerTenant(userId, req))) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Fase 19: USERID ya no identifica una unica fila por si solo
    // (migracion 20260909) -- se resuelve el tenant real ANTES de tocar
    // nada, scopeando tanto la lectura como el UPDATE por esa columna en
    // vez de confiar en "la primera fila que traiga MySQL para ese USERID".
    const effectiveTenantId = resolveTenantId(req);
    const lookupQuery = effectiveTenantId !== null
      ? 'SELECT isExcluded, tenant_id FROM users WHERE USERID = ? AND tenant_id = ?'
      : 'SELECT isExcluded, tenant_id FROM users WHERE USERID = ?';
    const lookupParams = effectiveTenantId !== null ? [userId, effectiveTenantId] : [userId];
    const [currentUser] = await db.query(lookupQuery, lookupParams);

    if (currentUser.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await db.query(
      'UPDATE users SET isExcluded = ? WHERE USERID = ? AND tenant_id = ?',
      [exclude ? 1 : 0, userId, currentUser[0].tenant_id]
    );

    res.json({
      ok: true,
      message: exclude ? 'Usuario excluido permanentemente' : 'Usuario incluido',
      excluded: exclude
    });
  } catch (err) {
    console.error('ERROR toggling permanent exclusion:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error actualizando exclusión' });
  }
});

// DELETE /config/user-exclusion/:userId - Eliminar exclusión permanente
app.delete('/config/user-exclusion/:userId', requirePermission('exclusions', 'delete'), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    if (!(await userBelongsToCallerTenant(userId, req))) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Fase 19: mismo criterio que toggle-user-exclusion-permanent -- se
    // resuelve el tenant real antes de tocar nada (USERID ya no identifica
    // una unica fila por si solo, migracion 20260909).
    const effectiveTenantId = resolveTenantId(req);
    const lookupQuery = effectiveTenantId !== null
      ? 'SELECT USERID, tenant_id FROM users WHERE USERID = ? AND tenant_id = ?'
      : 'SELECT USERID, tenant_id FROM users WHERE USERID = ?';
    const lookupParams = effectiveTenantId !== null ? [userId, effectiveTenantId] : [userId];
    const [user] = await db.query(lookupQuery, lookupParams);

    if (user.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Remove exclusion
    await db.query(
      'UPDATE users SET isExcluded = 0 WHERE USERID = ? AND tenant_id = ?',
      [userId, user[0].tenant_id]
    );

    res.json({ ok: true, message: 'Exclusión removida' });
  } catch (err) {
    console.error('ERROR deleting exclusion:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error eliminando exclusión' });
  }
});

// ========================================
// ENDPOINTS PARA ASISTENCIA
// ========================================

// Función auxiliar: convertir HH:mm a minutos desde medianoche
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Dia siguiente (string YYYY-MM-DD) -- para armar rangos sargables
// (c.CHECKTIME >= ... AND < ...) en vez de DATE(c.CHECKTIME) = ?, que
// invalida cualquier indice sobre CHECKTIME y fuerza un full table scan.
function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

// Formatea un Date (hora local del servidor) como YYYY-MM-DD, para armar keys
// de fecha consistentes con el resto de los helpers de este archivo.
function formatLocalDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Igual que formatLocalDate pero con hora -- CRITICO para cualquier campo
// que se mande tal cual al frontend (timeOut/timeIn de Salidas, etc.): un
// objeto Date puesto directo en res.json() se serializa con .toISOString(),
// que SIEMPRE devuelve UTC. Estos Date se construyen con
// `new Date(str.replace(' ', 'T'))` a partir de un string de MySQL que en
// realidad es hora LOCAL de Argentina sin marca de zona -- en un proceso
// cuyo huso horario del sistema operativo sea Argentina (como esta compu),
// eso da el resultado correcto sin que se note el problema, pero en
// produccion (Render, contenedor en UTC) el mismo dato se interpreta como
// si esas horas ya fueran UTC, y el JSON manda una hora que el navegador
// (en Argentina) vuelve a correr 3 horas para atras al mostrarla -- bug
// real encontrado en produccion (Salidas mostraba todo 3hs atrasado).
// getFullYear/getHours/etc. leen los componentes en la MISMA referencia
// con la que se construyo el Date, sin importar el huso horario del
// proceso -- por eso formatear a mano en vez de dejar que
// JSON.stringify llame a toISOString() es la forma segura.
function formatLocalDateTime(date) {
  if (!date) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// Hora local "HH:mm" a partir de un Date -- mismo criterio que
// formatLocalDateTime (getHours/getMinutes locales, nunca toISOString) para
// no repetir el bug de 3hs de diferencia en produccion. Usado para exponer
// la hora exacta de inicio/fin de HE (resolveDailyOvertime devuelve Date,
// no un string de la base).
function formatLocalTime(date) {
  if (!date) return null;
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

// Función auxiliar: extraer hora de YYYY-MM-DD HH:mm:ss
function extractTime(datetimeStr) {
  if (!datetimeStr) return '00:00';
  const parts = datetimeStr.split(' ');
  if (parts.length < 2) return datetimeStr; // Si no tiene espacio, asumir que es solo HH:mm
  return parts[1].substring(0, 5); // HH:mm
}

// 4. LISTA DE ASISTENCIA DIARIA - MEJORADO CON TOLERANCIA
app.get('/attendance/:date', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const { date } = req.params; // YYYY-MM-DD
    const tolerance = req.query.tolerance || 10; // minutos
    const scheduleTime = req.query.scheduleTime || '07:00'; // HH:mm
    // Fase 19: este endpoint ("Legacy" en el selector de Presentismo, solo
    // para comparar contra el Motor Laboral) NUNCA filtraba por tenant --
    // devolvia SIEMPRE la asistencia de TODAS las empresas mezcladas, sin
    // importar quien la pidiera. Mismo criterio que el resto del sistema:
    // null = superadmin sin ?tenantId, sin restriccion.
    const effectiveTenantId = resolveTenantId(req);

    console.log(`📅 REQUEST /attendance/${date}`);
    console.log(`   tolerance: ${tolerance}, scheduleTime: ${scheduleTime}`);

    // PASO 1: Obtener todos los usuarios (excepto ficticios y excluidos)
    let users = [];
    try {
      const usersParams = [];
      let usersQuery = `
        SELECT
          u.USERID,
          u.Badgenumber,
          COALESCE(e.nombre, u.Name) AS Name,
          e.ciudad_id AS ciudad_id
        FROM \`users\` u
        LEFT JOIN \`user_employee_map\` um ON um.USERID = u.USERID AND um.tenant_id = u.tenant_id
        LEFT JOIN \`employees\` e ON e.id = um.employee_id
        WHERE u.USERID > 10
          AND u.isExcluded = 0`;
      if (effectiveTenantId !== null) {
        usersQuery += ` AND u.tenant_id = ?`;
        usersParams.push(effectiveTenantId);
      }
      usersQuery += ` ORDER BY Name`;
      const [usersResult] = await db.query(usersQuery, usersParams);
      users = usersResult || [];
      console.log(`✓ Usuarios desde tabla users: ${users.length}`);
    } catch (e) {
      console.error(`❌ Error fetching users: ${e.message}`);
      users = [];
    }

    // PASO 1B: Obtener empleados importados que no tienen user mapeado
    let importedEmployees = [];
    try {
      const importedParams = [];
      let importedQuery = `
        SELECT e.id, e.employee_id, e.nombre, e.activo, e.ciudad_id
        FROM \`employees\` e
        WHERE e.activo = 1
          AND NOT EXISTS (
            SELECT 1 FROM \`user_employee_map\` uem
            WHERE uem.employee_id = e.id
          )`;
      if (effectiveTenantId !== null) {
        importedQuery += ` AND e.tenant_id = ?`;
        importedParams.push(effectiveTenantId);
      }
      importedQuery += ` ORDER BY e.nombre`;
      const [employeesResult] = await db.query(importedQuery, importedParams);
      importedEmployees = employeesResult || [];
      console.log(`✓ Empleados importados (sin mapear): ${importedEmployees.length}`);
      
      // Agregar empleados importados como si fueran usuarios
      // Usamos un ID negativo para identificarlos como sin checkins
      importedEmployees.forEach(emp => {
        users.push({
          USERID: -emp.id, // ID negativo para identificar como empleado importado
          Badgenumber: emp.employee_id,
          Name: emp.nombre,
          ciudad_id: emp.ciudad_id,
          isImported: true
        });
      });
      
      console.log(`✓ Total de usuarios (incluyendo empleados importados): ${users.length}`);
    } catch (e) {
      console.error(`⚠️ Error fetching imported employees: ${e.message}`);
    }
    
    // PASO 2: Obtener horario configurado del día (si existe)
    const defaultDayOfWeek = scheduleRepository.getLocalDayOfWeek(date);
    let schedule = {
      timeEntrance: scheduleTime + ':00',
      timeExit: '13:40:00',
      isWorkDay: defaultDayOfWeek !== 0 && defaultDayOfWeek !== 6
    };
    
    try {
      const [scheduleRows] = await db.query(`
        SELECT timeEntrance, timeExit, isWorkDay
        FROM \`companyschedule\`
        WHERE scheduleDate = ?
      `, [date]);
      
      if (scheduleRows && scheduleRows.length > 0) {
        schedule = scheduleRows[0];
        console.log(`✓ Schedule encontrado`);
      } else {
        console.log(`⚠️ No hay schedule, usando defaults`);
      }
    } catch (e) {
      console.error(`⚠️ Error fetching schedule: ${e.message}`);
    }

    // PASO 2B: Consultar holidays para el día, incluyendo recurrentes.
    // Fase 21: se suma el filtro por tenant_id (bug real -- esta consulta
    // nunca lo tuvo, una empresa veia el feriado de otra) y el feriado ya
    // puede venir acotado a una ciudad puntual (holiday.ciudad_id) -- ver
    // holidayAppliesToEmployee mas abajo, evaluado por empleado.
    let holidays = [];
    try {
      const holidayParams = [date, date];
      let holidayTenantClause = '';
      if (effectiveTenantId !== null) {
        holidayTenantClause = ' AND (tenant_id = ? OR tenant_id IS NULL)';
        holidayParams.push(effectiveTenantId);
      }
      const [holidayRows] = await db.query(
        `SELECT *
         FROM \`holidays\`
         WHERE (date = ? OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') = DATE_FORMAT(?, '%m-%d')))${holidayTenantClause}`,
        holidayParams
      );
      holidays = holidayRows || [];
      // Solo un feriado SIN ciudad (toda la empresa) apaga el dia entero --
      // uno acotado a una ciudad se evalua por empleado, no aca.
      const companyWideHolidayNotWork = holidays.some(h => isNonWorkHoliday(h) && h.ciudad_id == null);
      if (companyWideHolidayNotWork) {
        schedule.isWorkDay = false;
        console.log(`⚠️ Día marcado como no laborable por holidays`);
      }
    } catch (e) {
      console.error(`⚠️ Error fetching holidays: ${e.message}`);
    }

    // IMPORTANTE: Incluso si no es un día laboral (feriado), procesamos los fichajes.
    // Esto es para capturar a personas que trabajan en feriados (médicos, policías, etc.)
    const entranceTime = extractTime(schedule.timeEntrance) || scheduleTime;
    const entranceMinutes = timeToMinutes(entranceTime);
    const toleranceMinutes = parseInt(tolerance);

    console.log(`✓ Entrance: ${entranceTime}, Tolerance: ${toleranceMinutes}min`);
    if (holidays.some(h => isNonWorkHoliday(h))) {
      console.log(`⚠️ HOLIDAY: ${holidays.map(h => h.name).join(', ')} - procesando fichas por empleado segun su ciudad`);
    }
    let checkins = [];
    try {
      // Join Checkins con users para obtener los fichajes con el Badgenumber correcto
      const checkinsParams = [date, nextDayStr(date)];
      let checkinsQuery = `
        SELECT u.USERID, c.CHECKTIME
        FROM \`Checkins\` c
        LEFT JOIN \`users\` u ON CAST(c.USERID AS CHAR) = CAST(u.Badgenumber AS CHAR) AND u.tenant_id = c.tenant_id
        WHERE c.CHECKTIME >= ? AND c.CHECKTIME < ?`;
      if (effectiveTenantId !== null) {
        checkinsQuery += ` AND c.tenant_id = ?`;
        checkinsParams.push(effectiveTenantId);
      }
      checkinsQuery += ` ORDER BY u.USERID, c.CHECKTIME`;
      const [checkinsResult] = await db.query(checkinsQuery, checkinsParams);
      checkins = checkinsResult || [];
      console.log(`✓ Fichajes (matched by Badgenumber): ${checkins.length}`);
    } catch (e) {
      console.error(`❌ Error fetching checkins: ${e.message}`);
      checkins = [];
    }
    
    // PASO 4: Obtener exclusiones del día
    let exclusions = [];
    try {
      const exclusionsParams = [date];
      let exclusionsQuery = `
        SELECT userId, reason, type, excFrom, excTo
        FROM \`userexclusions\`
        WHERE excDate = ?`;
      if (effectiveTenantId !== null) {
        exclusionsQuery += ` AND tenant_id = ?`;
        exclusionsParams.push(effectiveTenantId);
      }
      const [exclusionsResult] = await db.query(exclusionsQuery, exclusionsParams);
      exclusions = exclusionsResult || [];
      console.log(`✓ Exclusiones: ${exclusions.length}`);
    } catch (e) {
      console.error(`⚠️ Error fetching exclusions: ${e.message}`);
      exclusions = [];
    }

    // PASO 4B: Obtener licencias multi-día (vacaciones, enfermedad, etc.) vigentes ese día
    let leaveEvents = [];
    try {
      leaveEvents = await employeeEventRepository.findByDate(date, db);
      console.log(`✓ Licencias vigentes: ${leaveEvents.length}`);
    } catch (e) {
      console.error(`⚠️ Error fetching employee events: ${e.message}`);
      leaveEvents = [];
    }

    // PASO 5: Agrupar fichajes por usuario (ahora con USERID correcto del users table)
    const checkinsByUser = {};
    checkins.forEach(c => {
      if (c.USERID === null) return; // Skip checkins que no tienen matching en users
      if (!checkinsByUser[c.USERID]) {
        checkinsByUser[c.USERID] = [];
      }
      checkinsByUser[c.USERID].push(c.CHECKTIME);
    });
    
    // PASO 6: Calcular asistencia para cada usuario
    const attendance = users.map(u => {
      const userCheckins = checkinsByUser[u.USERID] || [];
      const userExclusion = exclusions.find(e => e.userId === u.USERID);
      const userLeave = leaveEvents.find(ev => String(ev.legajo) === String(u.Badgenumber));

      let status = 'Absent';
      let firstCheckin = null;
      let lastCheckin = null;
      // Feriado por ciudad (Fase 21): uno sin ciudad_id aplica a todo el
      // mundo, uno con ciudad_id solo pesa para los empleados de ESA ciudad.
      const userHolidayApplies = holidays.some(h => isNonWorkHoliday(h) && holidayAppliesToEmployee(h, u.ciudad_id));
      let workedOnHoliday = false;

      if (userCheckins.length > 0) {
        firstCheckin = userCheckins[0];
        lastCheckin = userCheckins[userCheckins.length - 1];

        // Mismo criterio que /attendance-range y el motor nuevo (no
        // reimplementado acá): una exclusión con excTo justifica la
        // tardanza en vez de excusar el día entero -- antes esta ruta
        // marcaba "Excused" apenas existía CUALQUIER exclusión, sin mirar
        // si la persona igual había fichado todo el día.
        const firstTimeStr = extractTime(firstCheckin);
        const firstTimeMin = timeToMinutes(firstTimeStr);
        const { isLate, justified } = attendanceCalc.resolveLateJustification({
          firstMinutes: firstTimeMin,
          entranceMinutes,
          toleranceMinutes,
          exclusion: userExclusion
        });
        status = !isLate ? 'OnTime' : (justified ? 'LateJustified' : 'Late');

        // Marcar si trabajó en feriado
        if (userHolidayApplies) {
          workedOnHoliday = true;
          status = 'WorkedHoliday';
        }
      } else if (userExclusion || userLeave) {
        status = 'Excused';
      } else if (userHolidayApplies) {
        // En un feriado sin fichajes: mostrar como "Feriado" en lugar de "Ausente"
        status = 'HolidayAbsent';
      }

      return {
        userId: u.USERID,
        badgeNumber: u.Badgenumber,
        name: u.Name,
        status: status,
        firstCheckin: firstCheckin,
        lastCheckin: lastCheckin,
        totalCheckins: userCheckins.length,
        checkins: userCheckins,
        exclusion: userExclusion || null,
        workedOnHoliday: workedOnHoliday
      };
    });
    
    // PASO 7: Calcular resumen
    const summary = {
      onTime: attendance.filter(a => a.status === 'OnTime').length,
      late: attendance.filter(a => a.status === 'Late').length,
      lateJustified: attendance.filter(a => a.status === 'LateJustified').length,
      absent: attendance.filter(a => a.status === 'Absent').length,
      excused: attendance.filter(a => a.status === 'Excused').length,
      total: attendance.length
    };
    
    console.log(`✓ RESUMEN: OnTime=${summary.onTime}, Late=${summary.late}, Absent=${summary.absent}, Excused=${summary.excused}`);
    
    res.json({
      date: date,
      schedule: {
        timeEntrance: entranceTime,
        timeExit: extractTime(schedule.timeExit) || '13:40',
        isWorkDay: schedule.isWorkDay,
        tolerance: toleranceMinutes
      },
      holidays: holidays,
      isHolidayWorkDay: holidays.some(h => isNonWorkHoliday(h)),
      summary: summary,
      attendance: attendance
    });
    
  } catch (err) {
    console.error(`❌ ERROR: ${err.message}`);
    console.error(err.stack);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error fetching attendance', details: err.message });
  }
});

//get para rango de fechas
app.get('/attendance-range', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'from y to requeridos' });
    }

    // IMPORTANTE: parsear "YYYY-MM-DD" con new Date(str) lo interpreta como UTC medianoche;
    // en un servidor con huso horario negativo (Argentina UTC-3) eso corre el rango un día
    // para atrás al volver a leer los componentes en hora local. Parseamos por componentes
    // para anclar la fecha a medianoche local, igual que ya hace getLocalDayOfWeek.
    const parseLocalDateOnly = (dateString) => {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(year, month - 1, day);
    };
    const formatLocalDate = (date) => {
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    const startDate = parseLocalDateOnly(from);
    const endDate = parseLocalDateOnly(to);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Fechas inválidas' });
    }

    const today = new Date();
    const effectiveEndDate = endDate > today ? today : endDate;
    const dateRange = [];
    for (let d = new Date(startDate); d <= effectiveEndDate; d.setDate(d.getDate() + 1)) {
      dateRange.push(formatLocalDate(d));
    }

    if (dateRange.length === 0) {
      return res.json({ from, to, data: [] });
    }

    // Turnos que cruzan medianoche ("sereno", 22:00-06:00, etc.): para que
    // el PRIMER y el ULTIMO dia del rango pedido tambien queden bien
    // resueltos (ver attendanceCalc.reassignOvernightCheckins mas abajo)
    // hace falta un dia de margen de cada lado. "previousDayStr" es el dia
    // ANTERIOR a "from" -- solo se necesita su SCHEDULE (para saber si ESE
    // dia cruzaba medianoche y asi limpiarle la madrugada al primer dia
    // pedido), no sus fichajes. "nextDayAfterRangeStr" es el dia SIGUIENTE
    // a effectiveEndDate -- de ese hace falta sus FICHAJES (para poder
    // encontrarle una salida real al ultimo dia pedido, si tambien cruza
    // medianoche). Ninguno de los dos se expone como un dia propio del
    // resultado, solo se usan puertas adentro para no cortar un turno a la
    // mitad justo en el borde del rango consultado.
    const dayBeforeRange = new Date(startDate);
    dayBeforeRange.setDate(dayBeforeRange.getDate() - 1);
    const previousDayStr = formatLocalDate(dayBeforeRange);
    const dayAfterRange = new Date(effectiveEndDate);
    dayAfterRange.setDate(dayAfterRange.getDate() + 1);
    const nextDayAfterRangeStr = formatLocalDate(dayAfterRange);

    const tenantId = resolveTenantId(req);
    const personalLeaveLimitValue = await getAppSetting('personalLeaveMonthlyLimitMinutes', tenantId, db);
    const personalLeaveMonthlyLimitMinutes = personalLeaveLimitValue ? Number(personalLeaveLimitValue) : 0;
    const distinctMonthsInRange = new Set(dateRange.map(d => d.slice(0, 7))).size;
    const personalLeaveLimitMinutesForRange = personalLeaveMonthlyLimitMinutes * distinctMonthsInRange;

    const detailEmployeeId = req.query.employeeId ? String(req.query.employeeId) : null;
    let employees = await userRepository.findAll({ tenantId }, db);
    if (detailEmployeeId) {
      employees = employees.filter(e => String(e.employeeId) === detailEmployeeId);
    }
    const employeeIds = employees
      .map(e => Number(e.employeeId))
      .filter(id => !Number.isNaN(id));
    // Etapa 14 (hallazgo #1): e.employeeId (arriba) es el LEGAJO, no el
    // PK -- employee_convention_assignments.employee_id SI es el PK
    // (employees.id, mismo criterio que employee_work_calendars), hace
    // falta esta lista aparte para poder consultarla.
    const internalEmployeeIds = employees
      .map(e => e.internalEmployeeId)
      .filter(id => typeof id === 'number' && !Number.isNaN(id));

    const tenantIds = Array.from(new Set(
      employees
        .map(e => e.tenantId)
        .filter(tid => tid !== undefined && tid !== null)
    ));

    // Fase 21: se suma el filtro por tenant_id (bug real -- esta consulta
    // nunca lo tuvo, una empresa veia el feriado de otra) y ciudad_id (para
    // poder acotar un feriado a una ciudad puntual). Los Maps pasan a
    // guardar un ARRAY de filas por fecha (antes una sola) -- puede haber
    // mas de un feriado el mismo dia (uno de toda la empresa + uno de una
    // ciudad puntual, o dos ciudades distintas que coinciden en fecha).
    const monthDays = Array.from(new Set(dateRange.map(d => d.slice(5))));
    const holidayRangeParams = [from, formatLocalDate(effectiveEndDate), monthDays];
    let holidayRangeTenantClause = '';
    if (tenantId !== null) {
      holidayRangeTenantClause = ' AND (tenant_id = ? OR tenant_id IS NULL)';
      holidayRangeParams.push(tenantId);
    }
    const [holidayRows] = await db.query(
      `SELECT date, isWorkDay, recurring, ciudad_id
       FROM holidays
       WHERE (date BETWEEN ? AND ?
         OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') IN (?)))${holidayRangeTenantClause}`,
      holidayRangeParams
    );

    const holidayByDate = new Map();
    const recurringHolidayByMonthDay = new Map();
    holidayRows.forEach(h => {
      if (h.recurring) {
        const key = h.date.slice(5);
        if (!recurringHolidayByMonthDay.has(key)) recurringHolidayByMonthDay.set(key, []);
        recurringHolidayByMonthDay.get(key).push(h);
      } else {
        if (!holidayByDate.has(h.date)) holidayByDate.set(h.date, []);
        holidayByDate.get(h.date).push(h);
      }
    });

    // Resolución de horarios optimizada: antes esto hacía 1 (o más) consultas
    // a la DB POR CADA DÍA del rango (365 días × varias queries cada uno en un
    // reporte anual), incluyendo re-consultar la misma plantilla/tenant una y
    // otra vez porque ni la plantilla activa de un tenant ni sus shift_blocks
    // cambian según la fecha (solo según el día de la semana, que tiene nada
    // más que 7 variantes). Ahora se resuelve todo una sola vez para todo el
    // rango y se arma cada día en memoria.
    const tenantTemplateByTenantId = {};
    for (const tenantId of tenantIds) {
      tenantTemplateByTenantId[tenantId] = await scheduleRepository.findTenantTemplate(null, tenantId, db);
    }
    const defaultTemplate = await scheduleRepository.findTenantTemplate(null, null, db);

    const needsCompanySchedule = Object.values(tenantTemplateByTenantId).some(t => !t) || !defaultTemplate;
    const companyScheduleByDate = {};
    if (needsCompanySchedule) {
      const [csRows] = await db.query(
        `SELECT * FROM companyschedule WHERE scheduleDate BETWEEN ? AND ?`,
        [from, formatLocalDate(effectiveEndDate)]
      );
      csRows.forEach(row => { companyScheduleByDate[row.scheduleDate] = row; });
    }

    // Arranca en previousDayStr (no "from") para poder resolver el
    // schedule del dia anterior al rango pedido -- ver comentario de
    // reassignOvernightCheckins mas abajo.
    const assignedCalendarRowsByEmployee = await scheduleRepository.findAssignedCalendarRowsForRange(
      previousDayStr, formatLocalDate(effectiveEndDate), employeeIds, db, tenantId
    );

    const involvedTemplateIds = [
      ...Object.values(tenantTemplateByTenantId).filter(Boolean).map(t => t.id),
      ...(defaultTemplate ? [defaultTemplate.id] : []),
      ...Object.values(assignedCalendarRowsByEmployee).flat().map(r => r.id)
    ];
    const blocksByTemplate = await scheduleRepository.getShiftBlocksByTemplate(involvedTemplateIds, db);

    // Etapa 12/14: el motor nuevo corre para cualquier plantilla en modo
    // 'shadow' (informativo, Legacy sigue siendo el oficial) O 'active'
    // (hallazgo #5 de la auditoria -- el resultado del motor nuevo PASA A
    // SER el oficial para esa plantilla, ver Etapa 4 del plan). Si
    // ninguna plantilla involucrada esta en alguno de estos 2 modos (el
    // caso de TODOS los tenants reales hoy, default 'legacy'), se salta
    // por completo esta seccion: cero query extra, cero costo por dia.
    const involvedTemplateRows = [
      ...Object.values(tenantTemplateByTenantId).filter(Boolean),
      ...(defaultTemplate ? [defaultTemplate] : []),
      ...Object.values(assignedCalendarRowsByEmployee).flat()
    ];
    const engineModeTemplateIds = new Set(
      involvedTemplateRows.filter(t => t.rules_engine_mode === 'shadow' || t.rules_engine_mode === 'active').map(t => t.id)
    );
    const engineModeActive = engineModeTemplateIds.size > 0;
    // Etapa 14 (hallazgo #1 de la auditoria): antes de esto, un convenio
    // asignado a un empleado no tenia NINGUN efecto en el calculo -- se
    // trae de una sola vez (mismo criterio de rango que ya usa
    // assignedCalendarRowsByEmployee para plantillas) el encuadramiento
    // de cada empleado para poder resolver, dia por dia, que reglas de
    // day_type_overtime_rules le corresponden por SU convenio.
    const conventionAssignmentRowsByEmployee = engineModeActive
      ? await conventionAssignmentRepository.findAssignmentRowsForRange(previousDayStr, formatLocalDate(effectiveEndDate), internalEmployeeIds, db)
      : {};
    const involvedConventionIds = new Set(
      Object.values(conventionAssignmentRowsByEmployee).flat().map((row) => row.convention_id)
    );
    const dayTypeRulesForEngine = engineModeActive
      ? await dayTypeRuleRepository.findForScopes({
          tenantIds,
          templateIds: [...engineModeTemplateIds],
          conventionIds: [...involvedConventionIds]
        }, db)
      : [];
    // Etapa 14 (hallazgo #3 de la auditoria): snapshots historicos de
    // tolerancia para las plantillas en modo sombra/activo -- en la
    // enorme mayoria de los casos esto es un array vacio (ninguna cambio
    // nunca su configuracion), y resolveHistoricalToleranceFields cae al
    // comportamiento de siempre (usar la plantilla en vivo).
    const templateConfigHistoryForEngine = engineModeActive
      ? await templateConfigHistoryRepository.findForTemplates([...engineModeTemplateIds], db)
      : [];
    // Diferencias encontradas por TODO el request (todos los empleados,
    // todos los dias) -- se insertan en un solo lote al final, best-effort
    // (un error aca no debe romper la respuesta oficial de /attendance-range).
    const shadowDiffsToPersist = [];
    // Etapa 14 (hallazgo #8 de la auditoria): resolveScheduleSegments se
    // llamaba de nuevo por CADA empleado que comparte el mismo
    // (plantilla, dia) -- redundante (el resultado es identico) aunque
    // barato hoy. scheduleByDate ya reusa la MISMA referencia de
    // schedule.blocks para todos los empleados de un mismo dia/plantilla,
    // asi que un WeakMap keyeado por esa referencia alcanza sin tener que
    // armar una clave string por (templateId, dia de semana).
    const scheduleSegmentsCache = new WeakMap();

    const scheduleFromTemplate = (template, date) => {
      const dow = scheduleRepository.getLocalDayOfWeek(date);
      const blocks = (blocksByTemplate[template.id] && blocksByTemplate[template.id][dow]) || [];
      return scheduleRepository.buildScheduleFromBlocks(template, blocks, date);
    };

    const scheduleByDate = {};
    for (const date of [previousDayStr, ...dateRange]) {
      const assignedScheduleMap = {};
      for (const employeeId of Object.keys(assignedCalendarRowsByEmployee)) {
        const rows = assignedCalendarRowsByEmployee[employeeId];
        const active = rows.find(r => r.valid_from <= date && (r.valid_to === null || r.valid_to >= date));
        if (active) {
          assignedScheduleMap[employeeId] = scheduleFromTemplate(active, date);
        }
      }

      const tenantScheduleMap = {};
      for (const tenantId of tenantIds) {
        const template = tenantTemplateByTenantId[tenantId];
        if (template) {
          tenantScheduleMap[tenantId] = scheduleFromTemplate(template, date);
        } else if (companyScheduleByDate[date]) {
          tenantScheduleMap[tenantId] = companyScheduleByDate[date];
        }
      }

      let defaultSchedule = null;
      if (defaultTemplate) {
        defaultSchedule = scheduleFromTemplate(defaultTemplate, date);
      } else if (companyScheduleByDate[date]) {
        defaultSchedule = companyScheduleByDate[date];
      }

      scheduleByDate[date] = { assignedScheduleMap, tenantScheduleMap, defaultSchedule };
    }

    // Rango sargable (c.CHECKTIME >= ... AND < ...) en vez de DATE(c.CHECKTIME)
    // BETWEEN ...: envolver la columna en DATE() invalida cualquier indice y
    // fuerza un full table scan -- confirmado con EXPLAIN contra produccion
    // (129043 filas escaneadas para traer un solo mes). El limite superior es
    // exclusivo: DOS dias despues del ultimo del rango (no uno) -- el dia
    // extra (nextDayAfterRangeStr) trae los fichajes de la madrugada
    // siguiente, necesarios para poder encontrarle una salida real al
    // ultimo dia pedido si su turno cruza medianoche (ver
    // reassignOvernightCheckins mas abajo). Esos fichajes de mas nunca se
    // exponen como un dia propio -- dateRange.forEach, unas lineas mas
    // abajo, solo recorre los dias pedidos.
    const exclusiveEndDate = new Date(effectiveEndDate);
    exclusiveEndDate.setDate(exclusiveEndDate.getDate() + 2);
    const exclusiveEndDateStr = formatLocalDate(exclusiveEndDate);

    // Fase 19: se suma tenant_id a cada JOIN de esta cadena (Checkins ->
    // users -> user_employee_map, migracion 20260909) -- este es EL
    // endpoint principal de Presentismo/Horas Extra. Sin esto, un USERID
    // compartido con OTRA empresa (numeracion de reloj por defecto,
    // habitual entre dos empresas distintas) podia atribuirle en silencio
    // el fichaje de esa otra empresa a un empleado real de esta.
    const checkinsRangeParams = [from, exclusiveEndDateStr];
    let checkinsRangeQuery = `
      SELECT DATE(c.CHECKTIME) AS date,
             c.CHECKTIME,
             e.employee_id AS employeeId,
             u.USERID AS userId
      FROM Checkins c
      LEFT JOIN users u
        ON (u.USERID = c.USERID OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR))
        AND u.tenant_id = c.tenant_id
      LEFT JOIN user_employee_map uem ON uem.USERID = u.USERID AND uem.tenant_id = u.tenant_id
      LEFT JOIN employees e ON e.id = uem.employee_id
      WHERE c.CHECKTIME >= ? AND c.CHECKTIME < ?`;
    if (tenantId !== null) {
      checkinsRangeQuery += ` AND c.tenant_id = ?`;
      checkinsRangeParams.push(tenantId);
    }
    checkinsRangeQuery += ` ORDER BY employeeId, c.CHECKTIME`;
    const [checkins] = await db.query(checkinsRangeQuery, checkinsRangeParams);

    const checkinsByEmployee = {};
    checkins.forEach(c => {
      if (!c.employeeId) return;
      const employeeId = String(c.employeeId);
      const date = c.date;
      if (!checkinsByEmployee[employeeId]) checkinsByEmployee[employeeId] = {};
      if (!checkinsByEmployee[employeeId][date]) checkinsByEmployee[employeeId][date] = [];
      checkinsByEmployee[employeeId][date].push(c.CHECKTIME);
    });

    const exclusionsRangeParams = [from, formatLocalDate(effectiveEndDate)];
    let exclusionsRangeQuery = `
      SELECT ue.userId, ue.excDate, ue.type, ue.reason, ue.excFrom, ue.excTo, et.code AS eventTypeCode, et.descripcion AS eventTypeDescripcion
      FROM userexclusions ue
      LEFT JOIN event_types et ON et.id = ue.event_type_id
      WHERE ue.excDate BETWEEN ? AND ?`;
    if (tenantId !== null) {
      exclusionsRangeQuery += ` AND ue.tenant_id = ?`;
      exclusionsRangeParams.push(tenantId);
    }
    const [exclusions] = await db.query(exclusionsRangeQuery, exclusionsRangeParams);
    const exclusionsMap = new Map(exclusions.map(e => [`${e.userId}_${e.excDate}`, e]));

    // Licencias multi-día (vacaciones, enfermedad, etc.) cargadas en employee_events:
    // se expanden día por día para que cualquier fecha dentro del rango de la licencia
    // cuente como excusada en vez de ausente, igual que una exclusión puntual.
    const employeeEventRows = await employeeEventRepository.findByRange(from, formatLocalDate(effectiveEndDate), db);
    const leaveEventMap = new Map();
    employeeEventRows.forEach(ev => {
      const evStart = ev.fecha_desde > from ? ev.fecha_desde : from;
      const evEnd = ev.fecha_hasta < formatLocalDate(effectiveEndDate) ? ev.fecha_hasta : formatLocalDate(effectiveEndDate);
      for (let d = parseLocalDateOnly(evStart); formatLocalDate(d) <= evEnd; d.setDate(d.getDate() + 1)) {
        leaveEventMap.set(`${ev.legajo}_${formatLocalDate(d)}`, ev);
      }
    });

    // ManualEntries (HE manual, Licencia, Omitir -- cargadas desde "Importar
    // Fichajes y Usuarios" / Presentismo, Fase 6): antes solo se sumaban en
    // GET /data (motor separado, sin horarios/feriados/exclusiones), invisible
    // en este endpoint. 'he'/'licencia' suman minutos al total del dia
    // (aunque no haya fichajes ese dia -- una licencia manual no requiere
    // marcar reloj). 'omit' anula el computo automatico de ESE dia (para
    // cuando un fichaje real no corresponde a horas extra) sin afectar el
    // estado de presentismo (llegada tarde/ausente siguen igual).
    const [manualEntryRows] = await db.query(`
      SELECT id, userId, DATE(startDatetime) AS date, durationMinutes, type
      FROM ManualEntries
      WHERE startDatetime >= ? AND startDatetime < ?
    `, [from, exclusiveEndDateStr]);
    const manualMinutesByUserDate = new Map();
    // Antes era un Set (solo si HABIA un omit ese dia) -- ahora un Map a su
    // id, para que el frontend pueda des-marcar "Omitir" con un checkbox
    // directo (DELETE /delete/manual/:id) sin tener que abrir el dialogo
    // completo solo para consultar cual es el id de la entrada a borrar.
    const manualOmitByUserDate = new Map();
    manualEntryRows.forEach(m => {
      const key = `${m.userId}_${m.date}`;
      if (m.type === 'omit') {
        manualOmitByUserDate.set(key, m.id);
      } else {
        manualMinutesByUserDate.set(key, (manualMinutesByUserDate.get(key) || 0) + Number(m.durationMinutes));
      }
    });

    const getScheduleEntry = (date, assignedScheduleMap, tenantScheduleMap, employeeId, tenantId) => {
      if (assignedScheduleMap && assignedScheduleMap[employeeId]) {
        return assignedScheduleMap[employeeId];
      }
      if (tenantScheduleMap && tenantId != null && tenantScheduleMap[tenantId]) {
        return tenantScheduleMap[tenantId];
      }
      if (scheduleByDate[date].defaultSchedule) {
        return scheduleByDate[date].defaultSchedule;
      }
      const dayOfWeek = scheduleRepository.getLocalDayOfWeek(date);
      return {
        date,
        timeEntrance: '07:00:00',
        timeExit: '13:40:00',
        isWorkDay: dayOfWeek !== 0 && dayOfWeek !== 6 ? 1 : 0,
        source: 'legacy'
      };
    };

    // Todas las filas de holidays que caen en esta fecha (exactas +
    // recurrentes) -- sin filtrar todavia por empleado, eso lo hace el
    // llamador con holidayAppliesToEmployee (ciudad_id de cada fila vs. la
    // del empleado).
    const getHolidaysForDate = (date) => {
      const exact = holidayByDate.get(date) || [];
      const recurring = recurringHolidayByMonthDay.get(date.slice(5)) || [];
      return exact.concat(recurring);
    };

    const extractTime = (datetimeStr) => {
      if (!datetimeStr) return '00:00';
      const parts = datetimeStr.split(' ');
      return parts.length < 2 ? datetimeStr : parts[1].substring(0, 5);
    };

    // Etapa 14 (hallazgo #5 de la auditoria): equivalente de
    // formatLocalTime(overtimeResult.start) pero para el motor nuevo --
    // sus segmentos estan en minutos (una linea de tiempo continua, ver
    // timeClassifier.js), no en objetos Date. Toma el primer segmento
    // OVERTIME (ordenado) como el inicio de la HE del dia.
    const engineOvertimeStartTimeLabel = (result) => {
      const overtimeSeg = (result.classifiedSegments || [])
        .filter((s) => s.type === 'OVERTIME')
        .sort((a, b) => a.startMinutes - b.startMinutes)[0];
      if (!overtimeSeg) return null;
      const normalized = ((overtimeSeg.startMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
      const h = Math.floor(normalized / 60);
      const m = normalized % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // "Posible entrada particular": un marcador PARTICULAR/REGRESO (badge 5)
    // puede preceder al primer fichaje del día sin que haya una salida
    // abierta -- pasa cuando alguien avisó el día anterior que iba a entrar
    // tarde (autorización firmada) y nunca ficha una "salida" ese día. Se
    // detecta solo en modo detalle (un empleado puntual, que es como lo
    // consume el modal de attendance.html) para no pagar este costo en el
    // resumen de toda la empresa. Reusa exactamente las mismas filas crudas
    // de `checkins` (ya incluyen los fichajes de los marcadores, hoy
    // descartados más abajo por no tener employeeId) -- no se hace una
    // consulta nueva.
    // Fichajes crudos agrupados por dia, con Date reales -- insumo comun
    // para detectMovements (marcadores de PARTICULAR y de HE), armado una
    // sola vez y reusado para ambos, sin consultas nuevas.
    const checkinsByDateForDetection = new Map();
    checkins.forEach(c => {
      if (!checkinsByDateForDetection.has(c.date)) checkinsByDateForDetection.set(c.date, []);
      checkinsByDateForDetection.get(c.date).push({
        checktime: new Date(c.CHECKTIME.replace(' ', 'T')),
        userId: c.userId,
        employeeId: c.employeeId !== null ? String(c.employeeId) : null
      });
    });

    // Pedido real: "diferenciar bien... salida particular, que estan en
    // salidas" -- el calendario de Presentismo no distinguia nunca un dia
    // con salida particular (esa info solo se veia en la pantalla de
    // Salidas). Se agrega como una bandera aparte (hasParticularExit, ver
    // mas abajo), NO como un status nuevo excluyente -- un dia puede ser
    // "OnTime" y tener ademas una salida particular esa tarde, son cosas
    // independientes. Corre para TODO el rango (no solo en modo detalle),
    // igual que ya hace la deteccion de HE de mas abajo, porque afecta el
    // calendario de cualquier empleado, no solo el detalle de uno puntual.
    // Alcance acotado a proposito: solo detecta una salida+regreso
    // COMPLETOS el mismo dia (closedEvents) -- no reproduce la logica de
    // eventos abiertos/huerfanos de /movements-range (eso queda para la
    // pantalla de Salidas, que sigue siendo la fuente de verdad del detalle).
    const possibleJustificationByEmployeeDate = new Map();
    const particularExitByEmployeeDate = new Set(); // `${employeeId}|${date}`
    {
      const particularMarkerMap = await fetchMarkerMap('PARTICULAR', tenantId);
      const maxMarkerGapMs = await fetchMarkerMaxGapMs(tenantId);
      for (const [date, dayCheckins] of checkinsByDateForDetection.entries()) {
        const { closedEvents, orphanReturns } = movementsCalc.detectMovements(dayCheckins, particularMarkerMap, { maxMarkerGapMs });
        closedEvents
          .filter(ev => ev.category === 'PARTICULAR')
          .forEach(ev => particularExitByEmployeeDate.add(`${ev.employeeId}|${date}`));
        if (detailEmployeeId) {
          orphanReturns
            .filter(r => r.employeeId === detailEmployeeId)
            .forEach(r => {
              const hh = String(r.timeIn.getHours()).padStart(2, '0');
              const mm = String(r.timeIn.getMinutes()).padStart(2, '0');
              possibleJustificationByEmployeeDate.set(`${date}|${hh}:${mm}`, { markerTime: `${hh}:${mm}`, category: r.category });
            });
        }
      }
    }

    // Horas extra "reales" (marcadas con badges dedicados 9/10, categoria
    // HE en specialusers) -- PRIORIDAD 1 sobre el heuristico "clasico"
    // (computeDailyOvertime, 2do fichaje post-corte), igual jerarquia que
    // ya usaba js/app.js/index.html. Corre para TODO el rango (no solo en
    // modo detalle) porque afecta el resumen mensual de toda la empresa,
    // no solo el detalle de un empleado puntual. Reusa detectMovements
    // (mismo motor probado que Particular/Oficial/Campaña, con el mismo
    // resguardo de rebote y vencimiento de marcador) en vez de reimplementar
    // la deteccion aparte.
    const heIntervalsByEmployeeDate = new Map(); // `${employeeId}|${date}` -> {timeOut, timeIn}
    {
      const heMarkerMap = await fetchMarkerMap('HE', tenantId);
      if (Object.keys(heMarkerMap).length > 0) {
        const maxMarkerGapMs = await fetchMarkerMaxGapMs(tenantId);
        for (const [date, dayCheckins] of checkinsByDateForDetection.entries()) {
          const { closedEvents } = movementsCalc.detectMovements(dayCheckins, heMarkerMap, { maxMarkerGapMs });
          closedEvents
            .filter(ev => ev.category === 'HE')
            .forEach(ev => {
              heIntervalsByEmployeeDate.set(`${ev.employeeId}|${date}`, { timeOut: ev.timeOut, timeIn: ev.timeIn });
            });
        }
      }
    }

    const result = [];

    const overtimeSettings = await fetchOvertimeSettings(tenantId);
    const authModeValue = await getAppSetting('overtimeAuthorizationMode', tenantId, db);
    const overtimeAuthorizationMode = authModeValue || 'all';

    employees.forEach(u => {
      const employeeId = String(u.employeeId);
      // Turnos que cruzan medianoche ("sereno"): antes de calcular nada,
      // se corrigen los fichajes crudos de este empleado -- una marca de
      // madrugada que en realidad es la SALIDA del turno de ayer se saca
      // del dia de hoy (donde el reloj la registro) y se le suma al dia de
      // ayer (al que realmente pertenece). Sin esto, esa marca se toma
      // como si fuera la entrada de hoy, y una entrada de madrugada nunca
      // puede llegar tarde respecto de un turno que arranca de noche -- una
      // llegada tarde real quedaba invisible siempre (bug real, prueba de
      // estres pre-venta). El resto del calculo de mas abajo (entrada,
      // tardanza, dias trabajados) no cambia en nada -- sigue leyendo
      // "checksByDate[date]" exactamente igual que antes, ya con los
      // fichajes bien atribuidos.
      const getEmployeeScheduleForDate = (date) => {
        const dateSchedules = scheduleByDate[date];
        if (!dateSchedules) return null;
        return getScheduleEntry(date, dateSchedules.assignedScheduleMap, dateSchedules.tenantScheduleMap, employeeId, u.tenantId);
      };
      const checksByDate = attendanceCalc.reassignOvernightCheckins(
        checkinsByEmployee[employeeId] || {},
        getEmployeeScheduleForDate,
        [previousDayStr, ...dateRange, nextDayAfterRangeStr]
      );
      let daysWorked = 0;
      let absent = 0;
      let late = 0;
      let lateJustified = 0;
      let excused = 0;
      let partialAbsence = 0;
      let overtimeMinutes = 0;
      let personalLeaveMinutes = 0;
      let inactiveWarningDays = 0;
      const days = detailEmployeeId ? [] : null;
      // Pedido real: un empleado inactivo (baja no cargada formalmente) no
      // debe contarse ni mostrarse como "ausente" solo por no fichar -- ver
      // el mismo criterio aplicado en attendanceService.js (motor diario).
      const employeeActivo = u.activo === undefined || u.activo === null ? true : !!Number(u.activo);

      dateRange.forEach(date => {
        const dateSchedules = scheduleByDate[date];
        const schedule = getScheduleEntry(date, dateSchedules.assignedScheduleMap, dateSchedules.tenantScheduleMap, employeeId, u.tenantId);
        const checks = checksByDate[date] || [];
        // Feriado por ciudad (Fase 21): solo cuentan las filas de holidays
        // que aplican a ESTE empleado (toda la empresa, o su propia ciudad
        // -- ver holidayScope.js). Si varias aplican y alguna dice "no
        // laborable", esa gana (mas conservador que forzar a trabajar).
        const matchingHolidays = getHolidaysForDate(date).filter(h => holidayAppliesToEmployee(h, u.ciudadId));
        const holidayNonWorkApplies = matchingHolidays.some(h => isNonWorkHoliday(h));
        const holidayForcesWork = matchingHolidays.length > 0 && !holidayNonWorkApplies;
        const isWorkDay = matchingHolidays.length > 0 ? holidayForcesWork : schedule.isWorkDay == 1;

        if (!isWorkDay && !holidayNonWorkApplies) {
          // Dia libre normal segun el horario del empleado (fin de semana,
          // etc, SIN feriado de por medio) -- identico a como era antes.
          // Una HE manual puede cargarse para un dia no laborable (trabajo
          // en un fin de semana, por ejemplo) -- se respeta igual, no se
          // pierde solo porque el dia no era de horario normal.
          const manualKeyNonWork = u.USERID ? `${u.USERID}_${date}` : null;
          const manualMinutesNonWork = manualKeyNonWork ? (manualMinutesByUserDate.get(manualKeyNonWork) || 0) : 0;
          if (manualMinutesNonWork > 0) overtimeMinutes += manualMinutesNonWork;
          if (days) {
            // Bug real reportado: un fin de semana DENTRO de unas vacaciones
            // (ej. 05/01 a 27/01, un sabado/domingo en el medio) volvia
            // 'NonWorkDay' a secas -- en el calendario se veia como un
            // "agujero" gris en medio del bloque de vacaciones, porque este
            // return temprano nunca llegaba a mirar leaveEventMap (esa
            // consulta esta un poco mas abajo, solo para el caso
            // isWorkDay). El status/conteo NO cambia (ese dia sigue sin
            // costarle nada a la empresa, no se suma a "excused" ni a
            // ningun otro contador) -- solo se le agrega el motivo de la
            // licencia si corresponde, para que Presentismo lo pueda pintar
            // como parte del mismo bloque en vez de un no-laborable suelto.
            const leaveEventNonWork = leaveEventMap.get(`${employeeId}_${date}`);
            days.push({
              date,
              status: 'NonWorkDay',
              overtimeManualMinutes: manualMinutesNonWork,
              eventTypeCode: leaveEventNonWork ? (leaveEventNonWork.eventTypeCode || null) : undefined,
              eventTypeDescripcion: leaveEventNonWork ? (leaveEventNonWork.eventTypeDescripcion || null) : undefined,
              hasParticularExit: particularExitByEmployeeDate.has(`${employeeId}|${date}`),
            });
          }
          return;
        }

        if (holidayNonWorkApplies) {
          // Bug real (Fase 21): un feriado que aplicaba a este empleado
          // caia siempre en "NonWorkDay" generico -- el calendario
          // mensual/anual nunca distinguia "trabajo el feriado" de "no fue",
          // a diferencia del motor diario (que ya usa WorkedHoliday/
          // HolidayAbsent). Los CONTADORES numericos (daysWorked, late,
          // overtimeMinutes calculado, absent) siguen exactamente igual que
          // antes para un feriado -- solo cuenta la HE manual, igual que ya
          // pasaba -- esto corrige unicamente lo que se PINTA en el
          // calendario de detalle.
          const manualKeyHoliday = u.USERID ? `${u.USERID}_${date}` : null;
          const manualMinutesHoliday = manualKeyHoliday ? (manualMinutesByUserDate.get(manualKeyHoliday) || 0) : 0;
          if (manualMinutesHoliday > 0) overtimeMinutes += manualMinutesHoliday;
          if (days) {
            days.push({
              date,
              status: checks.length > 0 ? 'WorkedHoliday' : 'HolidayAbsent',
              firstCheckin: checks.length > 0 ? extractTime(checks[0]) : undefined,
              lastCheckin: checks.length > 0 ? extractTime(checks[checks.length - 1]) : undefined,
              totalCheckins: checks.length,
              overtimeManualMinutes: manualMinutesHoliday,
              hasParticularExit: particularExitByEmployeeDate.has(`${employeeId}|${date}`),
            });
          }
          return;
        }

        const exclusion = u.USERID ? exclusionsMap.get(`${u.USERID}_${date}`) : null;
        const leaveEvent = leaveEventMap.get(`${employeeId}_${date}`);

        if (checks.length > 0) {
          daysWorked++;
          if (!employeeActivo) inactiveWarningDays++;
          const first = checks[0];
          const last = checks[checks.length - 1];
          const firstMin = timeToMinutes(extractTime(first));
          const lastMin = timeToMinutes(extractTime(last));
          const entranceRef = attendanceCalc.getEntranceReference(schedule);
          const entranceMin = timeToMinutes(entranceRef);
          const tolerance = attendanceCalc.resolveToleranceMinutes(schedule);
          // Turno partido / visitas multiples (profesor, medico que va varias
          // veces por dia): solo cuando la plantilla tiene MAS de un bloque
          // WORK para este dia -- un solo bloque sigue exactamente igual que
          // siempre. Ver evaluateMultiVisitDay en attendanceCalculations.js.
          const workBlocks = (schedule.blocks || []).filter(b => b.block_type === 'WORK');
          const multiVisit = workBlocks.length > 1
            ? attendanceCalc.evaluateMultiVisitDay({
                workBlocks,
                checkinsSorted: checks,
                toleranceMinutes: tolerance,
                exclusion
              })
            : null;
          // Misma jerarquia que index.html/js/app.js: PRIORIDAD 1, badge
          // 9/10 real (heIntervalsByEmployeeDate, ya detectado arriba con
          // detectMovements) -- si ese dia no tiene marca real, PRIORIDAD 2,
          // el heuristico "clasico" (2do fichaje post-corte, unificado
          // 2026-08-07). Jerarquia extraida a overtimeCalculations.js
          // (resolveDailyOvertime) para poder testearla sin DB.
          const heInterval = heIntervalsByEmployeeDate.get(`${employeeId}|${date}`);
          const overtimeChecks = checks.map(c => new Date(String(c).replace(' ', 'T')));
          // Pedido real: "no todos tienen el mismo horario" -- el corte para
          // el heuristico clasico (Prioridad 2, sin marcador real ese dia) ya
          // no es un unico valor por empresa: se resuelve por la PLANTILLA de
          // este empleado ese dia (su propio "Corte HE" si lo tiene cargado,
          // si no el horario de salida de esa plantilla), y solo cae al
          // corte global configurado si ni siquiera se pudo resolver un
          // horario (ver resolveOvertimeCutoffMinutes).
          const effectiveCutoffMinutes = overtimeCalc.resolveOvertimeCutoffMinutes(schedule, overtimeSettings.cutoffMinutes);
          const effectiveCapMinutes = overtimeCalc.resolveOvertimeCapMinutes(schedule, overtimeSettings.capMinutes);
          const overtimeResult = overtimeCalc.resolveDailyOvertime(heInterval, overtimeChecks, {
            cutoffMinutes: effectiveCutoffMinutes,
            capMinutes: effectiveCapMinutes
          });
          // "Autorizado a hacer horas extras" (employees.overtime_authorized):
          // existia la columna desde hacia tiempo pero ningun motor la
          // aplicaba (confirmado al investigar antes de este cambio) -- un
          // empleado no autorizado puede seguir fichando despues de su
          // horario sin que eso le compute como HE automatica. Las entradas
          // MANUALES (ManualEntries) no se bloquean por esto: son una carga
          // explicita de un admin, no la deteccion automatica.
          const isOvertimeAuthorized = overtimeAuthorizationMode !== 'custom'
            ? true
            : (u.overtimeAuthorized === undefined || u.overtimeAuthorized === null ? true : !!Number(u.overtimeAuthorized));
          // Pedido real: "el tope es una opcion solo para que salte un aviso
          // en el detalle, superó límite diario" -- ANTES esto usaba
          // overtimeResult.cappedMinutes, que TRUNCABA el numero real (si
          // alguien hizo 8h de HE real y el tope configurado es 6h, se
          // mostraba y sumaba "6h" como si fuera el numero real, sin ningun
          // aviso de que se habia recortado). Ahora se usa el valor REAL
          // (.minutes) siempre, y overCap queda solo para mostrar un aviso
          // (ver dayOvertimeOverCap mas abajo) -- el tope deja de "mentir"
          // el numero y pasa a ser puramente informativo.
          // Etapa 14 (hallazgo #5 de la auditoria): el motor nuevo corre
          // para CUALQUIER plantilla en modo 'shadow' (informativo, Legacy
          // sigue siendo el oficial) o 'active' (su resultado PASA A SER
          // el oficial -- mismos nombres de campo de siempre, cambia solo
          // quien los calcula, ver Etapa 4 del plan). Si el motor tira un
          // error, se cae SIEMPRE al comportamiento Legacy para ese dia
          // puntual -- un bug del motor nuevo nunca debe romper ni dejar
          // sin calcular el resultado oficial de nadie.
          const runsNewEngine = engineModeActive && (schedule.rulesEngineMode === 'shadow' || schedule.rulesEngineMode === 'active');
          let engineResult = null;
          let engineHasCustomConfig = false;
          if (runsNewEngine) {
            try {
              const dow = scheduleRepository.getLocalDayOfWeek(date);
              const engineDayType = holidayForcesWork ? 'HOLIDAY' : (dow === 0 ? 'SUNDAY' : dow === 6 ? 'SATURDAY' : 'WORKDAY');
              // Etapa 14 (hallazgo #1): convenio vigente de ESTE empleado
              // en ESTA fecha (mismo criterio de vigencia que ya usa la
              // asignacion de plantilla, unas lineas mas arriba) -- null
              // si no tiene ninguno asignado (opt-in, sigue usando solo su
              // plantilla, comportamiento sin cambios).
              const employeeConventionRows = conventionAssignmentRowsByEmployee[u.internalEmployeeId] || [];
              const activeConventionAssignment = employeeConventionRows.find(
                (r) => r.valid_from <= date && (r.valid_to === null || r.valid_to >= date)
              );
              const activeConventionId = activeConventionAssignment ? activeConventionAssignment.convention_id : null;
              // Un candidato aplica si NO esta restringido a otro
              // tenant/plantilla/convenio -- null en cualquiera de los 3
              // significa "sin restriccion a ese nivel" (regla global en
              // ese aspecto), nunca "aplica a cualquiera". Bug real
              // encontrado al conectar convenios (hallazgo #1): el filtro
              // anterior solo miraba template_id, nunca tenant_id -- una
              // regla de OTRO tenant (template_id=null, tenant_id=6)
              // podia colarse en el calculo de un empleado de otro tenant
              // en un pedido cross-empresa (superadmin). Mismo patron de
              // fuga de tenant_id que ya tuvo bugs reales en este
              // proyecto (fases 19-21).
              const dayTypeRulesForTemplate = dayTypeRulesForEngine.filter((r) =>
                (r.tenant_id == null || r.tenant_id === u.tenantId)
                && (r.template_id == null || r.template_id === schedule.templateId)
                && (r.convention_id == null || r.convention_id === activeConventionId)
              );
              // Etapa 14 (hallazgo #3): la config de tolerancia que regia
              // ESE DIA, no la actual de la plantilla -- sin snapshots
              // (caso de hoy para toda plantilla que nunca cambio), esto
              // devuelve schedule.template tal cual, cero cambio.
              const historicalTemplateConfig = resolveHistoricalToleranceFields(
                templateConfigHistoryForEngine, schedule.templateId, date, schedule.template
              );
              let segmentsForEngine = scheduleSegmentsCache.get(schedule.blocks);
              if (!segmentsForEngine) {
                segmentsForEngine = resolveScheduleSegments(schedule.blocks);
                scheduleSegmentsCache.set(schedule.blocks, segmentsForEngine);
              }
              engineResult = computeAttendanceResult({
                segments: segmentsForEngine,
                checkins: checks.map((c) => timeToMinutes(extractTime(c))),
                toleranceConfig: resolveToleranceConfig(historicalTemplateConfig, tolerance),
                isOvertimeAuthorized,
                dayType: engineDayType,
                dayTypeRules: dayTypeRulesForTemplate
              });
              // hasCustomConfig: si esta plantilla/dia tiene tolerancias o
              // una regla de tipo de dia propias cargadas, una diferencia
              // (en modo shadow) es la funcionalidad nueva funcionando
              // como se pidio, no un bug -- ver shadowComparator.classifyDiff.
              engineHasCustomConfig = !!(historicalTemplateConfig && (
                historicalTemplateConfig.tolerancia_entrada_minutos != null
                || historicalTemplateConfig.tolerancia_salida_anticipada_minutos != null
                || historicalTemplateConfig.politica_llegada_anticipada != null
                || historicalTemplateConfig.politica_salida_posterior != null
              )) || dayTypeRulesForTemplate.some((r) => r.day_type === engineDayType);
            } catch (engineErr) {
              engineResult = null;
              console.error('Motor de reglas nuevo: error al calcular, se preserva el comportamiento Legacy para este dia:', engineErr);
            }
          }

          // Etapa 14 (hallazgo #5): en modo 'active', si el motor pudo
          // calcular sin errores, SU resultado pasa a ser el oficial para
          // este dia (si tiro un error, useEngineAsOfficial queda false y
          // se cae a Legacy -- nunca se rompe el calculo oficial).
          const useEngineAsOfficial = schedule.rulesEngineMode === 'active' && engineResult != null;

          const computedOvertimeMinutes = useEngineAsOfficial
            ? (engineResult.overtimeMinutes || 0)
            : ((overtimeResult && isOvertimeAuthorized) ? overtimeResult.minutes : 0);
          const dayOvertimeNeedsVerification = useEngineAsOfficial
            ? false // el motor nuevo clasifica por regla, no por heuristico -- nada que "verificar"
            : !!(overtimeResult && isOvertimeAuthorized && overtimeResult.needsVerification);
          const dayOvertimeSource = useEngineAsOfficial
            ? (computedOvertimeMinutes > 0 ? 'engine' : null)
            : ((overtimeResult && isOvertimeAuthorized) ? overtimeResult.source : null);

          // ManualEntries: 'omit' anula el computo automatico (un fichaje
          // que no corresponde a HE real); 'he'/'licencia' se suman aparte
          // -- no se pisan entre si, un dia puede tener las dos cosas.
          // Aplica igual sea Legacy o el motor nuevo el que calculo la
          // parte automatica -- son cargas humanas explicitas, fuera del
          // alcance de cualquiera de los dos.
          const manualKey = u.USERID ? `${u.USERID}_${date}` : null;
          const manualMinutesThisDay = manualKey ? (manualMinutesByUserDate.get(manualKey) || 0) : 0;
          const isManuallyOmitted = !!(manualKey && manualOmitByUserDate.has(manualKey));
          const omitEntryId = manualKey ? (manualOmitByUserDate.get(manualKey) || null) : null;
          const dayOvertimeMinutes = (isManuallyOmitted ? 0 : computedOvertimeMinutes) + manualMinutesThisDay;
          // Pedido real: "el tope es una opcion solo para que salte un aviso
          // en el detalle, superó límite diario" -- se compara el TOTAL final
          // del dia (automatico + manual, ya sin el omitido) contra el tope
          // configurado; no es solo la parte automatica, un manual que por si
          // solo supere el tope tambien tiene que avisar.
          const dayOvertimeOverCap = dayOvertimeMinutes > effectiveCapMinutes;
          // Hora exacta en la que arranca la HE automatica (marker,
          // fallback heuristico, o el motor nuevo) -- Fase 7, "Horas
          // Extra por Regimen" necesita mostrar entrada / inicio HE /
          // salida por dia, no solo la duracion.
          const dayOvertimeStartTime = (!isManuallyOmitted && computedOvertimeMinutes > 0)
            ? (useEngineAsOfficial ? engineOvertimeStartTimeLabel(engineResult) : (overtimeResult && isOvertimeAuthorized ? formatLocalTime(overtimeResult.start) : null))
            : null;

          let isLate; let lateMinutes; let lateJustifiedThisDay; let isPartialAbsence;
          if (useEngineAsOfficial) {
            const lateIncident = engineResult.incidents.find((i) => i.type === 'LATE_ARRIVAL');
            isLate = !!lateIncident;
            lateMinutes = lateIncident ? lateIncident.lateMinutes : 0;
            // Misma logica de justificacion que ya usa Legacy
            // (resolveLateJustification) -- una tardanza justificada por
            // una excepcion cargada sigue siendo valida sin importar que
            // motor detecto la tardanza.
            const excToMin = exclusion && exclusion.excTo ? timeToMinutes(exclusion.excTo) : null;
            lateJustifiedThisDay = isLate && !!exclusion && (excToMin === null || firstMin <= excToMin);
            isPartialAbsence = engineResult.incidents.some((i) => i.type === 'MISSING_ENTRANCE' || i.type === 'MISSING_EXIT');
          } else {
            ({ isLate, lateMinutes, justified: lateJustifiedThisDay } = multiVisit
              ? { isLate: multiVisit.isLate, lateMinutes: multiVisit.lateMinutes, justified: multiVisit.justified }
              : attendanceCalc.resolveLateJustification({
                  firstMinutes: firstMin,
                  entranceMinutes: entranceMin,
                  toleranceMinutes: tolerance,
                  exclusion
                }));
            isPartialAbsence = !!(multiVisit && multiVisit.isPartial);
          }

          if (isPartialAbsence) {
            partialAbsence++;
          } else if (isLate && lateJustifiedThisDay) {
            lateJustified++;
            personalLeaveMinutes += lateMinutes;
          } else if (isLate) {
            late++;
          }
          if (dayOvertimeMinutes > 0) overtimeMinutes += dayOvertimeMinutes;

          // Etapa 12: modo sombra -- SOLO informativo (Legacy sigue
          // siendo el oficial para esta plantilla): compara el resultado
          // Legacy (isLate/lateMinutes/isPartialAbsence/computedOvertimeMinutes
          // de arriba, que en modo shadow siguen siendo los de Legacy,
          // useEngineAsOfficial es false) contra el del motor nuevo.
          let shadowResult = null;
          // Etapa 14 (hallazgo #9/Auditoria): en modo 'active' no hay
          // "Legacy oficial" contra el cual comparar (dejo de serlo para
          // esta plantilla) -- se explica la decision del motor nuevo
          // igual, para poder responder "por que se clasifico asi".
          let engineExplanation = null;
          if (engineResult && schedule.rulesEngineMode === 'shadow') {
            try {
              // computedOvertimeMinutes (NO dayOvertimeMinutes): se compara
              // solo la deteccion AUTOMATICA -- el motor nuevo no conoce
              // ManualEntries (carga humana explicita, fuera de alcance).
              const legacyComparable = buildLegacyComparable({
                firstMinutes: firstMin,
                lastMinutes: lastMin,
                isLate,
                lateMinutes,
                isPartialAbsence,
                overtimeMinutes: computedOvertimeMinutes,
                visits: multiVisit ? multiVisit.visits : null
              });
              const diffs = compareAttendanceResults({ legacy: legacyComparable, engine: engineResult, hasCustomConfig: engineHasCustomConfig });
              shadowResult = {
                engine: {
                  workedMinutes: engineResult.workedMinutes,
                  normalMinutes: engineResult.normalMinutes,
                  overtimeMinutes: engineResult.overtimeMinutes,
                  unauthorizedMinutes: engineResult.unauthorizedMinutes,
                  incidents: engineResult.incidents,
                  classifiedSegments: engineResult.classifiedSegments
                },
                diffs
              };
              diffs.forEach((d) => {
                shadowDiffsToPersist.push({
                  tenantId: u.tenantId ?? null,
                  // employees.id (PK), NO el legajo -- mismo criterio que
                  // employee_convention_assignments.employee_id.
                  employeeId: u.internalEmployeeId,
                  date,
                  templateId: schedule.templateId ?? null,
                  field: d.field,
                  legacyValue: d.legacyValue,
                  newValue: d.newValue,
                  diffType: d.diffType
                });
              });
            } catch (shadowErr) {
              // No debe romper NUNCA el resultado oficial -- ver Etapa 12
              // del plan ("sin cambiar todavia el resultado oficial").
              console.error('Etapa 12 (modo sombra): error al comparar, no afecta el resultado oficial:', shadowErr);
            }
          } else if (engineResult && schedule.rulesEngineMode === 'active') {
            engineExplanation = {
              workedMinutes: engineResult.workedMinutes,
              normalMinutes: engineResult.normalMinutes,
              overtimeMinutes: engineResult.overtimeMinutes,
              unauthorizedMinutes: engineResult.unauthorizedMinutes,
              incidents: engineResult.incidents,
              classifiedSegments: engineResult.classifiedSegments,
              appliedRules: engineResult.appliedRules,
              ruleSetVersion: engineResult.ruleSetVersion
            };
          }

          if (days) {
            let status = 'OnTime';
            if (isPartialAbsence) status = 'PartialAbsence';
            else if (isLate) status = lateJustifiedThisDay ? 'LateJustified' : 'Late';
            const possibleJustification = isLate && !lateJustifiedThisDay
              ? possibleJustificationByEmployeeDate.get(`${date}|${extractTime(first)}`) || null
              : null;
            days.push({
              date,
              status,
              firstCheckin: extractTime(first),
              lastCheckin: extractTime(last),
              totalCheckins: checks.length,
              // Lista completa de fichajes del dia -- necesaria para poder
              // revisar un caso raro (ej. 4 marcas pero solo 5 minutos de
              // HE) sin tener que ir a buscarlo aparte. Mismo campo que ya
              // expone /api/labor-engine/attendance/:date (motor diario).
              checkins: checks.map(c => extractTime(c)),
              // Detalle por visita (entrada/salida de cada bloque WORK) solo
              // en dias de turno partido -- null en el caso normal.
              visits: multiVisit ? multiVisit.visits : null,
              overtimeMinutes: dayOvertimeMinutes,
              overtimeStartTime: dayOvertimeStartTime,
              overtimeNeedsVerification: dayOvertimeNeedsVerification,
              overtimeSource: dayOvertimeSource, // 'marker' (badge 9/10 real) | 'fallback' (heuristico) | null
              // Pedido real: "el tope es una opcion solo para que salte un
              // aviso en el detalle, superó límite diario" -- overtimeMinutes
              // de arriba SIEMPRE es el valor real (ya no se trunca), esto es
              // solo la bandera para mostrar el aviso cuando corresponda.
              overtimeOverCap: dayOvertimeOverCap,
              overtimeManualMinutes: manualMinutesThisDay,
              overtimeManuallyOmitted: isManuallyOmitted,
              // Pedido real: poder tildar/destildar "Omitido" directo desde
              // el detalle (sin abrir el dialogo de HE manual) -- hace falta
              // el id de la entrada 'omit' para poder borrarla al destildar.
              overtimeOmitEntryId: omitEntryId,
              // Pedido real: un empleado inactivo QUE FICHÓ es una señal real
              // a revisar (¿se reactivó sin avisar? ¿ficharon con su
              // credencial por error?) -- se mantiene el status normal
              // calculado arriba, solo se agrega el aviso.
              inactiveWarning: !employeeActivo,
              lateMinutes: isLate ? lateMinutes : 0,
              reason: isLate && lateJustifiedThisDay ? (exclusion.reason || null) : undefined,
              eventTypeCode: isLate && lateJustifiedThisDay ? (exclusion.eventTypeCode || null) : undefined,
              eventTypeDescripcion: isLate && lateJustifiedThisDay ? (exclusion.eventTypeDescripcion || null) : undefined,
              possibleJustification,
              hasParticularExit: particularExitByEmployeeDate.has(`${employeeId}|${date}`),
              // Etapa 12: solo presente cuando la plantilla de este dia
              // esta en modo 'shadow' -- el frontend actual lo ignora
              // (campo aditivo, nunca reemplaza nada de lo de arriba).
              shadowResult,
              // Etapa 14 (hallazgo #5/#9): solo presente en modo 'active'
              // -- status/overtimeMinutes/etc de arriba YA son el
              // resultado del motor nuevo; esto explica por que.
              engineExplanation,
            });
          }
        } else if (exclusion || leaveEvent) {
          excused++;
          // Una licencia manual (HE/Licencia) puede caer en un dia sin
          // fichajes -- no requiere marcar reloj, se suma igual.
          const manualKeyExcused = u.USERID ? `${u.USERID}_${date}` : null;
          const manualMinutesExcused = manualKeyExcused ? (manualMinutesByUserDate.get(manualKeyExcused) || 0) : 0;
          if (manualMinutesExcused > 0) overtimeMinutes += manualMinutesExcused;
          if (days) {
            days.push({
              date,
              status: 'Excused',
              reason: leaveEvent ? (leaveEvent.observaciones || null) : (exclusion.reason || null),
              eventTypeCode: leaveEvent ? (leaveEvent.eventTypeCode || null) : (exclusion.eventTypeCode || null),
              eventTypeDescripcion: leaveEvent ? (leaveEvent.eventTypeDescripcion || null) : (exclusion.eventTypeDescripcion || null),
              overtimeManualMinutes: manualMinutesExcused,
              hasParticularExit: particularExitByEmployeeDate.has(`${employeeId}|${date}`),
            });
          }
        } else if (!employeeActivo) {
          // Inactivo y SIN fichaje -- no corresponde contarlo como ausente
          // (ya no trabaja acá, no es una ausencia real a revisar). No suma
          // al contador "absent" ni al resumen -- pedido real.
          const manualKeyInactive = u.USERID ? `${u.USERID}_${date}` : null;
          const manualMinutesInactive = manualKeyInactive ? (manualMinutesByUserDate.get(manualKeyInactive) || 0) : 0;
          if (manualMinutesInactive > 0) overtimeMinutes += manualMinutesInactive;
          if (days) {
            days.push({ date, status: 'Inactive', overtimeManualMinutes: manualMinutesInactive, hasParticularExit: particularExitByEmployeeDate.has(`${employeeId}|${date}`) });
          }
        } else {
          absent++;
          const manualKeyAbsent = u.USERID ? `${u.USERID}_${date}` : null;
          const manualMinutesAbsent = manualKeyAbsent ? (manualMinutesByUserDate.get(manualKeyAbsent) || 0) : 0;
          if (manualMinutesAbsent > 0) overtimeMinutes += manualMinutesAbsent;
          if (days) {
            days.push({ date, status: 'Absent', overtimeManualMinutes: manualMinutesAbsent, hasParticularExit: particularExitByEmployeeDate.has(`${employeeId}|${date}`) });
          }
        }
      });

      // isOvertimeAuthorized se recalcula por dia dentro del forEach de
      // arriba (puede variar si el modo es 'custom' y el flag del empleado
      // cambio a mitad del rango, aunque en la practica es constante por
      // empleado) -- para el filtro "solo autorizados" del listado alcanza
      // con el mismo criterio que ya usa el modo 'all'/'custom' de arriba.
      const rowIsOvertimeAuthorized = overtimeAuthorizationMode !== 'custom'
        ? true
        : (u.overtimeAuthorized === undefined || u.overtimeAuthorized === null ? true : !!Number(u.overtimeAuthorized));

      const row = {
        userId: u.USERID,
        employeeId: u.employeeId,
        name: u.Name,
        badge: u.Badgenumber,
        daysWorked,
        absent,
        late,
        lateJustified,
        excused,
        partialAbsence,
        overtimeHours: (overtimeMinutes / 60).toFixed(2),
        personalLeaveHours: (personalLeaveMinutes / 60).toFixed(2),
        personalLeaveLimitHours: (personalLeaveLimitMinutesForRange / 60).toFixed(2),
        overLimitHours: (Math.max(0, personalLeaveMinutes - personalLeaveLimitMinutesForRange) / 60).toFixed(2),
        overtimeAuthorized: rowIsOvertimeAuthorized,
        // Pedido real: empleado inactivo (baja no cargada) que igual fichó
        // en el período -- señal real a revisar, visible en el listado
        // general sin tener que abrir el detalle día por día de cada uno.
        inactiveWarningDays
      };
      if (days) {
        row.days = days;
      }
      result.push(row);
    });

    // Etapa 12: persistir las diferencias encontradas (si hubo alguna) en
    // un solo lote -- best-effort, un error aca NUNCA debe tumbar la
    // respuesta oficial de /attendance-range (ver Etapa 12 del plan: "sin
    // cambiar todavia el resultado oficial"). No se inserta nada cuando
    // shadowDiffsToPersist esta vacio (ni modo sombra activo, ni diferencias).
    //
    // Etapa 14 (hallazgo #6 de la auditoria): ON DUPLICATE KEY UPDATE en
    // vez de un INSERT liso -- sin esto, cada refresco de Presentismo (o
    // varios admins mirando el mismo periodo) insertaba una fila NUEVA
    // aunque la diferencia ya estuviera registrada. La clave unica
    // (employee_id, date, field, template_id) viene de la migracion
    // 20260926 -- la misma diferencia se ACTUALIZA (created_at incluido,
    // para saber cuando se vio por ultima vez), no se acumula.
    if (shadowDiffsToPersist.length > 0) {
      try {
        const values = shadowDiffsToPersist.map((d) => [
          d.tenantId, d.employeeId, d.date, d.templateId, d.field,
          JSON.stringify(d.legacyValue), JSON.stringify(d.newValue), d.diffType
        ]);
        await db.query(
          `INSERT INTO rule_engine_shadow_diffs
             (tenant_id, employee_id, date, template_id, field, legacy_value, new_value, diff_type)
           VALUES ?
           ON DUPLICATE KEY UPDATE
             tenant_id = VALUES(tenant_id),
             legacy_value = VALUES(legacy_value),
             new_value = VALUES(new_value),
             diff_type = VALUES(diff_type),
             created_at = CURRENT_TIMESTAMP`,
          [values]
        );
      } catch (shadowPersistErr) {
        console.error('Etapa 12 (modo sombra): error al guardar diferencias, no afecta el resultado oficial:', shadowPersistErr);
      }
    }

    res.json({
      from,
      to,
      // Pedido real: el frontend necesita mostrar "Superó el límite diario
      // (Xh Ym)" en el aviso de overtimeOverCap sin tener que pedir
      // /config/overtime-settings aparte.
      overtimeCapMinutes: overtimeSettings.capMinutes,
      data: result
    });

  } catch (err) {
    console.error(err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Error en rango' });
  }
});

//fin get rango de fechas


// 5. REPORTE DE SALIDAS (Particular / Oficial / Campaña), detectadas a partir
// de los usuarios ficticios (specialusers). Reemplaza al viejo /movements/:date
// -- ese filtraba por category SALIDA/RETORNO, valores que nunca se cargan
// (las categorías reales son PARTICULAR/OFICIAL/CAMPANA con su propia columna
// `direction`), y emparejaba el regreso con la fila siguiente en TODO el
// listado de la empresa en vez del próximo fichaje de ese mismo empleado.
// La lógica de detección vive en motor-laboral/services/movementsCalculations.js
// (compartida entre este endpoint y /campana-range) para no duplicarla.

async function fetchMovementCheckins(fromDate, toDateExclusive, tenantId) {
  // El join por badge (ademas de por USERID) es necesario porque no todos
  // los relojes graban Checkins.USERID igual: algunos graban el USERID
  // interno, otros graban directamente el numero de legajo/badge -- mismo
  // fallback que ya usa /attendance-range. Sin esto, los fichajes de
  // cualquier empleado cuyo reloj haga esto quedan invisibles para el motor
  // de salidas (se tratan como ruido) aunque sí se calculen bien las horas
  // normales -- caso real: PERROTTA Valentina, legajo 1011, 07/07/2026.
  //
  // Fase 19: tenant_id en cada JOIN (users/Checkins/user_employee_map ya
  // no son unicos solo por USERID, migracion 20260909) -- el filtrado
  // final por employeeById.has(...) en /movements-range ya evitaba que
  // esto se viera en la respuesta, pero un legajo coincidente entre dos
  // empresas (ej. las dos usan "1000") podia igual atribuirle mal un
  // movimiento a la empresa equivocada antes de llegar a esta version.
  const params = [fromDate, toDateExclusive];
  let query = `
    SELECT c.CHECKTIME AS checktime, c.USERID AS rawUserId, e.employee_id AS employeeId
    FROM Checkins c
    LEFT JOIN users u
      ON (u.USERID = c.USERID OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR))
      AND u.tenant_id = c.tenant_id
    LEFT JOIN user_employee_map uem ON uem.USERID = u.USERID AND uem.tenant_id = u.tenant_id
    LEFT JOIN employees e ON e.id = uem.employee_id
    WHERE c.CHECKTIME >= ? AND c.CHECKTIME < ?`;
  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND c.tenant_id = ?`;
    params.push(tenantId);
  }
  query += ` ORDER BY c.CHECKTIME`;
  const [rows] = await db.query(query, params);
  return rows.map(r => ({
    // db.js usa dateStrings:true -- CHECKTIME llega como 'YYYY-MM-DD HH:MM:SS',
    // no como Date. El motor de detección compara/formatea fechas, así que se
    // parsea acá, en el único lugar que toca la fila cruda de la DB.
    checktime: new Date(r.checktime.replace(' ', 'T')),
    userId: r.rawUserId,
    employeeId: r.employeeId !== null ? String(r.employeeId) : null
  }));
}

async function fetchMarkerMap(category, tenantId) {
  const params = [];
  let query = `SELECT userId, category, direction, badgeNumber FROM specialusers WHERE isActive = TRUE AND direction IS NOT NULL`;
  if (category) {
    query += ` AND category = ?`;
    params.push(category);
  }
  // Fase 19: sin esto, el mapa de marcadores (badge 9/10) de OTRA empresa
  // se mezclaba con el propio -- un USERID de marcador coincidente entre
  // dos empresas hubiera abierto/cerrado eventos con el criterio equivocado.
  if (tenantId !== undefined && tenantId !== null) {
    query += ` AND tenant_id = ?`;
    params.push(tenantId);
  }
  const [rows] = await db.query(query, params);
  const markerMap = {};
  rows.forEach(m => { markerMap[m.userId] = { category: m.category, direction: m.direction, badgeNumber: m.badgeNumber }; });
  return markerMap;
}

// GET /movements-range?from=&to=&category=PARTICULAR|OFICIAL&employeeId=&groupBy=day|month|year
app.get('/movements-range', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const category = req.query.category;
    if (!from || !to) {
      return res.status(400).json({ error: 'from y to requeridos' });
    }
    if (!['PARTICULAR', 'OFICIAL'].includes(category)) {
      return res.status(400).json({ error: "category debe ser 'PARTICULAR' u 'OFICIAL'" });
    }
    const groupBy = ['day', 'month', 'year'].includes(req.query.groupBy) ? req.query.groupBy : 'day';
    const employeeIdFilter = req.query.employeeId ? String(req.query.employeeId) : null;

    const tenantId = resolveTenantId(req);
    let employees = await userRepository.findAll({ tenantId }, db);
    if (employeeIdFilter) {
      employees = employees.filter(e => String(e.employeeId) === employeeIdFilter);
    }
    const employeeById = new Map(employees.map(e => [String(e.employeeId), e]));

    const markerMap = await fetchMarkerMap(category, tenantId);
    const exclusiveEnd = nextDayStr(to);
    const checkins = await fetchMovementCheckins(from, exclusiveEnd, tenantId);

    // Particular/Oficial son "del día": una salida sin regreso se cierra al
    // fin de ESE horario, nunca con un fichaje de un día distinto. Por eso la
    // detección corre por día (no sobre todo el rango de una), agrupando los
    // fichajes por fecha local -- si esto corriera sobre el rango entero, una
    // salida sin regreso el 3 quedaba "abierta" hasta el próximo fichaje
    // cualquiera de ese empleado, aunque fuera del día 6 (bug real, visto con
    // datos de julio 2026: daba 65hs de "salida particular").
    const maxMarkerGapMs = await fetchMarkerMaxGapMs(tenantId);
    const checkinsByDate = new Map();
    checkins.forEach(c => {
      const dateStr = formatLocalDate(c.checktime);
      if (!checkinsByDate.has(dateStr)) checkinsByDate.set(dateStr, []);
      checkinsByDate.get(dateStr).push(c);
    });

    const allEvents = [];
    for (const [dateStr, dayCheckins] of checkinsByDate.entries()) {
      const { closedEvents, openEvents, orphanReturns } = movementsCalc.detectMovements(dayCheckins, markerMap, { maxMarkerGapMs });
      // Bug real: AVILA Natalia, legajo 9006, abril 2026 -- una llegada
      // tarde quedaba marcada como "Salida Particular" de 6h+ porque el
      // marcador de Salida lo fichó otra persona justo antes de que Natalia
      // marcara su propia entrada de la mañana (ver isFirstRealCheckinOfDay
      // en movementsCalculations.js). Se filtran acá, antes de sumar a la
      // respuesta -- ni closedEvents ni lo que sale de
      // closeOpenEventsAtScheduleExit (mismo problema, solo que sigue
      // "abierta" hasta que la cierra el horario de salida en vez de un
      // fichaje real).
      allEvents.push(
        ...movementsCalc.filterEventsOpenedByFirstCheckinOfDay(closedEvents, dayCheckins).map(e => ({ ...e, hasReturn: true }))
      );

      if (openEvents.size > 0) {
        const exitTimeByEmployeeId = new Map();
        for (const [employeeId, ev] of openEvents.entries()) {
          const emp = employeeById.get(employeeId);
          const schedRows = await scheduleRepository.findByDate(dateStr, emp ? emp.tenantId : tenantId, db);
          const sched = Array.isArray(schedRows) ? schedRows[0] : schedRows;
          const exitTimeStr = (sched && sched.timeExit) || '13:40:00';
          const [h, m] = exitTimeStr.split(':').map(Number);
          exitTimeByEmployeeId.set(employeeId, new Date(ev.timeOut.getFullYear(), ev.timeOut.getMonth(), ev.timeOut.getDate(), h, m, 0));
        }
        const closedAtScheduleExit = movementsCalc.closeOpenEventsAtScheduleExit(openEvents, exitTimeByEmployeeId);
        allEvents.push(...movementsCalc.filterEventsOpenedByFirstCheckinOfDay(closedAtScheduleExit, dayCheckins));
      }

      // "Entrada particular": un regreso huérfano (marcador REGRESO antes del
      // primer fichaje del día, sin salida abierta ese día -- ver
      // orphanReturns) también es una salida particular, solo que nunca se
      // ficho su "salida" porque se autorizó el día anterior. Se sintetiza
      // el horario de entrada programado como punto de partida (mismo
      // criterio que ya usa /attendance-range para sugerir la justificación).
      const relevantOrphans = orphanReturns.filter(r => r.category === category);
      if (relevantOrphans.length > 0) {
        const entranceTimeByEmployeeId = new Map();
        for (const r of relevantOrphans) {
          if (entranceTimeByEmployeeId.has(r.employeeId)) continue;
          const emp = employeeById.get(r.employeeId);
          const schedRows = await scheduleRepository.findByDate(dateStr, emp ? emp.tenantId : tenantId, db);
          const sched = Array.isArray(schedRows) ? schedRows[0] : schedRows;
          const entranceTimeStr = (sched && attendanceCalc.getEntranceReference(sched)) || '07:00:00';
          const [h, m] = entranceTimeStr.split(':').map(Number);
          entranceTimeByEmployeeId.set(r.employeeId, new Date(r.timeIn.getFullYear(), r.timeIn.getMonth(), r.timeIn.getDate(), h, m, 0));
        }
        allEvents.push(...movementsCalc.openOrphanReturnsAtScheduleEntrance(relevantOrphans, entranceTimeByEmployeeId));
      }
    }

    const filteredEvents = allEvents.filter(e => e.category === category && employeeById.has(e.employeeId));

    const periodKey = (dateStr) => {
      if (groupBy === 'year') return dateStr.slice(0, 4);
      if (groupBy === 'month') return dateStr.slice(0, 7);
      return dateStr;
    };

    // Pedido real: "que se agreguen dos columnas antes de salida el
    // marcador si lo hubo... y antes de regreso también" -- para poder
    // detectar/corregir una atribucion erronea (caso real: AVILA Natalia
    // 08/04/2026, su propia entrada se tomo como Salida por un marcador
    // ajeno). salidaMarkerUserId/regresoMarkerUserId ya vienen de
    // detectMovements -- solo hace falta resolverlos al numero de badge
    // (mismo markerMap ya cargado arriba, no hace falta otra consulta).
    const badgeByMarkerUserId = (userId) => (userId != null && markerMap[userId]) ? markerMap[userId].badgeNumber : null;

    const rows = [];
    const summaryMap = new Map();
    filteredEvents.forEach(e => {
      const emp = employeeById.get(e.employeeId);
      // e.timeOut puede venir null (ver openOrphanReturnsAtScheduleEntrance
      // -- se descarta la salida sintetizada si quedaria despues del regreso
      // real). Si no hay salida, la fecha de la fila se toma del regreso
      // real (e.timeIn), que siempre existe para un evento cerrado.
      const dateStr = formatLocalDate(e.timeOut || e.timeIn);
      // `e.timeIn - null` en JS NO da NaN, coerciona null a 0 y da un
      // numero gigante sin sentido -- hay que chequear timeOut tambien.
      const durationMinutes = (e.timeIn && e.timeOut) ? Math.round((e.timeIn - e.timeOut) / 60000) : null;

      rows.push({
        date: dateStr,
        employeeId: e.employeeId,
        employeeName: emp.Name,
        badge: emp.Badgenumber,
        category: e.category,
        salidaMarkerBadge: badgeByMarkerUserId(e.salidaMarkerUserId),
        timeOut: formatLocalDateTime(e.timeOut),
        regresoMarkerBadge: badgeByMarkerUserId(e.regresoMarkerUserId),
        timeIn: formatLocalDateTime(e.timeIn),
        hasReturn: e.hasReturn,
        durationMinutes
      });

      const key = `${e.employeeId}|${periodKey(dateStr)}`;
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          employeeId: e.employeeId,
          employeeName: emp.Name,
          badge: emp.Badgenumber,
          period: periodKey(dateStr),
          count: 0,
          totalMinutes: 0,
          openCount: 0
        });
      }
      const s = summaryMap.get(key);
      s.count += 1;
      if (durationMinutes !== null) s.totalMinutes += durationMinutes;
      if (!e.hasReturn) s.openCount += 1;
    });

    // Tope mensual de horas de salidas particulares -- nuevo (Fase 6.4), no
    // existia en el sistema viejo (el limite que decia "salida particular"
    // en dashboard.html en realidad solo cubria llegadas tarde justificadas,
    // ver personalLeaveMonthlyLimitMinutes). 0 = sin tope configurado.
    let particularExitLimitMinutes = 0;
    if (category === 'PARTICULAR') {
      const limitValue = await getAppSetting('particularExitMonthlyLimitMinutes', tenantId, db);
      particularExitLimitMinutes = limitValue ? Number(limitValue) : 0;
    }
    const summary = Array.from(summaryMap.values()).map(s => ({
      ...s,
      limitMinutes: particularExitLimitMinutes,
      overLimit: particularExitLimitMinutes > 0 && s.totalMinutes > particularExitLimitMinutes
    }));

    res.json({ from, to, category, groupBy, rows, summary });
  } catch (err) {
    console.error('ERROR fetching movements-range:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Error en movements-range' });
  }
});

// GET /campana-range?from=&to=&employeeId= -- a diferencia de Particular/Oficial,
// una salida a Campaña puede durar varios días: no se cierra al fin del día,
// y la "cantidad de días" se calcula con un horario de corte configurable.
app.get('/campana-range', requirePermission('attendance', 'read'), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from y to requeridos' });
    }
    const employeeIdFilter = req.query.employeeId ? String(req.query.employeeId) : null;

    const tenantId = resolveTenantId(req);
    let employees = await userRepository.findAll({ tenantId }, db);
    if (employeeIdFilter) {
      employees = employees.filter(e => String(e.employeeId) === employeeIdFilter);
    }
    const employeeById = new Map(employees.map(e => [String(e.employeeId), e]));

    const markerMap = await fetchMarkerMap('CAMPANA', tenantId);

    // Una salida a campaña puede haber arrancado antes del "from" pedido --
    // se busca hasta CAMPANA_LOOKBACK_DAYS atrás para no perder el
    // emparejamiento con su regreso, que sí puede caer dentro del rango.
    const CAMPANA_LOOKBACK_DAYS = 90;
    const [fy, fm, fd] = from.split('-').map(Number);
    const lookbackFromDate = new Date(fy, fm - 1, fd - CAMPANA_LOOKBACK_DAYS);
    const lookbackFromStr = formatLocalDate(lookbackFromDate);
    const exclusiveEnd = nextDayStr(to);

    const checkins = await fetchMovementCheckins(lookbackFromStr, exclusiveEnd, tenantId);
    const maxMarkerGapMs = await fetchMarkerMaxGapMs(tenantId);
    const { closedEvents, openEvents } = movementsCalc.detectMovements(checkins, markerMap, { maxMarkerGapMs });

    const cutoffValue = await getAppSetting('campanaArrivalCutoffTime', tenantId, db);
    const cutoffTime = cutoffValue || '09:00';
    const fromDate = new Date(fy, fm - 1, fd);

    const events = [
      ...closedEvents.filter(e => e.timeIn >= fromDate).map(e => ({ ...e, hasReturn: true })),
      ...Array.from(openEvents.entries()).map(([employeeId, ev]) => ({
        employeeId, category: ev.category, timeOut: ev.timeOut, timeIn: null, hasReturn: false
      }))
    ].filter(e => e.category === 'CAMPANA' && employeeById.has(e.employeeId));

    const rows = events.map(e => {
      const emp = employeeById.get(e.employeeId);
      const dias = movementsCalc.computeCampanaDias(e.timeOut, e.timeIn, cutoffTime);
      return {
        employeeId: e.employeeId,
        employeeName: emp.Name,
        badge: emp.Badgenumber,
        timeOut: formatLocalDateTime(e.timeOut),
        timeIn: formatLocalDateTime(e.timeIn),
        hasReturn: e.hasReturn,
        dias
      };
    });

    res.json({ from, to, cutoffTime, rows });
  } catch (err) {
    console.error('ERROR fetching campana-range:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
      });
    }
    res.status(500).json({ error: 'Error en campana-range' });
  }
});

// GET/POST /config/campana-cutoff -- horario de corte para computar "cantidad
// de días" de una salida a Campaña (mismo patrón que /config/personal-leave-limit).
app.get('/config/campana-cutoff', requirePermission('schedules', 'read'), async (req, res) => {
  try {
    const value = await getAppSetting('campanaArrivalCutoffTime', resolveTenantId(req), db);
    res.json({ campanaArrivalCutoffTime: value || '09:00' });
  } catch (err) {
    console.error('ERROR fetching campana cutoff:', err);
    res.status(500).json({ error: 'Error fetching campana cutoff' });
  }
});

app.post('/config/campana-cutoff', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const value = String(req.body.campanaArrivalCutoffTime || '');
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
      return res.status(400).json({ error: 'campanaArrivalCutoffTime debe tener formato HH:MM' });
    }
    await setAppSetting('campanaArrivalCutoffTime', resolveTenantId(req), value, db);
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving campana cutoff:', err);
    res.status(500).json({ error: 'Error saving campana cutoff' });
  }
});

// GET/POST /config/marker-max-gap-seconds -- cuánto tiempo, como máximo,
// queda "vivo" un marcador (badge 3-8) esperando el fichaje real que lo
// consume. Sin esto, un marcador que nadie consumió enseguida (para otro
// empleado, o porque lo dejó fichado sin volver) podía terminar
// atribuyéndosele a cualquiera que fichara minutos después por un motivo
// no relacionado -- caso real: Perrotta 02/07/2026.
async function fetchMarkerMaxGapMs(tenantId) {
  const value = await getAppSetting('markerMaxGapSeconds', tenantId, db);
  const seconds = value ? Number(value) : 30;
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
}

app.get('/config/marker-max-gap-seconds', requirePermission('schedules', 'read'), async (req, res) => {
  try {
    const value = await getAppSetting('markerMaxGapSeconds', resolveTenantId(req), db);
    res.json({ markerMaxGapSeconds: value ? Number(value) : 30 });
  } catch (err) {
    console.error('ERROR fetching marker max gap:', err);
    res.status(500).json({ error: 'Error fetching marker max gap' });
  }
});

app.post('/config/marker-max-gap-seconds', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const seconds = Number(req.body.markerMaxGapSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
      return res.status(400).json({ error: 'markerMaxGapSeconds debe ser un número entre 1 y 3600' });
    }
    await setAppSetting('markerMaxGapSeconds', resolveTenantId(req), String(seconds), db);
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving marker max gap:', err);
    res.status(500).json({ error: 'Error saving marker max gap' });
  }
});

// GET/POST /config/overtime-settings -- hora de corte y tope diario para la
// regla "clasica" de horas extra (2do fichaje post-corte -> ultimo fichaje,
// topeado), unificada 2026-08-07 entre index.html (donde ya vivia, fija a
// 13:40/360min) y /attendance-range (que antes usaba una heuristica propia,
// distinta y sin tope -- ver overtimeCalculations.js para la regla completa).
async function fetchOvertimeSettings(tenantId) {
  const [cutoffTime, capMinutesRaw] = await Promise.all([
    getAppSetting('overtimeCutoffTime', tenantId, db),
    getAppSetting('overtimeCapMinutes', tenantId, db)
  ]);
  const resolvedCutoff = cutoffTime || '13:40';
  const [cutH, cutM] = resolvedCutoff.split(':').map(Number);
  const capMinutes = capMinutesRaw ? Number(capMinutesRaw) : overtimeCalc.DEFAULT_CAP_MINUTES;
  return {
    cutoffTime: resolvedCutoff,
    cutoffMinutes: (Number.isFinite(cutH) ? cutH : 13) * 60 + (Number.isFinite(cutM) ? cutM : 40),
    capMinutes: Number.isFinite(capMinutes) && capMinutes > 0 ? capMinutes : overtimeCalc.DEFAULT_CAP_MINUTES
  };
}

app.get('/config/overtime-settings', requirePermission('schedules', 'read'), async (req, res) => {
  try {
    const settings = await fetchOvertimeSettings(resolveTenantId(req));
    res.json({ overtimeCutoffTime: settings.cutoffTime, overtimeCapMinutes: settings.capMinutes });
  } catch (err) {
    console.error('ERROR fetching overtime settings:', err);
    res.status(500).json({ error: 'Error fetching overtime settings' });
  }
});

app.post('/config/overtime-settings', requirePermission('schedules', 'update'), async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const { overtimeCutoffTime, overtimeCapMinutes } = req.body;
    if (overtimeCutoffTime !== undefined) {
      if (!/^\d{1,2}:\d{2}$/.test(overtimeCutoffTime)) {
        return res.status(400).json({ error: 'overtimeCutoffTime debe tener formato HH:MM' });
      }
      await setAppSetting('overtimeCutoffTime', tenantId, overtimeCutoffTime, db);
    }
    if (overtimeCapMinutes !== undefined) {
      const cap = Number(overtimeCapMinutes);
      if (!Number.isFinite(cap) || cap <= 0 || cap > 1440) {
        return res.status(400).json({ error: 'overtimeCapMinutes debe ser un número entre 1 y 1440' });
      }
      await setAppSetting('overtimeCapMinutes', tenantId, String(cap), db);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR saving overtime settings:', err);
    res.status(500).json({ error: 'Error saving overtime settings' });
  }
});


/* ===============================
   MANEJO DE ERRORES GLOBAL
================================ */
// Sin esto, un archivo mas grande que el limite de multer (ver `upload`
// arriba) tiraba el error handler por defecto de Express (HTML, no JSON,
// y el stack podia terminar expuesto) en vez de una respuesta prolija.
// Va al final, despues de todas las rutas, como pide Express para un
// error handler (4 argumentos).
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'El archivo supera el tamaño máximo permitido (20MB).'
      : 'Error al procesar el archivo subido.';
    return res.status(413).json({ error: message });
  }
  console.error('[UNHANDLED ERROR]:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

/* ===============================
   START
================================ */
const PORT = process.env.PORT || 3000;

console.log('🚀 Iniciando servidor...');
console.log('📡 Puerto configurado:', PORT);

app.listen(PORT, () => {
  console.log('✅ Backend escuchando en puerto', PORT);
  console.log('🌐 Servidor listo para recibir conexiones en http://localhost:' + PORT);
  console.log('📊 Endpoints disponibles:');
  console.log('   - /api/employees - Gestión de empleados');
  console.log('   - /api/import - Importación de datos');
  console.log('   - /api/matching - Matching usuario-empleado');
});

// Manejar errores no capturados para evitar que el servidor se cierre
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});