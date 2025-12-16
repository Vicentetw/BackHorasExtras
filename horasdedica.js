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

    for (const r of records) {
      if (!r.USERID || !r.CHECKTIME) continue;

      const checktime = parseCheckTime(r.CHECKTIME);
if (!checktime) continue;

await db.query(
  `INSERT INTO Checkins (USERID, CHECKTIME)
   VALUES (?, ?)`,
  [Number(r.USERID), checktime]
);


      inserted++;
    }

    res.json({ ok: true, checkins: inserted });

  } catch (err) {
    console.error('IMPORT CHECKINS ERROR:', err);
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

    const [users] = await db.query(
      `SELECT USERID, Badgenumber, Name
       FROM Users`
    );

    const [checkins] = await db.query(
      `SELECT USERID, CHECKTIME
       FROM Checkins
       WHERE DATE_FORMAT(CHECKTIME, '%Y-%m') = ?
       ORDER BY USERID, CHECKTIME`,
      [month]
    );

    res.json({ users, checkins });

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
