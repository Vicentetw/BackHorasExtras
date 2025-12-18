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
          `INSERT INTO Checkins (USERID, CHECKTIME) VALUES ?`,
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

//format date 
function formatDateLocal(d) {
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function formatTimeLocal(d) {
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0') + ':' +
         String(d.getSeconds()).padStart(2, '0');
}



/* ===============================
   DATA PARA INFORME
================================ */
app.get('/data', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) {
      return res.status(400).json({ error: 'month requerido (YYYY-MM)' });
    }

    const [users] = await db.query(`
      SELECT USERID, Badgenumber, Name
      FROM Users
    `);

    const [checkins] = await db.query(`
      SELECT USERID, CHECKTIME
      FROM Checkins
      WHERE DATE_FORMAT(CHECKTIME, '%Y-%m') = ?
      ORDER BY USERID, CHECKTIME
    `, [month]);

    // ======================
    // UTILIDADES
    // ======================
    const MIN_1340 = 13 * 60 + 40;
    const MAX_1415 = 14 * 60 + 15;

    const minOfDay = d =>
      d.getHours() * 60 + d.getMinutes();

    const diffMinutes = (a, b) =>
      (b - a) / 60000;

    function limpiarNueves(arr) {
      const out = [];
      for (const f of arr) {
        const prev = out[out.length - 1];
        if (f.USERID == 9 && prev && prev.USERID == 9) continue;
        out.push(f);
      }
      return out;
    }

    // ======================
    // AGRUPAR POR USUARIO + DÍA
    // ======================
    const map = {};
    for (const c of checkins) {
      const d = new Date(c.CHECKTIME);
      const key = `${c.USERID}_${formatDateLocal(d)}`;
      if (!map[key]) map[key] = [];
      map[key].push({ ...c, d });
    }

    const horasExtra = [];

    for (const key in map) {
      let fichajes = map[key];
      fichajes.sort((a, b) => a.d - b.d);
      fichajes = limpiarNueves(fichajes);

      let inicioHE = null;

      // -------- Regla A: 9 → usuario
      for (let i = 1; i < fichajes.length; i++) {
        const prev = fichajes[i - 1];
        const cur = fichajes[i];
        if (
          prev.USERID == 9 &&
          cur.USERID != 9 &&
          minOfDay(cur.d) >= MIN_1340
        ) {
          inicioHE = cur.d;
          break;
        }
      }

      // -------- Regla B: segundo fichaje 13:40–14:15
      if (!inicioHE) {
        const ventana = fichajes.filter(f => {
          const m = minOfDay(f.d);
          return f.USERID != 9 && m >= MIN_1340 && m <= MAX_1415;
        });
        if (ventana.length >= 2) {
          inicioHE = ventana[1].d;
        }
      }

      if (!inicioHE) continue;

      const finHE = fichajes[fichajes.length - 1].d;
      const dur = Math.max(0, diffMinutes(inicioHE, finHE));

      const user = users.find(u => u.USERID == fichajes[0].USERID);

      horasExtra.push({
        Fecha: formatDateLocal(inicioHE),
        USERID: fichajes[0].USERID,
        Badgenumber: user?.Badgenumber || '',
        Nombre: user?.Name || '',
        InicioHE: formatTimeLocal(inicioHE),
        FinHE: formatTimeLocal(finHE),
        Duracion: `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}`,
        DuracionMinutos: Math.round(dur),
        Manual: false,
        Detalle: 'HE válida'
      });
    }

    res.json({ horasExtra });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error backend' });
  }
});



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
