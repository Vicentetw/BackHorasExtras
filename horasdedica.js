//require('dotenv').config();
// quitar require('dotenv') si no usas .env local, y configurar variables de entorno en tu hosting
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { parse } = require('csv-parse/sync');
const { securityMiddlewares, apiKeyWarning } = require('./security');
const importRoutes = require('./routes/import.routes');
const matchingRoutes = require('./routes/matching.routes');
const employeesRoutes = require('./routes/employees');
const holidaysRoutes = require('./routes/holidays');

const app = express();
app.use(express.json({ limit: '1mb' }));
securityMiddlewares(app, cors);
apiKeyWarning();

// Middleware para loguear todas las requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
//Importación de rutas de matching e importación de datos

app.use('/api/import', importRoutes);
app.use('/api/matching', matchingRoutes);
app.use('/api/employees', employeesRoutes);

const upload = multer({ storage: multer.memoryStorage() });

/* ===============================
   MySQL – Clever Cloud
================================ */
const db = mysql.createPool({
  host: process.env.MYSQL_ADDON_HOST,
  user: process.env.MYSQL_ADDON_USER,
  password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB,
  port: process.env.MYSQL_ADDON_PORT || 3306,
  waitForConnections: true,
  dateStrings: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Registrar holidays después de db
app.use('/api/holidays', holidaysRoutes(db));

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

// Función para parsear fechas de checkins sin convertir a UTC
function parseCheckTimeArgentina(value) {
  if (!value) return null;
  const v = value.trim();
  // DD/MM/YYYY HH:mm[:ss]
  if (v.match(/^\d{1,2}\/\d{1,2}\/\d{4} \d{2}:\d{2}(?::\d{2})?$/)) {
    const [date, time] = v.split(' ');
    const [dd, mm, yyyy] = date.split('/');
    const t = time.length === 5 ? `${time}:00` : time;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')} ${t}`;
  }
  // YYYY-MM-DD HH:mm[:ss]
  if (v.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/)) {
    const [date, time] = v.split(' ');
    const t = time.length === 5 ? `${time}:00` : time;
    return `${date} ${t}`;
  }
  // Si no matchea, loguea para revisión
  console.warn('Formato de CHECKTIME no reconocido:', value);
  return null;
}

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

// Endpoint para agregar horas extras manuales o licencias
app.post('/add/manual', async (req, res) => {
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

    const [result] = await db.query(
      `INSERT INTO ManualEntries
       (userId, startDatetime, endDatetime, durationMinutes, type, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        Number(userId),
        start,
        end,
        Math.round(durationMinutes),
        type,
        note || null
      ]
    );

    res.json({
      ok: true,
      message: 'Registro manual guardado correctamente',
      id: result.insertId
    });

  } catch (err) {
    console.error('ADD MANUAL ERROR:', err);
    res.status(500).json({
      error: 'Error interno al guardar registro manual'
    });
  }
});

/* ===============================
   DELETE MANUAL ENTRY, ONLY MANUAL
================================ */
app.delete('/delete/manual/:id', async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    const [result] = await db.query(
      `DELETE FROM ManualEntries WHERE id = ?`,
      [Number(id)]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Registro manual no encontrado' });
    }

    res.json({ ok: true, deletedId: id });

  } catch (err) {
    console.error('DELETE MANUAL ERROR:', err);
    res.status(500).json({ error: 'Error al borrar registro manual' });
  }
});

/* ===============================
   IMPORT CHECKINS
================================ */
app.post('/import/checkins', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Archivo CSV requerido' });
    }

    const csv = req.file.buffer.toString('utf8');
    const records = parse(csv, {
      columns: true,
      delimiter: ';',
      skip_empty_lines: true,
      trim: true
    });

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    const batchSize = 50;
    let batch = [];

    for (const r of records) {
      // Limpiar espacios y caracteres invisibles
      const userIdClean = r.USERID ? r.USERID.toString().replace(/\s+/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '') : '';
      const checktimeRaw = r.CHECKTIME ? r.CHECKTIME.toString().replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : '';

      if (!userIdClean || !checktimeRaw) {
        skipped++;
        console.warn('Registro saltado por campos vacíos:', r);
        continue;
      }

      const checktime = parseCheckTimeArgentina(checktimeRaw);
      if (!checktime) {
        skipped++;
        errors++;
        console.warn('Parseo fallido CHECKTIME:', checktimeRaw, 'USERID:', userIdClean);
        continue;
      }

      const machine_ip = r.MACHINE_IP ? r.MACHINE_IP.toString().trim() : null;
      const machine_sn = r.MACHINE_SN ? r.MACHINE_SN.toString().trim() : null;
      batch.push([Number(userIdClean), checktime, machine_ip, machine_sn]);

      if (batch.length >= batchSize) {
        try {
          await db.query(
            `INSERT IGNORE INTO Checkins (USERID, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES ?`,
            [batch]
          );
          inserted += batch.length;
          batch = [];
        } catch (err) {
          // Detectamos si es max_user_connections
          if (err.code === 'ER_CON_COUNT_ERROR' || err.message.includes('max_user_connections')) {
            console.error('Base de datos ocupada:', err.message);
            return res.status(503).json({
              error: 'La base de datos está ocupada. Intenta más tarde.'
            });
          } else if (err.code === 'ECONNREFUSED') {
            console.error('Error de conexión a la base de datos:', err.message);
            return res.status(503).json({
              error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
            });
          } else {
            console.error('ROW BATCH ERROR:', batch, err.message);
            errors += batch.length;
            batch = [];
          }
        }
      }
    }

    // Insertar lo que quede en el batch final
    if (batch.length > 0) {
      try {
        await db.query(
          `INSERT IGNORE INTO Checkins (USERID, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES ?`,
          [batch]
        );
        inserted += batch.length;
      } catch (err) {
        if (err.code === 'ER_CON_COUNT_ERROR' || err.message.includes('max_user_connections')) {
          console.error('Base de datos ocupada al final del batch:', err.message);
          return res.status(503).json({
            error: 'La base de datos está ocupada. Intenta más tarde.'
          });
        } else if (err.code === 'ECONNREFUSED') {
          console.error('Error de conexión a la base de datos al final del batch:', err.message);
          return res.status(503).json({
            error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.'
          });
        } else {
          console.error('FINAL BATCH ERROR:', batch, err.message);
          errors += batch.length;
        }
      }
    }

    res.json({
      ok: true,
      inserted,
      skipped,
      errors,
      total: records.length
    });

  } catch (err) {
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
app.post('/import/users', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Archivo CSV requerido' });
    }

    const csv = req.file.buffer.toString('utf8');

    const records = parse(csv, {
      columns: true,
      delimiter: ';',
      skip_empty_lines: true,
      trim: true
    });

    let upserted = 0;
    let skipped = 0;

    for (const r of records) {
      if (!r.USERID || !r.Badgenumber || !r.Name) {
        skipped++;
        continue;
      }

      const trimmedBadge = String(r.Badgenumber).trim();
      const userId = Number(r.USERID);

      // Verificar si Badgenumber ya existe
      const [existing] = await db.query(
        'SELECT USERID FROM users WHERE TRIM(Badgenumber) = ? LIMIT 1',
        [trimmedBadge]
      );

      if (existing.length > 0) {
        // Si existe, actualizar solo el Name si el USERID es diferente
        if (existing[0].USERID !== userId) {
          await db.query(
            'UPDATE users SET Name = ? WHERE USERID = ?',
            [r.Name, existing[0].USERID]
          );
        }
      } else {
        // Si no existe, insertar nuevo
        await db.query(
          'INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, ?)',
          [userId, trimmedBadge, r.Name]
        );
      }

      upserted++;
    }

    res.json({ 
      ok: true, 
      users: upserted,
      skipped: skipped,
      message: 'Importacion completada'
    });

  } catch (err) {
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

// DELETE ALL CHECKINS (¡cuidado, borra todo!)
app.delete('/clear/checkins', async (req, res) => {
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
app.get('/debug/status', async (req, res) => {
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
app.get('/users', async (req, res) => {
  try {
    const [users] = await db.query(`
      SELECT USERID, Badgenumber, Name
      FROM users
      ORDER BY Name
    `);

    res.json(users);

  } catch (err) {
    console.error('USERS ERROR:', err);
    res.status(500).json({ error: 'Error cargando usuarios' });
  }
});

/* ===============================
   DIAGNÓSTICO PARA DEBUG (Endpoint Temporal)
================================ */

app.get('/diagnostic/:badge/:month', async (req, res) => {
  try {
    const { badge, month } = req.params;
    
    console.log(`🔍 DIAGNOSTIC: badge=${badge}, month=${month}`);
    
    const result = {
      badge,
      month,
      checks: {}
    };
    
    // 1. ¿Existe el usuario en tabla users?
    const [[user]] = await db.query(
      'SELECT USERID, Badgenumber, Name FROM users WHERE Badgenumber = ? LIMIT 1',
      [badge]
    );
    
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
        'SELECT Badgenumber, Name FROM users WHERE Badgenumber LIKE ? LIMIT 5',
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
app.get('/data', async (req, res) => {
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
      LEFT JOIN user_employee_map uem ON u.USERID = uem.USERID
      LEFT JOIN employees e ON uem.employee_id = e.id
      WHERE 1=1
    `;
    const usersParams = [];

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

// 1. OBTENER/CREAR CONFIGURACIÓN DE USUARIOS ESPECIALES
app.get('/config/special-users', async (req, res) => {
  try {
    const [specialUsers] = await db.query(`
      SELECT su.*, u.Name as userName
      FROM specialusers su
      JOIN users u ON su.userId = u.USERID
      WHERE su.isActive = TRUE
      ORDER BY su.category, su.id
    `);
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

app.post('/config/special-users', async (req, res) => {
  try {
    const { userId, category, function: func } = req.body;
    
    // Verificar que el usuario existe
    const [user] = await db.query(
      `SELECT USERID, Badgenumber, Name FROM users WHERE USERID = ?`,
      [userId]
    );
    
    if (user.length === 0) {
      return res.status(400).json({ error: 'Usuario no encontrado' });
    }
    
    await db.query(`
      INSERT INTO specialusers (userId, badgeNumber, name, category, function, isActive)
      VALUES (?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE
        category = VALUES(category),
        function = VALUES(function),
        isActive = TRUE
    `, [userId, user[0].Badgenumber, user[0].Name, category, func]);
    
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

app.post('/config/schedule', async (req, res) => {
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
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        name VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await db.query(
      `SELECT value FROM app_settings WHERE name = ?`,
      ['theme']
    );

    res.json({ theme: rows[0]?.value || '' });
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

    await db.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        name VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await db.query(
      `INSERT INTO app_settings (name, value)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP`,
      ['theme', theme]
    );

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

// GET /config/user-exclusions?page=1&limit=20&search=...&status=...
app.get('/config/user-exclusions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const search = req.query.search || '';
    const status = req.query.status || ''; // 'active', 'expired', 'all'
    
    const offset = (page - 1) * limit;
    
    // Construir WHERE
    let where = '';
    let params = [];
    
    if (search) {
      where = `WHERE (u.Name LIKE ? OR u.Badgenumber LIKE ? OR ue.reason LIKE ?)`;
      params = [`%${search}%`, `%${search}%`, `%${search}%`];
    }
    
    if (status === 'active') {
      where += params.length > 0 ? ' AND' : 'WHERE';
      where += ` ue.excDate >= CURDATE()`;
    } else if (status === 'expired') {
      where += params.length > 0 ? ' AND' : 'WHERE';
      where += ` ue.excDate < CURDATE()`;
    }
    
    // Obtener total
    const [[{ total }]] = await db.query(`
      SELECT COUNT(*) as total
      FROM \`userexclusions\` ue
      JOIN \`users\` u ON ue.userId = u.USERID
      ${where}
    `, params);
    
    // Obtener datos paginados
    const [exclusions] = await db.query(`
      SELECT 
        ue.id,
        ue.userId,
        u.Badgenumber,
        u.Name,
        ue.excDate,
        ue.reason,
        ue.type,
        ue.excFrom,
        ue.excTo,
        ue.createdAt,
        (ue.excDate >= CURDATE()) as isActive
      FROM \`userexclusions\` ue
      JOIN \`users\` u ON ue.userId = u.USERID
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
app.post('/config/user-exclusions', async (req, res) => {
  try {
    const { userId, excDate, reason, type, excFrom, excTo } = req.body;
    
    if (!userId || !excDate) {
      return res.status(400).json({ error: 'userId y excDate son requeridos' });
    }
    
    // Verificar que el usuario existe
    const [[user]] = await db.query(
      `SELECT USERID FROM \`users\` WHERE USERID = ?`,
      [userId]
    );
    
    if (!user) {
      return res.status(400).json({ error: 'Usuario no encontrado' });
    }
    
    try {
      await db.query(`
        INSERT INTO \`userexclusions\` (userId, excDate, reason, type, excFrom, excTo)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, excDate, reason || null, type || 'FULL_DAY', excFrom || null, excTo || null]);
      
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

// PUT /config/user-exclusions/:id - Actualizar exclusión
app.put('/config/user-exclusions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, type, excFrom, excTo } = req.body;
    
    const [result] = await db.query(`
      UPDATE \`userexclusions\`
      SET reason = ?, type = ?, excFrom = ?, excTo = ?
      WHERE id = ?
    `, [reason || null, type || 'FULL_DAY', excFrom || null, excTo || null, id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Exclusión no encontrada' });
    }
    
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
app.delete('/config/user-exclusions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [result] = await db.query(
      `DELETE FROM \`userexclusions\` WHERE id = ?`,
      [id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Exclusión no encontrada' });
    }
    
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

// GET /config/users-with-exclusions - Listar usuarios con estado de exclusión
app.get('/config/users-with-exclusions', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    
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
      LEFT JOIN \`userexclusions\` ue ON u.USERID = ue.userId AND ue.excDate = ?
      WHERE u.USERID > 10
      ORDER BY u.Name
    `, [date]);
    
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
app.post('/config/toggle-user-exclusion', async (req, res) => {
  try {
    const { userId, excDate, reason, type, exclude } = req.body;
    
    if (!userId || !excDate) {
      return res.status(400).json({ error: 'userId y excDate son requeridos' });
    }
    
    if (exclude) {
      // Agregar exclusión
      try {
        await db.query(`
          INSERT INTO \`userexclusions\` (userId, excDate, reason, type)
          VALUES (?, ?, ?, ?)
        `, [userId, excDate, reason || 'Manual exclusion', type || 'FULL_DAY']);
        
        res.json({ ok: true, message: 'Usuario excluido', excluded: true });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Ya está excluido', excluded: true });
        }
        throw err;
      }
    } else {
      // Eliminar exclusión
      await db.query(`
        DELETE FROM \`userexclusions\`
        WHERE userId = ? AND excDate = ?
      `, [userId, excDate]);
      
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
app.get('/config/excluded-users', async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build search query
    let whereClause = '';
    const params = [];
    if (search) {
      whereClause = 'WHERE (Name LIKE ? OR Badgenumber LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Get total count
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM users ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get paginated results
    const [users] = await db.query(
      `SELECT USERID, Badgenumber, Name, isExcluded FROM users ${whereClause} ORDER BY Name LIMIT ? OFFSET ?`,
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
app.put('/config/toggle-user-exclusion-permanent/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { exclude } = req.body;

    if (typeof exclude !== 'boolean') {
      return res.status(400).json({ error: 'exclude debe ser true o false' });
    }

    // Get current status
    const [currentUser] = await db.query(
      'SELECT isExcluded FROM users WHERE USERID = ?',
      [userId]
    );

    if (currentUser.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Update status
    await db.query(
      'UPDATE users SET isExcluded = ? WHERE USERID = ?',
      [exclude ? 1 : 0, userId]
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
app.delete('/config/user-exclusion/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    // Check if user exists
    const [user] = await db.query(
      'SELECT USERID FROM users WHERE USERID = ?',
      [userId]
    );

    if (user.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Remove exclusion
    await db.query(
      'UPDATE users SET isExcluded = 0 WHERE USERID = ?',
      [userId]
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

// Función auxiliar: extraer hora de YYYY-MM-DD HH:mm:ss
function extractTime(datetimeStr) {
  if (!datetimeStr) return '00:00';
  const parts = datetimeStr.split(' ');
  if (parts.length < 2) return datetimeStr; // Si no tiene espacio, asumir que es solo HH:mm
  return parts[1].substring(0, 5); // HH:mm
}

// 4. LISTA DE ASISTENCIA DIARIA - MEJORADO CON TOLERANCIA
app.get('/attendance/:date', async (req, res) => {
  try {
    const { date } = req.params; // YYYY-MM-DD
    const tolerance = req.query.tolerance || 10; // minutos
    const scheduleTime = req.query.scheduleTime || '07:00'; // HH:mm
    
    console.log(`📅 REQUEST /attendance/${date}`);
    console.log(`   tolerance: ${tolerance}, scheduleTime: ${scheduleTime}`);
    
    // PASO 1: Obtener todos los usuarios (excepto ficticios y excluidos)
    let users = [];
    try {
      const [usersResult] = await db.query(`
        SELECT USERID, Badgenumber, Name
        FROM \`users\`
        WHERE USERID > 10
          AND isExcluded = 0
        ORDER BY Name
      `);
      users = usersResult || [];
      console.log(`✓ Usuarios desde tabla users: ${users.length}`);
    } catch (e) {
      console.error(`❌ Error fetching users: ${e.message}`);
      users = [];
    }

    // PASO 1B: Obtener empleados importados que no tienen user mapeado
    let importedEmployees = [];
    try {
      const [employeesResult] = await db.query(`
        SELECT e.id, e.employee_id, e.nombre, e.activo
        FROM \`employees\` e
        WHERE e.activo = 1
          AND NOT EXISTS (
            SELECT 1 FROM \`user_employee_map\` uem 
            WHERE uem.employee_id = e.id
          )
        ORDER BY e.nombre
      `);
      importedEmployees = employeesResult || [];
      console.log(`✓ Empleados importados (sin mapear): ${importedEmployees.length}`);
      
      // Agregar empleados importados como si fueran usuarios
      // Usamos un ID negativo para identificarlos como sin checkins
      importedEmployees.forEach(emp => {
        users.push({
          USERID: -emp.id, // ID negativo para identificar como empleado importado
          Badgenumber: emp.employee_id,
          Name: emp.nombre,
          isImported: true
        });
      });
      
      console.log(`✓ Total de usuarios (incluyendo empleados importados): ${users.length}`);
    } catch (e) {
      console.error(`⚠️ Error fetching imported employees: ${e.message}`);
    }
    
    // PASO 2: Obtener horario configurado del día (si existe)
    let schedule = {
      timeEntrance: scheduleTime + ':00',
      timeExit: '13:40:00',
      isWorkDay: true
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
    
    const entranceTime = extractTime(schedule.timeEntrance) || scheduleTime;
    const entranceMinutes = timeToMinutes(entranceTime);
    const toleranceMinutes = parseInt(tolerance);
    
    console.log(`✓ Entrance: ${entranceTime}, Tolerance: ${toleranceMinutes}min`);
    
    // PASO 3: Obtener TODOS los fichajes del día - MATCHED BY BADGENUMBER
    let checkins = [];
    try {
      // Join Checkins con users para obtener los fichajes con el Badgenumber correcto
      const [checkinsResult] = await db.query(`
        SELECT u.USERID, c.CHECKTIME
        FROM \`Checkins\` c
        LEFT JOIN \`users\` u ON CAST(c.USERID AS CHAR) = CAST(u.Badgenumber AS CHAR)
        WHERE DATE(c.CHECKTIME) = ?
        ORDER BY u.USERID, c.CHECKTIME
      `, [date]);
      checkins = checkinsResult || [];
      console.log(`✓ Fichajes (matched by Badgenumber): ${checkins.length}`);
    } catch (e) {
      console.error(`❌ Error fetching checkins: ${e.message}`);
      checkins = [];
    }
    
    // PASO 4: Obtener exclusiones del día
    let exclusions = [];
    try {
      const [exclusionsResult] = await db.query(`
        SELECT userId, reason, type
        FROM \`userexclusions\`
        WHERE excDate = ?
      `, [date]);
      exclusions = exclusionsResult || [];
      console.log(`✓ Exclusiones: ${exclusions.length}`);
    } catch (e) {
      console.error(`⚠️ Error fetching exclusions: ${e.message}`);
      exclusions = [];
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
      
      let status = 'Absent';
      let firstCheckin = null;
      let lastCheckin = null;
      
      if (userExclusion) {
        status = userExclusion.type === 'FULL_DAY' ? 'Excused' : 'Excused';
      } else if (userCheckins.length > 0) {
        firstCheckin = userCheckins[0];
        lastCheckin = userCheckins[userCheckins.length - 1];
        
        // Calcular si llegó a tiempo o tarde
        const firstTimeStr = extractTime(firstCheckin);
        const firstTimeMin = timeToMinutes(firstTimeStr);
        
        if (firstTimeMin <= entranceMinutes + toleranceMinutes) {
          status = 'OnTime';
        } else {
          status = 'Late';
        }
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
        exclusion: userExclusion || null
      };
    });
    
    // PASO 7: Calcular resumen
    const summary = {
      onTime: attendance.filter(a => a.status === 'OnTime').length,
      late: attendance.filter(a => a.status === 'Late').length,
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
app.get('/attendance-range', async (req, res) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'from y to requeridos' });
    }

    // 1. USERS
    const [users] = await db.query(`
      SELECT USERID, Badgenumber, Name
      FROM users
      WHERE USERID > 10 AND isExcluded = 0
    `);

    const userIds = users.map(u => u.USERID);

    // 2. CHECKINS EN RANGO
    const [checkins] = await db.query(`
      SELECT USERID, CHECKTIME
      FROM Checkins
      WHERE USERID IN (?)
        AND DATE(CHECKTIME) BETWEEN ? AND ?
      ORDER BY USERID, CHECKTIME
    `, [userIds, from, to]);

    // 3. AGRUPAR POR USER + FECHA
    const grouped = {};

    checkins.forEach(c => {
      const date = c.CHECKTIME.substring(0, 10);
      const key = `${c.USERID}_${date}`;

      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(c.CHECKTIME);
    });

    // 4. RESULTADO FINAL
    const result = [];

    users.forEach(u => {
      const userDays = Object.keys(grouped)
        .filter(k => k.startsWith(u.USERID + '_'));

      let totalDays = 0;
      let late = 0;
      let onTime = 0;
      let overtimeMinutes = 0;

      userDays.forEach(k => {
        const checks = grouped[k];

        totalDays++;

        const first = checks[0];
        const last = checks[checks.length - 1];

        const firstMin = timeToMinutes(extractTime(first));
        const lastMin = timeToMinutes(extractTime(last));

        // config (podés mejorar después con schedule dinámico)
        const entrance = timeToMinutes('07:00');
        const tolerance = 10;
        const cutoff = timeToMinutes('13:40');

        // estado
        if (firstMin <= entrance + tolerance) onTime++;
        else late++;

        // extras
        if (lastMin > cutoff) {
          overtimeMinutes += (lastMin - cutoff);
        }
      });

      result.push({
        userId: u.USERID,
        name: u.Name,
        badge: u.Badgenumber,
        daysWorked: totalDays,
        onTime,
        late,
        overtimeHours: (overtimeMinutes / 60).toFixed(2)
      });
    });

    res.json({
      from,
      to,
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


// 5. REPORTE DE MOVIMIENTOS (Salidas Particulares, Oficiales, Campaña)
app.get('/movements/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    // Obtener usuarios especiales y sus funciones
    const [specialUsers] = await db.query(`
      SELECT * FROM specialusers WHERE isActive = TRUE
    `);
    
    // Mapear usuarios especiales
    const markerMap = {};
    specialUsers.forEach(su => {
      markerMap[su.userId] = { category: su.category, function: su.function };
    });
    
    // Obtener fichajes del día (incluyendo ficticios)
    const [checkins] = await db.query(`
      SELECT c.USERID, c.CHECKTIME, u.Name, u.Badgenumber
      FROM Checkins c
      JOIN users u ON c.USERID = u.USERID
      WHERE DATE(c.CHECKTIME) = ?
      ORDER BY c.CHECKTIME
    `, [date]);
    
    // Procesar movimientos
    const movements = [];
    for (let i = 0; i < checkins.length - 1; i++) {
      const current = checkins[i];
      const marker = markerMap[current.USERID];
      
      if (!marker) continue; // No es usuario especial
      
      // Buscar siguiente fichaje de empleado real
      if (marker.category === 'SALIDA' || marker.category === 'RETORNO') {
        const next = checkins[i + 1];
        if (!markerMap[next.USERID]) {
          // next es empleado real
          movements.push({
            type: marker.category,
            function: marker.function,
            employee: next.Name,
            employeeBadge: next.Badgenumber,
            timeOut: current.CHECKTIME,
            timeIn: i + 2 < checkins.length ? checkins[i + 2].CHECKTIME : null
          });
        }
      }
    }
    
    res.json({
      date,
      movements
    });
  } catch (err) {
    console.error('ERROR fetching movements:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error fetching movements' });
  }
});

// ========================================
// ENDPOINTS PARA GESTIÓN DE EMPLEADOS & MATCHING
// ========================================

// GET /api/employees - Listar todos los empleados
app.get('/api/employees', async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '', active = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let whereClause = '';
    const params = [];

    if (search) {
      whereClause += ' AND (e.nombre LIKE ? OR e.documento LIKE ? OR e.employee_id LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (active !== '') {
      whereClause += ' AND e.activo = ?';
      params.push(active === 'true' ? 1 : 0);
    }

    // Total count
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM employees e WHERE 1=1 ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get employees with matching user info
    const [employees] = await db.query(`
      SELECT 
        e.*,
        u.USERID,
        u.Name as user_name,
        u.Badgenumber,
        uem.match_type
      FROM employees e
      LEFT JOIN user_employee_map uem ON e.id = uem.employee_id
      LEFT JOIN users u ON uem.USERID = u.USERID
      WHERE 1=1 ${whereClause}
      ORDER BY e.nombre
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    res.json({
      data: employees,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('ERROR getting employees:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error obteniendo empleados' });
  }
});

// GET /api/employees/:id - Obtener empleado por ID
app.get('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [employee] = await db.query(
      `SELECT * FROM employees WHERE id = ?`,
      [parseInt(id)]
    );

    if (employee.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Get mapping info
    const [mapping] = await db.query(
      `SELECT u.*, uem.match_type FROM user_employee_map uem
       LEFT JOIN users u ON uem.USERID = u.USERID
       WHERE uem.employee_id = ?`,
      [parseInt(id)]
    );

    res.json({
      ...employee[0],
      user_mapping: mapping[0] || null
    });
  } catch (err) {
    console.error('ERROR getting employee:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error obteniendo empleado' });
  }
});

// POST /api/employees - Crear nuevo empleado
app.post('/api/employees', async (req, res) => {
  try {
    const { employee_id, nombre, documento, tipo_documento, direccion, zona_id, fecha_alta, activo } = req.body;

    if (!nombre || !employee_id) {
      return res.status(400).json({ error: 'nombre y employee_id son requeridos' });
    }

    const [result] = await db.query(
      `INSERT INTO employees 
       (employee_id, nombre, documento, tipo_documento, direccion, zona_id, fecha_alta, activo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [employee_id, nombre, documento || null, tipo_documento || null, direccion || null, zona_id || null, fecha_alta || null, activo !== false ? 1 : 0]
    );

    res.json({ 
      ok: true, 
      message: 'Empleado creado',
      id: result.insertId
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'El employee_id ya existe' });
    }
    console.error('ERROR creating employee:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error creando empleado' });
  }
});

// PUT /api/employees/:id - Actualizar empleado
app.put('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, documento, tipo_documento, direccion, zona_id, fecha_baja, activo } = req.body;

    // Check if exists
    const [existing] = await db.query('SELECT id FROM employees WHERE id = ?', [parseInt(id)]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    const updates = [];
    const values = [];

    if (nombre !== undefined) {
      updates.push('nombre = ?');
      values.push(nombre);
    }
    if (documento !== undefined) {
      updates.push('documento = ?');
      values.push(documento);
    }
    if (tipo_documento !== undefined) {
      updates.push('tipo_documento = ?');
      values.push(tipo_documento);
    }
    if (direccion !== undefined) {
      updates.push('direccion = ?');
      values.push(direccion);
    }
    if (zona_id !== undefined) {
      updates.push('zona_id = ?');
      values.push(zona_id);
    }
    if (fecha_baja !== undefined) {
      updates.push('fecha_baja = ?');
      values.push(fecha_baja);
    }
    if (activo !== undefined) {
      updates.push('activo = ?');
      values.push(activo ? 1 : 0);
    }

    updates.push('updated_at = NOW()');
    values.push(parseInt(id));

    if (updates.length > 1) {
      await db.query(
        `UPDATE employees SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    res.json({ ok: true, message: 'Empleado actualizado' });
  } catch (err) {
    console.error('ERROR updating employee:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error actualizando empleado' });
  }
});

// DELETE /api/employees/:id - Eliminar empleado
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if exists
    const [existing] = await db.query('SELECT id FROM employees WHERE id = ?', [parseInt(id)]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Check if has mappings - prevent deletion if mapped
    const [mappings] = await db.query(
      'SELECT COUNT(*) as cnt FROM user_employee_map WHERE employee_id = ?',
      [parseInt(id)]
    );

    if (mappings[0].cnt > 0) {
      return res.status(409).json({ 
        error: 'No se puede eliminar empleado con relaciones activas',
        relatedRecords: mappings[0].cnt 
      });
    }

    await db.query('DELETE FROM employees WHERE id = ?', [parseInt(id)]);

    res.json({ ok: true, message: 'Empleado eliminado' });
  } catch (err) {
    console.error('ERROR deleting employee:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error eliminando empleado' });
  }
});

// ========================================
// ENDPOINTS PARA AUTO-MATCHING
// ========================================

// POST /api/matching/auto - Auto-match usuarios con empleados
app.post('/api/matching/auto', async (req, res) => {
  try {
    let matched = 0;
    let conflicts = 0;

    // Get all employees with employee_id
    const [employees] = await db.query(
      'SELECT id, employee_id FROM employees WHERE employee_id IS NOT NULL'
    );

    for (const emp of employees) {
      // Find user with matching Badgenumber
      const [users] = await db.query(
        'SELECT USERID FROM users WHERE Badgenumber = ? AND USERID > 10',
        [emp.employee_id.toString()]
      );

      if (users.length === 0) continue;

      const userId = users[0].USERID;

      // Check if already mapped
      const [existing] = await db.query(
        'SELECT USERID FROM user_employee_map WHERE USERID = ?',
        [userId]
      );

      if (existing.length > 0) {
        conflicts++;
        continue;
      }

      // Create mapping
      try {
        await db.query(
          'INSERT INTO user_employee_map (USERID, employee_id, match_type) VALUES (?, ?, ?)',
          [userId, emp.id, 'auto_employee_id']
        );
        matched++;
      } catch (err) {
        console.error(`Error mapping user ${userId}:`, err.message);
        conflicts++;
      }
    }

    res.json({
      ok: true,
      message: `Auto-matching completado: ${matched} relacionados, ${conflicts} conflictos`,
      matched,
      conflicts
    });
  } catch (err) {
    console.error('ERROR auto-matching:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error en auto-matching' });
  }
});

// POST /api/matching/manual - Relacionar usuario con empleado manualmente
app.post('/api/matching/manual', async (req, res) => {
  try {
    const { userId, employeeId } = req.body;

    if (!userId || !employeeId) {
      return res.status(400).json({ error: 'userId y employeeId son requeridos' });
    }

    // Check both exist
    const [user] = await db.query('SELECT USERID FROM users WHERE USERID = ?', [parseInt(userId)]);
    const [employee] = await db.query('SELECT id FROM employees WHERE id = ?', [parseInt(employeeId)]);

    if (user.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (employee.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Remove old mapping for this user if exists
    await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [parseInt(userId)]);

    // Create new mapping
    await db.query(
      'INSERT INTO user_employee_map (USERID, employee_id, match_type) VALUES (?, ?, ?)',
      [parseInt(userId), parseInt(employeeId), 'manual']
    );

    res.json({ ok: true, message: 'Usuario relacionado con empleado' });
  } catch (err) {
    console.error('ERROR manual matching:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error en relación manual' });
  }
});

// DELETE /api/matching/:userId - Remover relación
app.delete('/api/matching/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [result] = await db.query(
      'DELETE FROM user_employee_map WHERE USERID = ?',
      [parseInt(userId)]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Relación no encontrada' });
    }

    res.json({ ok: true, message: 'Relación removida' });
  } catch (err) {
    console.error('ERROR removing matching:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error removiendo relación' });
  }
});

// GET /api/matching/unmatched-users - Obtener usuarios sin mapear
app.get('/api/matching/unmatched-users', async (req, res) => {
  try {
    const [unmapped] = await db.query(`
      SELECT u.USERID, u.Badgenumber, u.Name
      FROM users u
      WHERE u.USERID > 10 
        AND u.USERID NOT IN (SELECT USERID FROM user_employee_map)
      ORDER BY u.Name
    `);

    res.json(unmapped);
  } catch (err) {
    console.error('ERROR getting unmatched users:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error obteniendo usuarios sin mapear' });
  }
});

// GET /api/matching/status - Ver estado del matching
app.get('/api/matching/status', async (req, res) => {
  try {
    const [[{ total: totalUsers }]] = await db.query('SELECT COUNT(*) as total FROM users WHERE USERID > 10');
    const [[{ mapped: mappedUsers }]] = await db.query('SELECT COUNT(*) as mapped FROM user_employee_map');
    const [[{ total: totalEmployees }]] = await db.query('SELECT COUNT(*) as total FROM employees');

    res.json({
      totalUsers: parseInt(totalUsers),
      mappedUsers: parseInt(mappedUsers),
      unmappedUsers: parseInt(totalUsers) - parseInt(mappedUsers),
      totalEmployees: parseInt(totalEmployees),
      matchPercentage: ((parseInt(mappedUsers) / parseInt(totalUsers)) * 100).toFixed(2)
    });
  } catch (err) {
    console.error('ERROR getting matching status:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Error obteniendo estado' });
  }
});

/* ===============================
   CLEANUP DUPLICATES
================================ */
app.get('/api/users/cleanup-duplicates', async (req, res) => {
  try {
    console.log('[CLEANUP] Iniciando limpieza de usuarios duplicados...');

    // 1. Encontrar usuarios duplicados por Badgenumber
    const [duplicates] = await db.query(`
      SELECT TRIM(Badgenumber) as badge, COUNT(*) as count, GROUP_CONCAT(USERID) as userids
      FROM users
      GROUP BY TRIM(Badgenumber)
      HAVING count > 1
      ORDER BY count DESC
    `);

    console.log(`[CLEANUP] Encontrados ${duplicates.length} badges con duplicados`);

    let totalDeleted = 0;
    let totalMapsDeleted = 0;
    let totalExclusionsDeleted = 0;

    for (const dup of duplicates) {
      const userids = dup.userids.split(',').map(Number);
      const keepUID = userids[0];
      const deleteUIDs = userids.slice(1);

      console.log(`[CLEANUP] Badge: ${dup.badge} | Mantener: ${keepUID} | Eliminar: ${deleteUIDs.join(',')}`);

      for (const uid of deleteUIDs) {
        // Eliminar todas las referencias primero (ordenar por dependencias FK)
        
        // 1. specialusers references users
        const [deletedSpecial] = await db.query(
          'DELETE FROM specialusers WHERE userId = ?',
          [uid]
        );
        console.log(`[CLEANUP]   → Eliminados ${deletedSpecial.affectedRows} registros de specialusers`);

        // 2. userexclusions references users
        const [deletedExcl] = await db.query(
          'DELETE FROM userexclusions WHERE userId = ?',
          [uid]
        );
        totalExclusionsDeleted += deletedExcl.affectedRows;

        // 3. dailyattendance references users
        const [deletedAttend] = await db.query(
          'DELETE FROM dailyattendance WHERE userId = ?',
          [uid]
        );
        console.log(`[CLEANUP]   → Eliminados ${deletedAttend.affectedRows} registros de attendance`);

        // 4. dayassignments references users
        const [deletedAssign] = await db.query(
          'DELETE FROM dayassignments WHERE userId = ?',
          [uid]
        );
        console.log(`[CLEANUP]   → Eliminados ${deletedAssign.affectedRows} registros de assignments`);

        // 5. user_employee_map references users
        const [deletedMaps] = await db.query(
          'DELETE FROM user_employee_map WHERE USERID = ?',
          [uid]
        );
        totalMapsDeleted += deletedMaps.affectedRows;

        // 6. Finalmente, eliminar usuario
        const [deleted] = await db.query(
          'DELETE FROM users WHERE USERID = ?',
          [uid]
        );
        totalDeleted += deleted.affectedRows;
      }
    }

    // 2. Hacer TRIM en todos los Badgenumbers
    await db.query('UPDATE users SET Badgenumber = TRIM(Badgenumber)');

    // 3. Intentar agregar UNIQUE constraint
    let constraintAdded = false;
    try {
      await db.query(`
        ALTER TABLE users ADD UNIQUE KEY unique_badgenumber (Badgenumber)
      `);
      constraintAdded = true;
      console.log('[CLEANUP] UNIQUE constraint agregado');
    } catch (err) {
      console.log('[CLEANUP] UNIQUE constraint ya existe o error:', err.code);
    }

    // 4. Verificar integridad
    const [[{ totalUsers }]] = await db.query(
      'SELECT COUNT(DISTINCT USERID) as totalUsers FROM users WHERE USERID > 10'
    );
    const [[{ totalBadges }]] = await db.query(
      'SELECT COUNT(DISTINCT TRIM(Badgenumber)) as totalBadges FROM users WHERE USERID > 10'
    );

    res.json({
      ok: true,
      message: 'Limpieza completada',
      stats: {
        duplicatesFound: duplicates.length,
        usersDeleted: totalDeleted,
        mapsDeleted: totalMapsDeleted,
        exclusionsDeleted: totalExclusionsDeleted,
        constraintAdded: constraintAdded,
        finalStats: {
          totalUsers: totalUsers,
          uniqueBadges: totalBadges
        }
      }
    });

  } catch (err) {
    console.error('[CLEANUP ERROR]:', err);
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ 
        error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' 
      });
    }
    res.status(500).json({ error: 'Cleanup failed', details: err.message });
  }
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