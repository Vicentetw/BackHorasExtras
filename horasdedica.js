const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ===============================
// MySQL – Clever Cloud
// ===============================
const db = mysql.createPool({
  host: process.env.MYSQL_ADDON_HOST,
  user: process.env.MYSQL_ADDON_USER,
  password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB,
  port: process.env.MYSQL_ADDON_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// ===============================
// HEALTH CHECK (Render)
// ===============================
app.get('/', (req, res) => {
  res.send('Backend Horas Extras OK');
});

// ===============================
// IMPORTAR USERINFO.csv
// ===============================
app.post('/import/users', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Archivo no enviado' });
    }

    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      delimiter: ';',
      skip_empty_lines: true,
      trim: true
    });

    for (const r of records) {
      await db.query(
        `INSERT INTO Users (USERID, Badgenumber, Name)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           Badgenumber = VALUES(Badgenumber),
           Name = VALUES(Name)`,
        [r.USERID, r.Badgenumber, r.Name]
      );
    }

    res.json({ ok: true, imported: records.length });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error importando usuarios' });
  }
});

// ===============================
// IMPORTAR CHECKINOUT.csv
// ===============================
app.post('/import/checkins', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Archivo no enviado' });
    }

    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      delimiter: ';',
      skip_empty_lines: true,
      trim: true
    });

    for (const r of records) {
      await db.query(
        `INSERT IGNORE INTO Checkins (USERID, CHECKTIME)
         VALUES (?, ?)`,
        [r.USERID, r.CHECKTIME]
      );
    }

    res.json({ ok: true, imported: records.length });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error importando fichajes' });
  }
});

// ===============================
// OBTENER DATOS PARA INFORME
// ===============================
app.get('/data', async (req, res) => {
  try {
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month requerido (YYYY-MM)' });
    }

    const [users] = await db.query(
      `SELECT USERID, Badgenumber, Name FROM Users`
    );

    const [checkins] = await db.query(
      `SELECT USERID, CHECKTIME
       FROM Checkins
       WHERE DATE_FORMAT(CHECKTIME,'%Y-%m') = ?`,
      [month]
    );

    res.json({ users, checkins });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo datos' });
  }
});

// ===============================
// START SERVER (Render)
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Backend escuchando en puerto', PORT);
});
