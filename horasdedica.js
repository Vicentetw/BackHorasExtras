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

// Normalizo la fecha para que no de error agregar en forma manual
function toMySQLDatetime(value) {
  if (!value) return null;

  // Acepta ISO string o Date
  const d = new Date(value);
  if (isNaN(d)) return null;

  return d.toISOString().slice(0, 19).replace('T', ' ');
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

    for (const r of records) {
      try {
        if (!r.USERID || !r.CHECKTIME) {
          skipped++;
          continue;
        }

        const checktime = parseCheckTime(r.CHECKTIME);
        if (!checktime) {
          skipped++;
          continue;
        }

        await db.query(
          `INSERT INTO Checkins (USERID, CHECKTIME)
           VALUES (?, ?)`,
          [Number(r.USERID), checktime]
        );

        inserted++;
      } catch (rowErr) {
        console.error('ROW ERROR:', r, rowErr.message);
        errors++;
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

/* ===============================
   DATA PARA INFORME
================================ */
app.get('/data', async (req, res) => {
  try {
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month requerido (YYYY-MM)' });
    }

    // 1️⃣ Usuarios
    const [users] = await db.query(
      `SELECT USERID, Badgenumber, Name
       FROM Users`
    );

    // 2️⃣ Fichajes automáticos
    const [checkins] = await db.query(
      `SELECT USERID, CHECKTIME
       FROM Checkins
       WHERE DATE_FORMAT(CHECKTIME, '%Y-%m') = ?
       ORDER BY USERID, CHECKTIME`,
      [month]
    );

    // 3️⃣ Fichajes manuales
    const [manuals] = await db.query(
      `SELECT 
         userId,
         startDatetime,
         endDatetime,
         durationMinutes,
         type,
         note
       FROM ManualEntries
       WHERE DATE_FORMAT(startDatetime, '%Y-%m') = ?
       ORDER BY userId, startDatetime`,
      [month]
    );

    res.json({
      users,
      checkins,
      manuals
    });

  } catch (err) {
    console.error('DATA ERROR:', err);
    res.status(500).json({ error: 'Error backend' });
  }
});


/* ===============================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Backend escuchando en puerto', PORT);
});
