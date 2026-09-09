const express = require('express');
const router = express.Router();
const db = require('../db');
const pool = db;
const { resolveTenantId, requirePermission } = require('../appUserMiddleware');

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

// Bug real de seguridad (auditoria general): esta consulta se repetia 3
// veces (/auto, /manual-bulk, /predict) SIN ningun filtro de tenant --
// cualquier usuario con permiso 'matching:read' de CUALQUIER empresa veia
// los "would_match" (nombre, legajo, badge) de TODOS los empleados de
// TODAS las empresas. Se extrae a una sola funcion, con el mismo tenant
// filter que ya usaba /manual (el unico de los 6 endpoints de matching
// que SI lo tenia).
// Fase 19: users/user_employee_map ya no son unicos solo por USERID (dos
// empresas pueden compartir el mismo USERID crudo de reloj, migracion
// 20260909) -- se suma u.tenant_id = e.tenant_id al JOIN (para no
// proponer el usuario crudo de OTRA empresa como match) y el "ya
// vinculado" se chequea tambien por tenant (un USERID ya vinculado en
// OTRA empresa no cuenta como vinculado para esta).
async function findAutoMatchPredictions(effectiveTenantId) {
  const tenantClause = effectiveTenantId !== null ? 'AND e.tenant_id = ? AND u.tenant_id = ?' : '';
  const params = effectiveTenantId !== null ? [effectiveTenantId, effectiveTenantId] : [];
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
      AND u.tenant_id = e.tenant_id
    WHERE u.USERID > 10
      AND e.activo = 1
      ${tenantClause}
      AND NOT EXISTS (SELECT 1 FROM user_employee_map m WHERE m.USERID = u.USERID AND m.tenant_id = u.tenant_id)
  `, params);
  return predictions;
}

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
router.post('/auto', requirePermission('matching', 'read'), async (req, res) => {
  try {
    const predictions = await findAutoMatchPredictions(resolveTenantId(req));

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
router.get('/', requirePermission('matching', 'read'), async (req, res) => {
  try {
    // Bug real de seguridad (auditoria general): sin este filtro, un usuario
    // de cualquier empresa veia la tabla de matching COMPLETA -- nombre,
    // legajo y badge de los empleados de TODAS las empresas, no solo la suya.
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'WHERE m.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
    const [rows] = await db.query(`
      SELECT
        u.USERID,
        u.Badgenumber,
        u.Name as user_name,
        e.id as employee_id,
        e.nombre as employee_name
      FROM user_employee_map m
      JOIN users u ON m.USERID = u.USERID AND m.tenant_id = u.tenant_id
      JOIN employees e ON m.employee_id = e.id
      ${tenantClause}
    `, tenantParams);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔍 USUARIOS SIN MATCH
 * NOTA: ruta vieja, NO la llama el frontend actual (usa /diagnosis/report)
 * -- se deja filtrada igual por si algo la vuelve a usar.
 */
router.get('/unmatched', requirePermission('matching', 'read'), async (req, res) => {
  try {
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND u.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
    const [rows] = await pool.query(`
      SELECT u.*
      FROM users u
      LEFT JOIN user_employee_map m ON u.USERID = m.USERID AND m.tenant_id = u.tenant_id
      WHERE m.USERID IS NULL
        AND u.USERID > 10
        ${tenantClause}
    `, tenantParams);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔍 EMPLEADOS SIN MATCH
 */
router.get('/unmatched-employees', requirePermission('matching', 'read'), async (req, res) => {
  try {
    // Bug real de seguridad: sin filtro de tenant, mostraba empleados SIN
    // MATCH de todas las empresas.
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND e.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];
    const [rows] = await db.query(`
      SELECT e.*
      FROM employees e
      LEFT JOIN user_employee_map m ON e.id = m.employee_id
      WHERE m.employee_id IS NULL
      ${tenantClause}
    `, tenantParams);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 💡 SUGERENCIAS POR NOMBRE
 */
router.get('/suggestions', requirePermission('matching', 'read'), async (req, res) => {
  try {
    // Bug real de seguridad: sin filtro de tenant, sugeria matches contra
    // empleados de CUALQUIER empresa, no solo la del que pide.
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND e.tenant_id = ? AND u.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId, effectiveTenantId] : [];
    // Bug real de datos, encontrado al escribir el test de arriba (no
    // relacionado con tenant): users.Name y employees.nombre tienen
    // COLLATION distinta en esta base (utf8mb4_0900_ai_ci vs
    // utf8mb4_unicode_ci) -- MySQL rechaza comparar strings de collations
    // distintas con LIKE ("Illegal mix of collations"). Esta ruta nunca
    // devolvia nada, siempre tiraba 500 -- no era una funcionalidad rota a
    // medias, estaba completamente inutilizable.
    const [rows] = await db.query(`
      SELECT
        u.USERID,
        u.Name as user_name,
        e.id as employee_id,
        e.nombre as employee_name
      FROM users u
      JOIN employees e
        ON u.Name COLLATE utf8mb4_unicode_ci LIKE CONCAT('%', SUBSTRING_INDEX(e.nombre, ',', 1), '%')
      WHERE NOT EXISTS (
        SELECT 1 FROM user_employee_map m WHERE m.USERID = u.USERID AND m.tenant_id = u.tenant_id
      )
      ${tenantClause}
      LIMIT 100
    `, tenantParams);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✍️ MATCH MANUAL (un usuario con un empleado)
 */
router.post('/manual', requirePermission('matching', 'create'), async (req, res) => {
  try {
    const payloadUserId = req.body.user_id ?? req.body.userId;
    const payloadEmployeeId = req.body.employee_id ?? req.body.employeeId;
    const employeeId = Number(payloadEmployeeId);
    const userId = Number(payloadUserId);

    if (!Number.isFinite(employeeId) || !Number.isFinite(userId) || employeeId <= 0 || userId <= 0) {
      return res.status(400).json({ error: 'employee_id/user_id o employeeId/userId son requeridos y deben ser números válidos' });
    }

    const effectiveTenantId = resolveTenantId(req);
    // El tenant real del vinculo SIEMPRE es el de employees (fuente de
    // verdad) -- se busca siempre, no solo cuando effectiveTenantId no es
    // null, porque hace falta igual para el INSERT de mas abajo
    // (user_employee_map.tenant_id ya es NOT NULL, migracion 20260909).
    const [[employee]] = await pool.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
    if (!employee) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    if (effectiveTenantId !== null && employee.tenant_id !== effectiveTenantId) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    const targetTenantId = employee.tenant_id;

    // Fase 19: el DELETE anterior borraba por USERID solo -- con USERID ya
    // no unico entre empresas (migracion 20260909), eso podria borrar el
    // vinculo de OTRA empresa que comparta el mismo USERID crudo. Se suma
    // tenant_id = targetTenantId en las dos ramas del OR.
    await pool.query(
      `DELETE FROM user_employee_map WHERE (USERID = ? AND tenant_id = ?) OR employee_id = ?`,
      [userId, targetTenantId, employeeId]
    );

    await pool.query(
      `INSERT INTO user_employee_map (USERID, employee_id, match_type, tenant_id)
       VALUES (?, ?, 'manual', ?)`,
      [userId, employeeId, targetTenantId]
    );

    res.json({ success: true, employeeId, userId });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🧩 MATCH MANUAL POR PENDIENTES (legajo/employee_id)
 */
router.post('/manual-bulk', requirePermission('matching', 'read'), async (req, res) => {
  try {
    const predictions = await findAutoMatchPredictions(resolveTenantId(req));
    res.json({ success: true, created: 0, matches: predictions, would_match: predictions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ❌ ELIMINAR MATCH
 */
router.delete('/:user_id', requirePermission('matching', 'delete'), async (req, res) => {
  const { user_id } = req.params;

  // Bug real de seguridad (el mas serio de este archivo): SIN NINGUN
  // chequeo de tenant, un usuario de cualquier empresa podia desvincular
  // el match de un empleado de OTRA empresa con solo conocer/adivinar su
  // USERID (de reloj, no muy dificil de barrer) -- le rompia el
  // presentismo a otra empresa sin que nadie lo note hasta mucho despues.
  const effectiveTenantId = resolveTenantId(req);
  // Se busca siempre (no solo si effectiveTenantId no es null) -- hace
  // falta el tenant_id real del vinculo para escopar bien el DELETE de
  // abajo, USERID solo ya no alcanza para identificarlo sin ambiguedad.
  const [[existing]] = await db.query(
    `SELECT m.tenant_id FROM user_employee_map m JOIN employees e ON e.id = m.employee_id WHERE m.USERID = ? AND m.tenant_id = e.tenant_id ${effectiveTenantId !== null ? 'AND e.tenant_id = ?' : ''}`,
    effectiveTenantId !== null ? [user_id, effectiveTenantId] : [user_id]
  );
  if (!existing) {
    return res.status(404).json({ error: 'Match no encontrado' });
  }

  // Fase 19: USERID ya no es unico entre empresas (migracion 20260909) --
  // sin AND tenant_id, esto borraria TAMBIEN el vinculo de otra empresa
  // que comparta el mismo USERID crudo.
  await db.query(`
    DELETE FROM user_employee_map WHERE USERID = ? AND tenant_id = ?
  `, [user_id, existing.tenant_id]);

  res.json({ ok: true });
});

/**
 * 📊 DIAGNÓSTICO COMPLETO DE MATCHING
 * GET /api/matching/diagnosis
 */
router.get('/diagnosis/report', requirePermission('matching', 'read'), async (req, res) => {
  try {
    const effectiveTenantId = resolveTenantId(req);
    const tenantClause = effectiveTenantId !== null ? 'AND e.tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];

    // 1. Usuarios con match (solo de empleados de mi empresa)
    const [matched] = await db.query(`
      SELECT
        u.USERID,
        u.Badgenumber,
        u.Name as user_name,
        e.employee_id,
        e.nombre as employee_name,
        m.match_type
      FROM user_employee_map m
      JOIN users u ON m.USERID = u.USERID AND m.tenant_id = u.tenant_id
      JOIN employees e ON m.employee_id = e.id
      WHERE u.USERID > 10
      ${tenantClause}
      ORDER BY CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci
    `, tenantParams);

    // 2. Usuarios SIN match
    // checkinCount es la clave para priorizar: el reloj suele acumular
    // usuarios "basura" cargados mal y nunca usados (0 fichajes). Sin este
    // dato, un usuario real sin vincular (con fichajes reales perdidos del
    // presentismo) queda escondido entre docenas de duplicados irrelevantes.
    //
    // Bug real de seguridad CONFIRMADO EN VIVO (re-auditoria 9 sep 2026):
    // esta lista mostraba nombre/legajo de usuarios crudos de TODAS las
    // empresas mezclados -- el comentario viejo decia "users/Checkins no
    // tienen tenant_id propio... la lista en si sigue siendo global a
    // proposito", una decision que tenia sentido para una sola empresa con
    // varios relojes propios, pero filtraba nombres reales de una empresa
    // a otra en cuanto hubiera una segunda empresa real. Ahora que users
    // SI tiene tenant_id (migracion 20260909), se filtra de verdad.
    const unmatchedTenantClause = effectiveTenantId !== null ? 'AND u.tenant_id = ? AND tenant_id = ?' : '';
    const unmatchedParams = effectiveTenantId !== null
      ? [effectiveTenantId, effectiveTenantId, effectiveTenantId]
      : [];
    const [unmatchedUsers] = await db.query(`
      SELECT
        u.USERID,
        u.Badgenumber,
        u.Name,
        (SELECT COUNT(*) FROM Checkins c WHERE c.USERID = u.USERID AND c.tenant_id = u.tenant_id) as checkinCount,
        CASE
          WHEN EXISTS (SELECT 1 FROM employees WHERE CAST(employee_id AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci AND activo = 1 ${effectiveTenantId !== null ? 'AND tenant_id = ?' : ''})
            THEN 'Existe employee_id coincidente pero sin vincular'
          WHEN EXISTS (SELECT 1 FROM employees WHERE CAST(employee_id AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci ${effectiveTenantId !== null ? 'AND tenant_id = ?' : ''})
            THEN 'Existe employee_id pero empleado inactivo'
          ELSE 'No existe employee_id coincidente'
        END as reason
      FROM users u
      LEFT JOIN user_employee_map m ON u.USERID = m.USERID AND m.tenant_id = u.tenant_id
      WHERE m.USERID IS NULL
        AND u.USERID > 10
        ${effectiveTenantId !== null ? 'AND u.tenant_id = ?' : ''}
      ORDER BY checkinCount DESC, CAST(u.Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci
    `, effectiveTenantId !== null ? [effectiveTenantId, effectiveTenantId, effectiveTenantId] : []);

    // 3. Empleados SIN match
    const [unmatchedEmployees] = await db.query(`
      SELECT
        e.id,
        e.employee_id,
        e.nombre,
        e.documento,
        e.activo,
        CASE
          WHEN EXISTS (SELECT 1 FROM users WHERE CAST(Badgenumber AS CHAR) COLLATE utf8mb4_unicode_ci = CAST(e.employee_id AS CHAR) COLLATE utf8mb4_unicode_ci AND USERID > 10 ${effectiveTenantId !== null ? 'AND tenant_id = ?' : ''})
            THEN 'Usuario existe pero no vinculado'
          ELSE 'Usuario no existe en el sistema'
        END as reason
      FROM employees e
      LEFT JOIN user_employee_map m ON e.id = m.employee_id
      WHERE m.employee_id IS NULL
        AND e.activo = 1
        ${tenantClause}
      ORDER BY CAST(e.employee_id AS CHAR) COLLATE utf8mb4_unicode_ci
    `, effectiveTenantId !== null ? [effectiveTenantId, effectiveTenantId] : []);

    // 4. Estadísticas
    const activeEmployeesTenantClause = effectiveTenantId !== null ? 'AND tenant_id = ?' : '';
    const [stats] = await db.query(`
      SELECT
        (SELECT COUNT(DISTINCT USERID) FROM users WHERE USERID > 10 ${effectiveTenantId !== null ? 'AND tenant_id = ?' : ''}) as total_users,
        (SELECT COUNT(DISTINCT employee_id) FROM user_employee_map ${effectiveTenantId !== null ? 'WHERE tenant_id = ?' : ''}) as matched_count,
        (SELECT COUNT(id) FROM employees WHERE activo = 1 ${activeEmployeesTenantClause}) as total_active_employees
    `, effectiveTenantId !== null ? [effectiveTenantId, effectiveTenantId, effectiveTenantId] : []);

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
router.post('/predict', requirePermission('matching', 'read'), async (req, res) => {
  try {
    const predictions = await findAutoMatchPredictions(resolveTenantId(req));

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