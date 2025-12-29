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

// Función para parsear fechas de checkins sin convertir a UTC
function parseCheckTimeArgentina(value) {
  if (!value) return null;

  if (value.includes('/')) { // DD/MM/YYYY HH:mm
    const [date, time] = value.split(' ');
    const [dd, mm, yyyy] = date.split('/');
    return `${yyyy}-${mm}-${dd} ${time}:00`; // se guarda tal cual
  }

  if (value.includes('-')) { // YYYY-MM-DD HH:mm o HH:mm:ss
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

    const batchSize = 50;
    let batch = [];

    for (const r of records) {
      if (!r.USERID || !r.CHECKTIME) {
        skipped++;
        continue;
      }

      const checktime = parseCheckTimeArgentina(r.CHECKTIME);
      if (!checktime) {
        skipped++;
        continue;
      }

      batch.push([Number(r.USERID), checktime]);

      if (batch.length >= batchSize) {
        try {
          await db.query(
            `INSERT INTO Checkins (USERID, CHECKTIME) VALUES ?`,
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
      SELECT USERID, CHECKTIME
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
