const express = require('express');
const router = express.Router();
const db = require('../db');
const { resolveTenantId, requirePermission, requireActiveSubscription } = require('../appUserMiddleware');
const billingRepo = require('../motor-laboral/repositories/billingRepository');

// NOTE: Automatic employee->user sync has been disabled.
// Matching now requires explicit approval via the matching dashboard.

/**
 * 📋 LISTAR EMPLEADOS
 * GET /api/employees
 * Query params: page, limit, search, status, sortBy
 */
router.get('/', requirePermission('employees', 'read'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const rawLimit = req.query.limit;
    let limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 10;
    const fetchAll = rawLimit === '0' || String(rawLimit).toLowerCase() === 'all';
    if (fetchAll) {
      limit = null;
    } else if (isNaN(limit) || limit < 1) {
      limit = 10;
    } else {
      limit = Math.min(1000, limit);
    }

    const search = req.query.search || '';
    const status = req.query.status; // '1' para activos, '0' para inactivos
    const sortBy = req.query.sortBy || 'nombre'; // nombre, employee_id, fecha_alta

    const offset = limit !== null ? (page - 1) * limit : 0;

    // Construir WHERE
    const whereClauses = [];
    const params = [];

    if (search) {
      whereClauses.push('(nombre LIKE ? OR documento LIKE ? OR employee_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Busqueda exacta por legajo -- usada por el pre-chequeo de "ya existe"
    // del import de employees-v2.html/EmployeesPage antes de crear cada fila.
    // No existia hasta ahora: el query param se mandaba pero el backend lo
    // ignoraba en silencio, asi que ese chequeo siempre terminaba comparando
    // contra la primera fila de la pagina por defecto (cualquiera), no
    // contra el legajo real -- avisaba "ya existe" con el nombre equivocado
    // en pricticamente cualquier import.
    const employeeIdParam = req.query.employee_id;
    if (employeeIdParam !== undefined) {
      whereClauses.push('employee_id = ?');
      params.push(employeeIdParam);
    }

    if (status !== undefined) {
      whereClauses.push(status === '1' ? 'activo = 1' : 'activo = 0');
    }

    const authorized = req.query.authorized;
    if (authorized !== undefined) {
      const authValue = authorized === '1' || authorized === 'true';
      whereClauses.push(authValue ? 'overtime_authorized = 1' : 'overtime_authorized = 0');
    }

    const excluded = req.query.excluded;
    if (excluded !== undefined) {
      const excludeValue = excluded === '1' || excluded === 'true';
      whereClauses.push(excludeValue ? 'exclude_from_report = 1' : 'exclude_from_report = 0');
    }

    // Fecha del ULTIMO fichaje de cada empleado -- usado tanto para el
    // filtro ?inactiveDays como para mostrar la columna "días sin fichar"
    // en /empleados (pedido real). El JOIN de Checkins.USERID contra
    // users tiene que contemplar 2 caminos (coincide con USERID directo, o
    // el reloj mando el Badgenumber como si fuera el USERID) -- la version
    // vieja de esto (ver git blame) hacia `CAST(a) = CAST(b)` en el JOIN,
    // lo que le impide a MySQL usar CUALQUIER indice (forzaba un table scan
    // por cada empleado via subquery correlacionada -- 8+ segundos con
    // ~480 empleados reales). Separando en 2 LEFT JOIN + COALESCE, cada uno
    // puede usar su propio indice (PRIMARY en USERID, unique_badgenumber en
    // Badgenumber), y el agregado se calcula UNA sola vez (no una vez por
    // empleado) -- mismo resultado, ~137ms verificado contra los datos
    // reales (0 diferencias fila por fila contra la version vieja).
    // OJO: la columna del derivado se llama "emp_pk" a proposito, NUNCA
    // "employee_id" -- employees.employee_id es el LEGAJO (texto/numero
    // que carga el usuario), una columna totalmente distinta a employees.id
    // (la PK real). Un nombre igual rompia con "Column 'employee_id' in
    // where clause is ambiguous" apenas alguien filtraba por legajo (bug
    // propio encontrado escribiendo este mismo cambio).
    const lastCheckinJoin = `
      LEFT JOIN (
        SELECT uem.employee_id AS emp_pk, MAX(c.CHECKTIME) AS last_checkin
        FROM Checkins c
        LEFT JOIN users u_direct ON u_direct.USERID = c.USERID
        LEFT JOIN users u_badge ON u_badge.Badgenumber = CAST(c.USERID AS CHAR)
        JOIN user_employee_map uem ON uem.USERID = COALESCE(u_direct.USERID, u_badge.USERID)
        GROUP BY uem.employee_id
      ) lc ON lc.emp_pk = employees.id
    `;

    // ?inactiveDays=30 -- empleados sin ningun fichaje en los ultimos N dias
    // (incluye a los que nunca fichajaron). Nuevo (Fase 6.4): filtro para
    // detectar jubilados/bajas no cargadas formalmente todavia -- alguien
    // que dejo de fichar hace meses pero sigue "activo" en el sistema.
    const inactiveDays = req.query.inactiveDays;
    if (inactiveDays !== undefined && !isNaN(parseInt(inactiveDays, 10))) {
      whereClauses.push('(lc.last_checkin IS NULL OR lc.last_checkin < DATE_SUB(CURDATE(), INTERVAL ? DAY))');
      params.push(parseInt(inactiveDays, 10));
    }

    const effectiveTenantId = resolveTenantId(req);
    if (effectiveTenantId !== null) {
      whereClauses.push('tenant_id = ?');
      params.push(effectiveTenantId);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Obtener total
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM employees ${lastCheckinJoin} ${where}`,
      params
    );

    // Ordenamiento
    let orderBy = 'nombre ASC';
    switch (sortBy) {
      case 'employee_id':
        orderBy = 'CAST(employee_id AS UNSIGNED) ASC';
        break;
      case 'fecha_alta':
        orderBy = 'fecha_alta DESC';
        break;
      default:
        orderBy = 'nombre ASC';
    }

    // Obtener empleados paginados
    const querySql = limit === null
      ? `SELECT employees.*, lc.last_checkin FROM employees ${lastCheckinJoin} ${where} ORDER BY ${orderBy}`
      : `SELECT employees.*, lc.last_checkin FROM employees ${lastCheckinJoin} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    const queryParams = limit === null
      ? params
      : [...params, limit, offset];

    const [employees] = await db.query(querySql, queryParams);

    res.json({
      data: employees,
      pagination: {
        page,
        limit: limit === null ? total : limit,
        total,
        pages: limit === null ? 1 : Math.ceil(total / limit)
      }
    });

  } catch (err) {
    console.error('ERROR fetching employees:', err);
    res.status(500).json({ error: 'Error fetching employees' });
  }
});

/**
 * ➕ CREAR EMPLEADO
 * POST /api/employees
 */
// Fase 9 (venta): si a la empresa se le vencio el periodo de gracia de
// pago, no puede cargar empleados nuevos (ni uno por uno ni por Excel --
// el import de Empleados de Angular hace un POST por fila a esta misma
// ruta, no hay un endpoint de "confirmar lote" en uso hoy). Leer/editar/
// borrar los que ya tiene siguen andando -- el bloqueo es solo crecer.
router.post('/', requirePermission('employees', 'create'), requireActiveSubscription, async (req, res) => {
  try {
    const {
      employee_id,
      nombre,
      documento,
      tipo_documento,
      direccion,
      zona_id,  // Changed from zona to zona_id
      tenant_id,
      zona_real_id,
      fecha_alta,
      fecha_baja,
      activo,
      motivo_baja,
      overtime_authorized,
      payroll_regime,
      exclude_from_report,
      legajo_alt
    } = req.body;

    // Validaciones básicas
    if (!employee_id || !nombre) {
      return res.status(400).json({
        error: 'employee_id y nombre son requeridos'
      });
    }

    // El tenant_id nunca lo decide el cliente: un usuario normal solo puede
    // crear empleados para su propia empresa. Solo el superadmin puede
    // mandar un tenant_id explicito (para altas de soporte puntuales).
    const effectiveTenantId = req.appUser && !req.appUser.isSuperadmin
      ? req.appUser.tenantId
      : (tenant_id || null);

    // Fase 15 -- tope de empleados del plan contratado ("como una
    // telefonia"): hueco real encontrado por el superadmin, se pudo cargar
    // un empleado de mas de los que el plan de prueba permitia sin ningun
    // aviso. Se aplica siempre que la empresa tenga un tenant conocido --
    // incluye altas hechas por el superadmin a nombre de esa empresa (el
    // tope es del CONTRATO de la empresa, no de quien hace el alta).
    if (effectiveTenantId != null) {
      const capacity = await billingRepo.checkEmployeeCapacity(effectiveTenantId, 1, db);
      if (!capacity.allowed) {
        return res.status(409).json({
          error: `Tu plan (${capacity.planName}) permite hasta ${capacity.max} empleados y ya tenés ${capacity.current} activos. Para agregar más, cambiá a un plan superior.`,
          employeeCap: capacity
        });
      }
    }

    const normalizedDocumento = documento ? String(documento).trim() : null;

    // Verificar si ya existe employee_id
    const [existing] = await db.query(
      'SELECT id FROM employees WHERE employee_id = ?',
      [employee_id]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Ya existe un empleado con este legajo'
      });
    }

    if (normalizedDocumento) {
      const [duplicateDocumento] = await db.query(
        'SELECT id FROM employees WHERE TRIM(documento) = ? LIMIT 1',
        [normalizedDocumento]
      );
      if (duplicateDocumento.length > 0) {
        return res.status(409).json({
          error: 'Ya existe un empleado con este documento'
        });
      }
    }

    // Insertar
    const [result] = await db.query(
      `INSERT INTO employees
       (employee_id, nombre, documento, tipo_documento, direccion, zona_id, zona_real_id, fecha_alta, fecha_baja, activo, motivo_baja, overtime_authorized, payroll_regime, exclude_from_report, legajo_alt, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employee_id,
        nombre,
        normalizedDocumento || null,
        tipo_documento || 1,
        direccion || null,
        zona_id || null,  // Changed from zona to zona_id
        zona_real_id || null,
        fecha_alta || null,
        fecha_baja || null,
        activo !== undefined ? activo : true,
        motivo_baja || null,
        overtime_authorized !== undefined ? (overtime_authorized ? 1 : 0) : 1,
        payroll_regime || null,
        exclude_from_report !== undefined ? (exclude_from_report ? 1 : 0) : 0,
        legajo_alt || null,
        effectiveTenantId
      ]
    );

    const insertedId = result.insertId;

    res.json({
      ok: true,
      message: 'Empleado creado correctamente',
      id: insertedId
    });

  } catch (err) {
    console.error('ERROR creating employee:', err);
    res.status(500).json({ error: 'Error creating employee' });
  }
});

/**
 * ✏️ ACTUALIZAR EMPLEADO
 * PUT /api/employees/:id
 */
router.put('/:id', requirePermission('employees', 'update'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      employee_id,
      nombre,
      documento,
      tipo_documento,
      direccion,
      zona_id,  // Changed from zona to zona_id
      zona_real_id,
      fecha_alta,
      fecha_baja,
      activo,
      motivo_baja,
      overtime_authorized,
      payroll_regime,
      exclude_from_report,
      legajo_alt,
      tenant_id,
      category_id
    } = req.body;

    // Validaciones básicas
    if (!employee_id || !nombre) {
      return res.status(400).json({
        error: 'employee_id y nombre son requeridos'
      });
    }

    // Verificar que existe (y que pertenece a la empresa del que pide el
    // cambio -- un empleado de otra empresa se trata igual que si no
    // existiera, para no filtrar ni siquiera que existe)
    const [existing] = await db.query(
      'SELECT id, employee_id, tenant_id FROM employees WHERE id = ?',
      [id]
    );

    const belongsToTenant = existing.length > 0 && (
      !req.appUser || req.appUser.isSuperadmin || existing[0].tenant_id === req.appUser.tenantId
    );

    if (!belongsToTenant) {
      return res.status(404).json({
        error: 'Empleado no encontrado'
      });
    }

    const previousBadge = existing[0].employee_id;
    // Un usuario normal no puede mover un empleado a otra empresa; solo el
    // superadmin puede reasignar tenant_id explicitamente.
    const effectiveTenantId = req.appUser && !req.appUser.isSuperadmin
      ? existing[0].tenant_id
      : (tenant_id || null);

    // Verificar que no haya conflicto de legajo
    const normalizedDocumento = documento ? String(documento).trim() : null;

    const [conflict] = await db.query(
      'SELECT id FROM employees WHERE employee_id = ? AND id != ?',
      [employee_id, id]
    );

    if (conflict.length > 0) {
      return res.status(409).json({
        error: 'Ya existe otro empleado con este legajo'
      });
    }

    if (normalizedDocumento) {
      const [duplicateDocumento] = await db.query(
        'SELECT id FROM employees WHERE TRIM(documento) = ? AND id != ? LIMIT 1',
        [normalizedDocumento, id]
      );
      if (duplicateDocumento.length > 0) {
        return res.status(409).json({
          error: 'Ya existe otro empleado con este documento'
        });
      }
    }

    // Actualizar
    await db.query(
      `UPDATE employees SET
       employee_id = ?, nombre = ?, documento = ?, tipo_documento = ?,
       direccion = ?, zona_id = ?, zona_real_id = ?, fecha_alta = ?,
       fecha_baja = ?, activo = ?, motivo_baja = ?, overtime_authorized = ?, payroll_regime = ?, exclude_from_report = ?, legajo_alt = ?, tenant_id = ?,
       category_id = ?
       WHERE id = ?`,
      [
        employee_id,
        nombre,
        normalizedDocumento || null,
        tipo_documento || 1,
        direccion || null,
        zona_id || null,  // Changed from zona to zona_id
        zona_real_id || null,
        fecha_alta || null,
        fecha_baja || null,
        activo !== undefined ? activo : true,
        motivo_baja || null,
        overtime_authorized !== undefined ? (overtime_authorized ? 1 : 0) : 1,
        payroll_regime || null,
        exclude_from_report !== undefined ? (exclude_from_report ? 1 : 0) : 0,
        legajo_alt || null,
        effectiveTenantId,
        category_id || null,
        id
      ]
    );

    res.json({
      ok: true,
      message: 'Empleado actualizado correctamente'
    });

  } catch (err) {
    console.error('ERROR updating employee:', err);
    res.status(500).json({ error: 'Error updating employee' });
  }
});

/**
 * ✅❌ ACTIVAR/DESACTIVAR VARIOS EMPLEADOS A LA VEZ
 * PATCH /api/employees/bulk-status
 * Body: { ids: number[], activo: boolean, motivoBaja?: string }
 *
 * Pedido real: en el filtro "sin fichar hace N días" (jubilados/bajas no
 * cargadas formalmente en el sistema, ver GET / con inactiveDays), poder
 * tildar varios de la lista y marcarlos inactivos en un solo paso -- antes
 * había que editar uno por uno con el modal completo.
 */
router.patch('/bulk-status', requirePermission('employees', 'update'), async (req, res) => {
  try {
    const { ids, activo, motivoBaja } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids debe ser un array no vacío' });
    }
    if (ids.length > 1000) {
      return res.status(400).json({ error: 'Máximo 1000 empleados por lote' });
    }
    if (typeof activo !== 'boolean') {
      return res.status(400).json({ error: 'activo (boolean) es requerido' });
    }
    const numericIds = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (numericIds.length === 0) {
      return res.status(400).json({ error: 'ids inválidos' });
    }

    // Mismo criterio que PUT /:id y DELETE /:id -- un empleado de otra
    // empresa se trata como si no existiera, nunca se toca aunque su id
    // venga en la lista (ej. un id adivinado/copiado de otra pestaña).
    const [rows] = await db.query('SELECT id, tenant_id FROM employees WHERE id IN (?)', [numericIds]);
    const allowedIds = rows
      .filter((r) => !req.appUser || req.appUser.isSuperadmin || r.tenant_id === req.appUser.tenantId)
      .map((r) => r.id);

    if (allowedIds.length === 0) {
      return res.json({ ok: true, updated: 0, skipped: numericIds.length });
    }

    if (activo) {
      await db.query('UPDATE employees SET activo = 1 WHERE id IN (?)', [allowedIds]);
    } else {
      // Al desactivar en lote se registra fecha_baja (hoy) y el motivo que
      // haya escrito el usuario -- mismos campos que ya llena el modal de
      // edición individual, para no dejar una "baja" sin fecha/motivo.
      await db.query(
        'UPDATE employees SET activo = 0, fecha_baja = CURDATE(), motivo_baja = ? WHERE id IN (?)',
        [motivoBaja || null, allowedIds]
      );
    }

    res.json({ ok: true, updated: allowedIds.length, skipped: numericIds.length - allowedIds.length });
  } catch (err) {
    console.error('ERROR bulk-status employees:', err);
    res.status(500).json({ error: 'Error actualizando empleados' });
  }
});

/**
 * 🗑️ ELIMINAR EMPLEADO
 * DELETE /api/employees/:id
 */
router.delete('/:id', requirePermission('employees', 'delete'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe y pertenece a la empresa del que pide borrarlo
    const [existing] = await db.query(
      'SELECT id, tenant_id FROM employees WHERE id = ?',
      [id]
    );

    const belongsToTenant = existing.length > 0 && (
      !req.appUser || req.appUser.isSuperadmin || existing[0].tenant_id === req.appUser.tenantId
    );

    if (!belongsToTenant) {
      return res.status(404).json({
        error: 'Empleado no encontrado'
      });
    }

    // Verificar si tiene matches activos
    const [matches] = await db.query(
      'SELECT COUNT(*) as count FROM user_employee_map WHERE employee_id = ?',
      [id]
    );

    if (matches[0].count > 0) {
      return res.status(409).json({
        error: 'No se puede eliminar empleado con matches activos. Elimine primero los matches.'
      });
    }

    // Eliminar
    await db.query('DELETE FROM employees WHERE id = ?', [id]);

    res.json({
      ok: true,
      message: 'Empleado eliminado correctamente'
    });

  } catch (err) {
    console.error('ERROR deleting employee:', err);
    res.status(500).json({ error: 'Error deleting employee' });
  }
});

/**
 * 📊 OBTENER ESTADÍSTICAS
 * GET /api/employees/stats
 */
router.get('/stats', requirePermission('employees', 'read'), async (req, res) => {
  try {
    const effectiveTenantId = resolveTenantId(req);
    const tenantWhere = effectiveTenantId !== null ? 'WHERE tenant_id = ?' : '';
    const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];

    const [stats] = await db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN activo = 0 THEN 1 ELSE 0 END) as inactive,
        SUM(CASE WHEN overtime_authorized = 1 THEN 1 ELSE 0 END) as authorized,
        SUM(CASE WHEN overtime_authorized = 0 THEN 1 ELSE 0 END) as unauthorized,
        SUM(CASE WHEN exclude_from_report = 1 THEN 1 ELSE 0 END) as excluded
      FROM employees
      ${tenantWhere}
    `, tenantParams);

    const [matches] = await db.query(`
      SELECT COUNT(DISTINCT m.employee_id) as matched
      FROM user_employee_map m
      JOIN employees e ON e.id = m.employee_id
      ${tenantWhere.replace('tenant_id', 'e.tenant_id')}
    `, tenantParams);

    res.json({
      total: stats[0].total,
      active: stats[0].active,
      inactive: stats[0].inactive,
      authorized: stats[0].authorized,
      unauthorized: stats[0].unauthorized,
      excluded: stats[0].excluded,
      matched: matches[0].matched,
      unmatched: stats[0].total - matches[0].matched
    });

  } catch (err) {
    console.error('ERROR fetching employee stats:', err);
    res.status(500).json({ error: 'Error fetching employee stats' });
  }
});

module.exports = router;