// ========================================
// ENDPOINTS PARA GESTIÓN DE EMPLEADOS & MATCHING
// ========================================

// GET /api/employees - Listar todos los empleados
app.get('/api/employees', async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '', active = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let whereClause = '';
    const params = [];

    if (search) {
      whereClause += ' AND (e.nombre LIKE ? OR e.documento LIKE ? OR e.employee_id LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (active !== '') {
      whereClause += ' AND e.activo = ?';
      params.push(active === 'true' ? 1 : 0);
    }

    // Total count
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM employees e WHERE 1=1 ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get employees with matching user info
    const [employees] = await db.query(`
      SELECT 
        e.*,
        u.USERID,
        u.Name as user_name,
        u.Badgenumber,
        uem.match_type
      FROM employees e
      LEFT JOIN user_employee_map uem ON e.id = uem.employee_id
      LEFT JOIN users u ON uem.USERID = u.USERID
      WHERE 1=1 ${whereClause}
      ORDER BY e.nombre
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    res.json({
      data: employees,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('ERROR getting employees:', err);
    res.status(500).json({ error: 'Error obteniendo empleados' });
  }
});

// GET /api/employees/:id - Obtener empleado por ID
app.get('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [employee] = await db.query(
      `SELECT * FROM employees WHERE id = ?`,
      [parseInt(id)]
    );

    if (employee.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Get mapping info
    const [mapping] = await db.query(
      `SELECT u.*, uem.match_type FROM user_employee_map uem
       LEFT JOIN users u ON uem.USERID = u.USERID
       WHERE uem.employee_id = ?`,
      [parseInt(id)]
    );

    res.json({
      ...employee[0],
      user_mapping: mapping[0] || null
    });
  } catch (err) {
    console.error('ERROR getting employee:', err);
    res.status(500).json({ error: 'Error obteniendo empleado' });
  }
});

// POST /api/employees - Crear nuevo empleado
app.post('/api/employees', async (req, res) => {
  try {
    const { employee_id, nombre, documento, tipo_documento, direccion, zona_id, fecha_alta, activo } = req.body;

    if (!nombre || !employee_id) {
      return res.status(400).json({ error: 'nombre y employee_id son requeridos' });
    }

    const [result] = await db.query(
      `INSERT INTO employees 
       (employee_id, nombre, documento, tipo_documento, direccion, zona_id, fecha_alta, activo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [employee_id, nombre, documento || null, tipo_documento || null, direccion || null, zona_id || null, fecha_alta || null, activo !== false ? 1 : 0]
    );

    res.json({ 
      ok: true, 
      message: 'Empleado creado',
      id: result.insertId
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'El employee_id ya existe' });
    }
    console.error('ERROR creating employee:', err);
    res.status(500).json({ error: 'Error creando empleado' });
  }
});

// PUT /api/employees/:id - Actualizar empleado
app.put('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, documento, tipo_documento, direccion, zona_id, fecha_baja, activo } = req.body;

    // Check if exists
    const [existing] = await db.query('SELECT id FROM employees WHERE id = ?', [parseInt(id)]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    const updates = [];
    const values = [];

    if (nombre !== undefined) {
      updates.push('nombre = ?');
      values.push(nombre);
    }
    if (documento !== undefined) {
      updates.push('documento = ?');
      values.push(documento);
    }
    if (tipo_documento !== undefined) {
      updates.push('tipo_documento = ?');
      values.push(tipo_documento);
    }
    if (direccion !== undefined) {
      updates.push('direccion = ?');
      values.push(direccion);
    }
    if (zona_id !== undefined) {
      updates.push('zona_id = ?');
      values.push(zona_id);
    }
    if (fecha_baja !== undefined) {
      updates.push('fecha_baja = ?');
      values.push(fecha_baja);
    }
    if (activo !== undefined) {
      updates.push('activo = ?');
      values.push(activo ? 1 : 0);
    }

    updates.push('updated_at = NOW()');
    values.push(parseInt(id));

    if (updates.length > 1) {
      await db.query(
        `UPDATE employees SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    res.json({ ok: true, message: 'Empleado actualizado' });
  } catch (err) {
    console.error('ERROR updating employee:', err);
    res.status(500).json({ error: 'Error actualizando empleado' });
  }
});

// DELETE /api/employees/:id - Eliminar empleado
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if exists
    const [existing] = await db.query('SELECT id FROM employees WHERE id = ?', [parseInt(id)]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Check if has mappings - prevent deletion if mapped
    const [mappings] = await db.query(
      'SELECT COUNT(*) as cnt FROM user_employee_map WHERE employee_id = ?',
      [parseInt(id)]
    );

    if (mappings[0].cnt > 0) {
      return res.status(409).json({ 
        error: 'No se puede eliminar empleado con relaciones activas',
        relatedRecords: mappings[0].cnt 
      });
    }

    await db.query('DELETE FROM employees WHERE id = ?', [parseInt(id)]);

    res.json({ ok: true, message: 'Empleado eliminado' });
  } catch (err) {
    console.error('ERROR deleting employee:', err);
    res.status(500).json({ error: 'Error eliminando empleado' });
  }
});

// ========================================
// ENDPOINTS PARA AUTO-MATCHING
// ========================================

// POST /api/matching/auto - Auto-match usuarios con empleados
app.post('/api/matching/auto', async (req, res) => {
  try {
    let matched = 0;
    let conflicts = 0;

    // Get all employees with employee_id
    const [employees] = await db.query(
      'SELECT id, employee_id FROM employees WHERE employee_id IS NOT NULL'
    );

    for (const emp of employees) {
      // Find user with matching Badgenumber
      const [users] = await db.query(
        'SELECT USERID FROM users WHERE Badgenumber = ? AND USERID > 10',
        [emp.employee_id.toString()]
      );

      if (users.length === 0) continue;

      const userId = users[0].USERID;

      // Check if already mapped
      const [existing] = await db.query(
        'SELECT USERID FROM user_employee_map WHERE USERID = ?',
        [userId]
      );

      if (existing.length > 0) {
        conflicts++;
        continue;
      }

      // Create mapping
      try {
        await db.query(
          'INSERT INTO user_employee_map (USERID, employee_id, match_type) VALUES (?, ?, ?)',
          [userId, emp.id, 'auto_employee_id']
        );
        matched++;
      } catch (err) {
        console.error(`Error mapping user ${userId}:`, err.message);
        conflicts++;
      }
    }

    res.json({
      ok: true,
      message: `Auto-matching completado: ${matched} relacionados, ${conflicts} conflictos`,
      matched,
      conflicts
    });
  } catch (err) {
    console.error('ERROR auto-matching:', err);
    res.status(500).json({ error: 'Error en auto-matching' });
  }
});

// POST /api/matching/manual - Relacionar usuario con empleado manualmente
app.post('/api/matching/manual', async (req, res) => {
  try {
    const { userId, employeeId } = req.body;

    if (!userId || !employeeId) {
      return res.status(400).json({ error: 'userId y employeeId son requeridos' });
    }

    // Check both exist
    const [user] = await db.query('SELECT USERID FROM users WHERE USERID = ?', [parseInt(userId)]);
    const [employee] = await db.query('SELECT id FROM employees WHERE id = ?', [parseInt(employeeId)]);

    if (user.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (employee.length === 0) {
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }

    // Remove old mapping for this user if exists
    await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [parseInt(userId)]);

    // Create new mapping
    await db.query(
      'INSERT INTO user_employee_map (USERID, employee_id, match_type) VALUES (?, ?, ?)',
      [parseInt(userId), parseInt(employeeId), 'manual']
    );

    res.json({ ok: true, message: 'Usuario relacionado con empleado' });
  } catch (err) {
    console.error('ERROR manual matching:', err);
    res.status(500).json({ error: 'Error en relación manual' });
  }
});

// DELETE /api/matching/:userId - Remover relación
app.delete('/api/matching/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [result] = await db.query(
      'DELETE FROM user_employee_map WHERE USERID = ?',
      [parseInt(userId)]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Relación no encontrada' });
    }

    res.json({ ok: true, message: 'Relación removida' });
  } catch (err) {
    console.error('ERROR removing matching:', err);
    res.status(500).json({ error: 'Error removiendo relación' });
  }
});

// GET /api/matching/unmatched-users - Obtener usuarios sin mapear
app.get('/api/matching/unmatched-users', async (req, res) => {
  try {
    const [unmapped] = await db.query(`
      SELECT u.USERID, u.Badgenumber, u.Name
      FROM users u
      WHERE u.USERID > 10 
        AND u.USERID NOT IN (SELECT USERID FROM user_employee_map)
      ORDER BY u.Name
    `);

    res.json(unmapped);
  } catch (err) {
    console.error('ERROR getting unmatched users:', err);
    res.status(500).json({ error: 'Error obteniendo usuarios sin mapear' });
  }
});

// GET /api/matching/status - Ver estado del matching
app.get('/api/matching/status', async (req, res) => {
  try {
    const [[{ total: totalUsers }]] = await db.query('SELECT COUNT(*) as total FROM users WHERE USERID > 10');
    const [[{ mapped: mappedUsers }]] = await db.query('SELECT COUNT(*) as mapped FROM user_employee_map');
    const [[{ total: totalEmployees }]] = await db.query('SELECT COUNT(*) as total FROM employees');

    res.json({
      totalUsers: parseInt(totalUsers),
      mappedUsers: parseInt(mappedUsers),
      unmappedUsers: parseInt(totalUsers) - parseInt(mappedUsers),
      totalEmployees: parseInt(totalEmployees),
      matchPercentage: ((parseInt(mappedUsers) / parseInt(totalUsers)) * 100).toFixed(2)
    });
  } catch (err) {
    console.error('ERROR getting matching status:', err);
    res.status(500).json({ error: 'Error obteniendo estado' });
  }
});
