const express = require('express');
const { resolveTenantId } = require('../appUserMiddleware');

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
        `SELECT u.USERID, u.Badgenumber, COALESCE(e.nombre, u.Name) AS Name
         FROM users u
         LEFT JOIN user_employee_map um ON um.USERID = u.USERID
         LEFT JOIN employees e ON e.id = um.employee_id
         WHERE u.USERID = ?`,
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
      // Bug real de seguridad (auditoria general): sin este chequeo, un
      // usuario de cualquier empresa podia cargar una exclusion (llegada
      // tarde "justificada") para el USERID de un empleado de OTRA
      // empresa -- esto alimenta DIRECTO el calculo de presentismo
      // (resolveLateJustification), asi que no es solo una lectura, es
      // poder alterar el resultado de otra empresa.
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[owner]] = await db.query(
          `SELECT e.tenant_id FROM user_employee_map m JOIN employees e ON e.id = m.employee_id WHERE m.USERID = ?`,
          [userId]
        );
        if (owner && owner.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Usuario no encontrado' });
        }
      }
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

  router.get('/user-exclusion', async (req, res) => {
    try {
      // Bug real de seguridad: sin filtro de tenant, un usuario veia las
      // exclusiones (llegadas tarde justificadas) de TODAS las empresas.
      // Los USERID sin ningun empleado vinculado se conservan (LEFT JOIN,
      // no se puede saber de que empresa son) -- solo se descartan los que
      // SI estan vinculados a un empleado de OTRA empresa.
      const effectiveTenantId = resolveTenantId(req);
      const tenantClause = effectiveTenantId !== null ? 'AND (e.tenant_id IS NULL OR e.tenant_id = ?)' : '';
      const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
      const [rows] = await db.query(`
        SELECT ue.*, u.Name, u.Badgenumber
        FROM userexclusions ue
        JOIN users u ON ue.userId = u.USERID
        LEFT JOIN user_employee_map m ON m.USERID = ue.userId
        LEFT JOIN employees e ON e.id = m.employee_id
        WHERE 1=1
        ${tenantClause}
        ORDER BY ue.excDate DESC
      `, tenantParams);
      res.json(rows);
    } catch (err) {
      console.error('ERROR fetching exclusions:', err);
      res.status(500).json({ error: 'Error fetching exclusions' });
    }
  });

  // ==========================
  // 4. TEMA DE LA APLICACIÓN
  // ==========================
  router.get('/theme', async (req, res) => {
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
      res.status(500).json({ error: 'Error fetching theme' });
    }
  });

  router.post('/theme', async (req, res) => {
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
      res.status(500).json({ error: 'Error saving theme' });
    }
  });

  return router;
};