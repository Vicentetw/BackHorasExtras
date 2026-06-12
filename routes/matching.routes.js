const express = require('express');
const router = express.Router();
const db = require('../db');
const pool = db;

/**
 * 🤖 AUTO MATCH (documento / legajo / employee_id)
 * Prioridad: employee_id (legajo) > documento
 */
router.post('/auto', async (req, res) => {
  try {
    const [employees] = await pool.query('SELECT * FROM employees');
    const [users] = await pool.query('SELECT * FROM users');

    let created = 0;

    const normalize = (val) => String(val || '').trim();

    const normalizeName = (name) => {
      return String(name || '')
        .toLowerCase()
        .replace(/,/g, '')
        .trim()
        .split(/\s+/)
        .sort()
        .join(' ');
    };

    for (const e of employees) {
      // 1. verificar si ya está matcheado
      const [exists] = await pool.query(
        'SELECT 1 FROM employee_user WHERE employee_id = ? LIMIT 1',
        [e.id]
      );

      if (exists.length > 0) continue;

      let matchedUser = null;
      let confidence = 0;
      let matchType = null;

      // 🥇 MATCH POR LEGAJO
      matchedUser = users.find(u =>
        normalize(u.Badgenumber) === normalize(e.employee_id)
      );

      if (matchedUser) {
        confidence = 100;
        matchType = 'auto_legajo';
      } else {
        // 🥈 MATCH POR NOMBRE
        matchedUser = users.find(u =>
          normalizeName(u.Name) === normalizeName(e.nombre)
        );

        if (matchedUser) {
          confidence = 70;
          matchType = 'auto_nombre';
        }
      }

      // guardar si encontró
      if (matchedUser) {
        await pool.query(
          `INSERT INTO employee_user (employee_id, user_id, match_type, confidence)
           VALUES (?, ?, ?, ?)`,
          [e.id, matchedUser.USERID, matchType, confidence]
        );

        created++;
      }
    }

    res.json({
      success: true,
      created
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📋 LISTAR MATCHING ACTUAL
 */
router.get('/', async (req, res) => {
  const [rows] = await db.query(`
    SELECT 
      u.USERID,
      u.Badgenumber,
      u.Name as user_name,
      e.id as employee_id,
      e.nombre as employee_name
    FROM user_employee_map m
    JOIN users u ON m.USERID = u.USERID
    JOIN employees e ON m.employee_id = e.id
  `);

  res.json(rows);
});

/**
 * 🔍 USUARIOS SIN MATCH
 */
router.get('/unmatched', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT e.*
    FROM employees e
    LEFT JOIN employee_user eu ON eu.employee_id = e.id
    WHERE eu.user_id IS NULL
  `);

  res.json(rows);
});

/**
 * 🔍 EMPLEADOS SIN MATCH
 */
router.get('/unmatched-employees', async (req, res) => {
  const [rows] = await db.query(`
    SELECT e.*
    FROM employees e
    LEFT JOIN user_employee_map m ON e.id = m.employee_id
    WHERE m.employee_id IS NULL
  `);

  res.json(rows);
});

/**
 * 💡 SUGERENCIAS POR NOMBRE
 */
router.get('/suggestions', async (req, res) => {
  const [rows] = await db.query(`
    SELECT 
      u.USERID,
      u.Name as user_name,
      e.id as employee_id,
      e.nombre as employee_name
    FROM Users u
    JOIN employees e
      ON u.Name LIKE CONCAT('%', SUBSTRING_INDEX(e.nombre, ',', 1), '%')
    WHERE u.USERID NOT IN (
      SELECT user_id FROM user_employee_map
    )
    LIMIT 100
  `);

  res.json(rows);
});

/**
 * ✍️ MATCH MANUAL
 */
router.post('/manual', async (req, res) => {
  try {
    const { employee_id, user_id } = req.body;

    await pool.query(
      `INSERT INTO employee_user (employee_id, user_id, match_type, confidence)
       VALUES (?, ?, 'manual', 100)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`
    );

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ❌ ELIMINAR MATCH
 */
router.delete('/:user_id', async (req, res) => {
  const { user_id } = req.params;

  await db.query(`
    DELETE FROM user_employee_map WHERE user_id = ?
  `, [user_id]);

  res.json({ ok: true });
});

/**
 * 📊 DIAGNÓSTICO COMPLETO DE MATCHING
 * GET /api/matching/diagnosis
 */
router.get('/diagnosis/report', async (req, res) => {
  try {
    // 1. Usuarios con match
    const [matched] = await db.query(`
      SELECT 
        u.USERID,
        u.Badgenumber,
        u.Name as user_name,
        e.employee_id,
        e.nombre as employee_name,
        m.match_type
      FROM user_employee_map m
      JOIN users u ON m.USERID = u.USERID
      JOIN employees e ON m.employee_id = e.id
      WHERE u.USERID > 10
      ORDER BY CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci
    `);

    // 2. Usuarios SIN match
    const [unmatchedUsers] = await db.query(`
      SELECT 
        u.USERID,
        u.Badgenumber,
        u.Name,
        CASE 
          WHEN EXISTS (SELECT 1 FROM employees WHERE CAST(employee_id AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci AND activo = 1)
            THEN 'Existe employee_id coincidente pero sin vincular'
          WHEN EXISTS (SELECT 1 FROM employees WHERE CAST(employee_id AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci)
            THEN 'Existe employee_id pero empleado inactivo'
          ELSE 'No existe employee_id coincidente'
        END as reason
      FROM users u
      LEFT JOIN user_employee_map m ON u.USERID = m.USERID
      WHERE m.USERID IS NULL
        AND u.USERID > 10
      ORDER BY CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci
    `);

    // 3. Empleados SIN match
    const [unmatchedEmployees] = await db.query(`
      SELECT 
        e.id,
        e.employee_id,
        e.nombre,
        e.documento,
        e.activo,
        CASE
          WHEN EXISTS (SELECT 1 FROM users WHERE CAST(Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(e.employee_id AS CHAR) COLLATE utf8mb4_unicode_ci AND USERID > 10)
            THEN 'Usuario existe pero no vinculado'
          ELSE 'Usuario no existe en el sistema'
        END as reason
      FROM employees e
      LEFT JOIN user_employee_map m ON e.id = m.employee_id
      WHERE m.employee_id IS NULL
        AND e.activo = 1
      ORDER BY CAST(e.employee_id AS CHAR) COLLATE utf8mb4_unicode_ci
    `);

    // 4. Estadísticas
    const [stats] = await db.query(`
      SELECT 
        (SELECT COUNT(DISTINCT USERID) FROM users WHERE USERID > 10) as total_users,
        (SELECT COUNT(DISTINCT employee_id) FROM user_employee_map) as matched_count,
        (SELECT COUNT(id) FROM employees WHERE activo = 1) as total_active_employees
    `);

    res.json({
      ok: true,
      summary: {
        total_users: stats[0].total_users,
        matched_users: matched.length,
        unmatched_users: unmatchedUsers.length,
        total_active_employees: stats[0].total_active_employees,
        unmatched_employees: unmatchedEmployees.length,
        match_percentage: ((matched.length / stats[0].total_users) * 100).toFixed(2) + '%'
      },
      data: {
        matched,
        unmatchedUsers,
        unmatchedEmployees
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Diagnosis error', details: err.message });
  }
});

/**
 * 🔧 PREDICAR MATCHING (sin ejecutar)
 * POST /api/matching/predict
 */
router.post('/predict', async (req, res) => {
  try {
    // Obtener qué se matchearía sin guardar
    const [predictions] = await db.query(`
      SELECT 
        u.USERID,
        u.Badgenumber as user_badgenumber,
        u.Name as user_name,
        e.id as employee_id,
        e.employee_id as emp_legajo,
        e.nombre as employee_name,
        'employee_id' as match_type
      FROM users u
      JOIN employees e 
        ON CAST(TRIM(u.Badgenumber) AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(TRIM(e.employee_id) AS CHAR) COLLATE utf8mb4_unicode_ci
      WHERE u.USERID > 10
        AND e.activo = 1
        AND u.USERID NOT IN (SELECT USERID FROM user_employee_map)
    `);

    res.json({
      ok: true,
      would_match: predictions.length,
      predictions: predictions
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Prediction error' });
  }
});

module.exports = router;