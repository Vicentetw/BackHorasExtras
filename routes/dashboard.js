const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  // ==========================
  // 1. OBTENER/CREAR CONFIGURACIÓN DE USUARIOS ESPECIALES
  // ==========================
  router.get('/special-users', async (req, res) => {
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
      res.status(500).json({ error: 'Error fetching special users' });
    }
  });

  router.post('/special-users', async (req, res) => {
    try {
      const { userId, category, function: func } = req.body;
      const [user] = await db.query(
        `SELECT USERID, Badgenumber, Name FROM users WHERE USERID = ?`,
        [userId]
      );
      if (user.length === 0) return res.status(400).json({ error: 'Usuario no encontrado' });

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
      res.status(500).json({ error: 'Error configurando usuario especial' });
    }
  });

  // ==========================
  // 2. HORARIO EMPRESA
  // ==========================
  router.get('/schedule/:date', async (req, res) => {
    try {
      const { date } = req.params;
      const [schedule] = await db.query(`SELECT * FROM companyschedule WHERE scheduleDate = ?`, [date]);
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

  router.post('/schedule', async (req, res) => {
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
      res.status(500).json({ error: 'Error saving schedule' });
    }
  });

  // ==========================
  // 3. EXCLUSIONES DE USUARIOS
  // ==========================
  router.post('/user-exclusion', async (req, res) => {
    try {
      const { userId, excDate, reason, type, excFrom, excTo } = req.body;
      await db.query(`
        INSERT INTO userexclusions (userId, excDate, reason, type, excFrom, excTo)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, excDate, reason, type, excFrom || null, excTo || null]);
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR creating exclusion:', err);
      res.status(500).json({ error: 'Error creating exclusion' });
    }
  });

  return router;
};
router.get('/user-exclusion', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ue.*, u.Name, u.Badgenumber
      FROM userexclusions ue
      JOIN users u ON ue.userId = u.USERID
      ORDER BY ue.excDate DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('ERROR fetching exclusions:', err);
    res.status(500).json({ error: 'Error fetching exclusions' });
  }
});