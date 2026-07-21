const express = require('express');
const router = express.Router();
const db = require('../db');
const pool = db;

const normalizeValue = (val) => String(val || '').trim().toLowerCase();

const normalizeName = (name) => {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/,/g, '')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
};

const findMatchingUserForEmployee = (employee, users) => {
  const candidateIds = [employee.employee_id, employee.legajo_alt]
    .filter(Boolean)
    .map(normalizeValue);

  const directMatch = users.find(u => candidateIds.includes(normalizeValue(u.Badgenumber)));
  if (directMatch) {
    return { matchedUser: directMatch, confidence: 100, matchType: 'auto_legajo' };
  }

  const nameMatch = users.find(u => normalizeName(u.Name) === normalizeName(employee.nombre));
  if (nameMatch) {
    return { matchedUser: nameMatch, confidence: 70, matchType: 'auto_nombre' };
  }

  return null;
};

/**
 * 🤖 AUTO MATCH (documento / legajo / employee_id)
 * Prioridad: employee_id (legajo) > nombre
 */
router.post('/auto', async (req, res) => {
  try {
    const [predictions] = await pool.query(`
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
      success: true,
      would_match: predictions.length,
      predictions
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
    SELECT u.*
    FROM users u
    LEFT JOIN user_employee_map m ON u.USERID = m.USERID
    WHERE m.USERID IS NULL
      AND u.USERID > 10
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
    FROM users u
    JOIN employees e
      ON u.Name LIKE CONCAT('%', SUBSTRING_INDEX(e.nombre, ',', 1), '%')
    WHERE u.USERID NOT IN (
      SELECT USERID FROM user_employee_map
    )
    LIMIT 100
  `);

  res.json(rows);
});

/**
 * ✍️ MATCH MANUAL (un usuario con un empleado)
 */
router.post('/manual', async (req, res) => {
  try {
    const payloadUserId = req.body.user_id ?? req.body.userId;
    const payloadEmployeeId = req.body.employee_id ?? req.body.employeeId;
    const employeeId = Number(payloadEmployeeId);
    const userId = Number(payloadUserId);

    if (!Number.isFinite(employeeId) || !Number.isFinite(userId) || employeeId <= 0 || userId <= 0) {
      return res.status(400).json({ error: 'employee_id/user_id o employeeId/userId son requeridos y deben ser números válidos' });
    }

    await pool.query(
      `DELETE FROM user_employee_map WHERE USERID = ? OR employee_id = ?`,
      [userId, employeeId]
    );

    await pool.query(
      `INSERT INTO user_employee_map (USERID, employee_id, match_type)
       VALUES (?, ?, 'manual')`,
      [userId, employeeId]
    );

    res.json({ success: true, employeeId, userId });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🧩 MATCH MANUAL POR PENDIENTES (legajo/employee_id)
 */
router.post('/manual-bulk', async (req, res) => {
  try {
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

    res.json({ success: true, created: 0, matches: predictions, would_match: predictions.length });
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
    DELETE FROM user_employee_map WHERE USERID = ?
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
    // checkinCount es la clave para priorizar: el reloj suele acumular
    // usuarios "basura" cargados mal y nunca usados (0 fichajes). Sin este
    // dato, un usuario real sin vincular (con fichajes reales perdidos del
    // presentismo) queda escondido entre docenas de duplicados irrelevantes.
    const [unmatchedUsers] = await db.query(`
      SELECT
        u.USERID,
        u.Badgenumber,
        u.Name,
        (SELECT COUNT(*) FROM Checkins c WHERE c.USERID = u.USERID) as checkinCount,
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
      ORDER BY checkinCount DESC, CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci
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