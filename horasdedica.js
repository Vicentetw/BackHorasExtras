//require('dotenv').config();
//quitar require('dotenv') si no usas .env local, y configurar variables de entorno en tu hosting (Clever Cloud)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(cors());
app.use(express.json());

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

    if (end <= start) {
      return res.status(400).json({
        error: 'endDatetime debe ser mayor que startDatetime'
      });
    }

    await db.query(
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
      message: 'Registro manual guardado correctamente'
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

      batch.push([Number(userIdClean), checktime]);

      if (batch.length >= batchSize) {
        try {
          await db.query(
            `INSERT IGNORE INTO Checkins (USERID, CHECKTIME) VALUES ?`,
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
          `INSERT IGNORE INTO Checkins (USERID, CHECKTIME) VALUES ?`,
          [batch]
        );
        inserted += batch.length;
      } catch (err) {
        if (err.code === 'ER_CON_COUNT_ERROR' || err.message.includes('max_user_connections')) {
          console.error('Base de datos ocupada al final del batch:', err.message);
          return res.status(503).json({
            error: 'La base de datos está ocupada. Intenta más tarde.'
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

    for (const r of records) {
      if (!r.USERID || !r.Badgenumber || !r.Name) continue;

      await db.query(
        `INSERT INTO Users (USERID, Badgenumber, Name)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           Badgenumber = VALUES(Badgenumber),
           Name = VALUES(Name)`,
        [Number(r.USERID), r.Badgenumber, r.Name]
      );

      upserted++;
    }

    res.json({ ok: true, users: upserted });

  } catch (err) {
    console.error('IMPORT USERS ERROR:', err);
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
    res.status(500).json({ error: 'Error al borrar los fichajes' });
  }
});

/* ===============================
   USERS FOR AUTOCOMPLETE
================================ */
app.get('/users', async (req, res) => {
  try {
    const [users] = await db.query(`
      SELECT USERID, Badgenumber, Name
      FROM Users
      ORDER BY Name
    `);

    res.json(users);

  } catch (err) {
    console.error('USERS ERROR:', err);
    res.status(500).json({ error: 'Error cargando usuarios' });
  }
});

/* ===============================
   DATA PARA INFORME (ONLINE)
================================ */
app.get('/data', async (req, res) => {
  try {
    const { month, badge, name } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month requerido (YYYY-MM)' });
    }

    // ======================
    // USERS FILTRADOS
    // ======================
    let usersSQL = `
      SELECT USERID, Badgenumber, Name
      FROM Users
      WHERE 1=1
    `;
    const usersParams = [];

    if (badge) {
      usersSQL += ' AND Badgenumber = ?';
      usersParams.push(badge);
    }

    if (name) {
      usersSQL += ' AND LOWER(Name) LIKE ?';
      usersParams.push(`%${name.toLowerCase()}%`);
    }

    const [users] = await db.query(usersSQL, usersParams);

    if (users.length === 0) {
      return res.json({
        users: [],
        checkins: [],
        manuals: []
      });
    }

    const userIds = users.map(u => u.USERID);

    // ======================
    // CHECKINS FILTRADOS
    // ======================
    const [checkins] = await db.query(
      `
      SELECT 
        USERID,
        DATE_FORMAT(CHECKTIME, '%Y-%m-%dT%H:%i:%s') AS CHECKTIME
      FROM Checkins
      WHERE USERID IN (?)
        AND DATE_FORMAT(CHECKTIME, '%Y-%m') = ?
      ORDER BY USERID, CHECKTIME
      `,
      [userIds, month]
    );

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
    // ======================
    // FILTRO: excluir días sin fichaje antes de las 14:00
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

    const checkinsFiltrados = [];

    for (const key in agrupado) {
      const fichajes = agrupado[key];

      // Ya vienen ordenados por ORDER BY USERID, CHECKTIME
      const primerFichaje = new Date(fichajes[0].CHECKTIME);

      const minutos =
        primerFichaje.getHours() * 60 +
        primerFichaje.getMinutes();

      // Si el primer fichaje es antes de las 14:00 → válido
      if (minutos < 14 * 60) {
        checkinsFiltrados.push(...fichajes);
      }

      // Si no → se excluye el día completo
    }

    res.json({
      users,
     // checkins,
     checkins: checkinsFiltrados, // devuelvo los checkins filtrados quitanto los días sin fichaje antes de las 14:00
      manuals
    });

  } catch (err) {
    console.error('DATA ERROR:', err);
    res.status(500).json({ error: 'Error backend' });
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
      FROM SpecialUsers su
      JOIN Users u ON su.userId = u.USERID
      WHERE su.isActive = TRUE
      ORDER BY su.category, su.id
    `);
    res.json(specialUsers);
  } catch (err) {
    console.error('ERROR fetching special users:', err);
    res.status(500).json({ error: 'Error fetching special users' });
  }
});

app.post('/config/special-users', async (req, res) => {
  try {
    const { userId, category, function: func } = req.body;
    
    // Verificar que el usuario existe
    const [user] = await db.query(
      `SELECT USERID, Badgenumber, Name FROM Users WHERE USERID = ?`,
      [userId]
    );
    
    if (user.length === 0) {
      return res.status(400).json({ error: 'Usuario no encontrado' });
    }
    
    await db.query(`
      INSERT INTO SpecialUsers (userId, badgeNumber, name, category, function, isActive)
      VALUES (?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE
        category = VALUES(category),
        function = VALUES(function),
        isActive = TRUE
    `, [userId, user[0].Badgenumber, user[0].Name, category, func]);
    
    res.json({ ok: true, message: 'Usuario especial configurado' });
  } catch (err) {
    console.error('ERROR setting special user:', err);
    res.status(500).json({ error: 'Error configurando usuario especial' });
  }
});

// 2. HORARIO EMPRESA
app.get('/config/schedule/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const [schedule] = await db.query(
      `SELECT * FROM CompanySchedule WHERE scheduleDate = ?`,
      [date]
    );
    
    res.json(schedule[0] || {
      timeEntrance: '07:00:00',
      timeExit: '13:40:00',
      isWorkDay: true
    });
  } catch (err) {
    console.error('ERROR fetching schedule:', err);
    res.status(500).json({ error: 'Error fetching schedule' });
  }
});

app.post('/config/schedule', async (req, res) => {
  try {
    const { scheduleDate, timeEntrance, timeExit, isWorkDay, description } = req.body;
    
    await db.query(`
      INSERT INTO CompanySchedule (scheduleDate, timeEntrance, timeExit, isWorkDay, description)
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
    res.status(500).json({ error: 'Error saving schedule' });
  }
});

// 3. EXCLUSIONES DE USUARIOS
app.post('/config/user-exclusion', async (req, res) => {
  try {
    const { userId, excDate, reason, type, excFrom, excTo } = req.body;
    
    await db.query(`
      INSERT INTO UserExclusions (userId, excDate, reason, type, excFrom, excTo)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [userId, excDate, reason, type, excFrom || null, excTo || null]);
    
    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR creating exclusion:', err);
    res.status(500).json({ error: 'Error creating exclusion' });
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
  if (!datetimeStr) return null;
  return datetimeStr.split(' ')[1].substring(0, 5); // HH:mm
}

// 4. LISTA DE ASISTENCIA DIARIA - MEJORADO CON TOLERANCIA
app.get('/attendance/:date', async (req, res) => {
  try {
    const { date } = req.params; // YYYY-MM-DD
    const tolerance = req.query.tolerance || 10; // minutos
    const scheduleTime = req.query.scheduleTime || '07:00'; // HH:mm
    
    // PASO 1: Obtener todos los usuarios (excepto ficticios)
    const [users] = await db.query(`
      SELECT USERID, Badgenumber, Name
      FROM \`users\`
      WHERE USERID > 10
      ORDER BY Name
    `);
    
    // PASO 2: Obtener horario configurado del día (si existe)
    const [scheduleRows] = await db.query(`
      SELECT timeEntrance, timeExit, isWorkDay
      FROM \`companyschedule\`
      WHERE scheduleDate = ?
    `, [date]);
    
    const schedule = scheduleRows[0] || {
      timeEntrance: scheduleTime + ':00',
      timeExit: '13:40:00',
      isWorkDay: true
    };
    
    const entranceTime = extractTime(schedule.timeEntrance) || scheduleTime;
    const entranceMinutes = timeToMinutes(entranceTime);
    const toleranceMinutes = parseInt(tolerance);
    
    // PASO 3: Obtener TODOS los fichajes del día
    const [checkins] = await db.query(`
      SELECT USERID, CHECKTIME
      FROM \`checkins\`
      WHERE DATE(CHECKTIME) = ?
        AND USERID > 10
      ORDER BY USERID, CHECKTIME
    `, [date]);
    
    // PASO 4: Obtener exclusiones del día
    const [exclusions] = await db.query(`
      SELECT userId, reason, type
      FROM \`userexclusions\`
      WHERE excDate = ?
    `, [date]);
    
    // PASO 5: Agrupar fichajes por usuario
    const checkinsByUser = {};
    checkins.forEach(c => {
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
        checkins: userCheckins, // TODOS los fichajes
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
    console.error('ERROR in /attendance/:date', err);
    res.status(500).json({ error: 'Error fetching attendance', details: err.message });
  }
});

// 5. REPORTE DE MOVIMIENTOS (Salidas Particulares, Oficiales, Campaña)
app.get('/movements/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    // Obtener usuarios especiales y sus funciones
    const [specialUsers] = await db.query(`
      SELECT * FROM SpecialUsers WHERE isActive = TRUE
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
      JOIN Users u ON c.USERID = u.USERID
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
    res.status(500).json({ error: 'Error fetching movements' });
  }
});
/* ===============================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Backend escuchando en puerto', PORT);
});