const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(cors()); // ← ESTO arregla CORS
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
  port: process.env.MYSQL_ADDON_PORT || 3306
});

// ===============================
// TEST
// ===============================
app.get('/', (req, res) => {
  res.send('Backend OK');
});

// ===============================
// DATA PARA INFORME
// ===============================
app.get('/data', async (req, res) => {
  try {
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month requerido (YYYY-MM)' });
    }

    const [users] = await db.query(
      'SELECT USERID, Badgenumber, Name FROM Users'
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
    res.status(500).json({ error: 'Error backend' });
  }
});

// ===============================
// START (Render)
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Backend escuchando en puerto', PORT);
});
