const express = require('express');
const router = express.Router();
const db = require('../db');

// NOTE: Automatic employee->user sync has been disabled.
// Matching now requires explicit approval via the matching dashboard.

/**
 * 📋 LISTAR EMPLEADOS
 * GET /api/employees
 * Query params: page, limit, search, status, sortBy
 */
router.get('/', async (req, res) => {
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

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Obtener total
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM employees ${where}`,
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
      ? `SELECT * FROM employees ${where} ORDER BY ${orderBy}`
      : `SELECT * FROM employees ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

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
router.post('/', async (req, res) => {
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
      overtime_authorized,
      exclude_from_report,
      legajo_alt
    } = req.body;

    // Validaciones básicas
    if (!employee_id || !nombre) {
      return res.status(400).json({
        error: 'employee_id y nombre son requeridos'
      });
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
       (employee_id, nombre, documento, tipo_documento, direccion, zona_id, zona_real_id, fecha_alta, fecha_baja, activo, overtime_authorized, exclude_from_report, legajo_alt, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        overtime_authorized !== undefined ? (overtime_authorized ? 1 : 0) : 1,
        exclude_from_report !== undefined ? (exclude_from_report ? 1 : 0) : 0,
        legajo_alt || null,
        tenant_id || null
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
router.put('/:id', async (req, res) => {
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
      overtime_authorized,
      exclude_from_report,
      legajo_alt,
      tenant_id
    } = req.body;

    // Validaciones básicas
    if (!employee_id || !nombre) {
      return res.status(400).json({
        error: 'employee_id y nombre son requeridos'
      });
    }

    // Verificar que existe
    const [existing] = await db.query(
      'SELECT id, employee_id FROM employees WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        error: 'Empleado no encontrado'
      });
    }

    const previousBadge = existing[0].employee_id;

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
       fecha_baja = ?, activo = ?, overtime_authorized = ?, exclude_from_report = ?, legajo_alt = ?, tenant_id = ?
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
        overtime_authorized !== undefined ? (overtime_authorized ? 1 : 0) : 1,
        exclude_from_report !== undefined ? (exclude_from_report ? 1 : 0) : 0,
        legajo_alt || null,
        tenant_id || null,
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
 * 🗑️ ELIMINAR EMPLEADO
 * DELETE /api/employees/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe
    const [existing] = await db.query(
      'SELECT id FROM employees WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
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
router.get('/stats', async (req, res) => {
  try {
    const [stats] = await db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN activo = 0 THEN 1 ELSE 0 END) as inactive,
        SUM(CASE WHEN overtime_authorized = 1 THEN 1 ELSE 0 END) as authorized,
        SUM(CASE WHEN overtime_authorized = 0 THEN 1 ELSE 0 END) as unauthorized,
        SUM(CASE WHEN exclude_from_report = 1 THEN 1 ELSE 0 END) as excluded
      FROM employees
    `);

    const [matches] = await db.query(`
      SELECT COUNT(DISTINCT employee_id) as matched
      FROM user_employee_map
    `);

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