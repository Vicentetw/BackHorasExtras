const express = require('express');
const { firebaseAuthMiddleware } = require('./firebaseAuth');

function createMotorLaboralRoutes(db) {
  const router = express.Router();

  // ============ MIDDLEWARE ============
  // Protegemos solo las rutas admin con Firebase auth, dejando attendance público
  router.use('/admin', firebaseAuthMiddleware);

  // ============ TENANTS ============
  
  /**
   * GET /api/labor-engine/admin/tenants
   * Listar todos los tenants
   */
  router.get('/admin/tenants', async (req, res) => {
    try {
      const [rows] = await db.query('SELECT id, name, code, timezone FROM tenants ORDER BY id ASC');
      res.json(rows);
    } catch (err) {
      console.error('Error en GET /admin/tenants:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ TEMPLATES ============

  /**
   * GET /api/labor-engine/admin/templates
   * Listar todas las plantillas de trabajo
   */
  router.get('/admin/templates', async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT t.id, t.tenant_id, t.name, t.description, t.type, t.active, t.created_at
        FROM work_schedule_templates t
        WHERE t.active = 1
        ORDER BY t.tenant_id, t.name
      `);
      res.json(rows);
    } catch (err) {
      console.error('Error en GET /admin/templates:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/labor-engine/admin/templates/:templateId
   * Obtener una plantilla específica con sus bloques
   */
  router.get('/admin/templates/:templateId', async (req, res) => {
    try {
      const { templateId } = req.params;
      const [template] = await db.query(
        'SELECT * FROM work_schedule_templates WHERE id = ?',
        [templateId]
      );
      
      if (template.length === 0) {
        return res.status(404).json({ error: 'Template no encontrado' });
      }

      const [blocks] = await db.query(
        'SELECT * FROM shift_blocks WHERE template_id = ? ORDER BY day_of_week, start_time',
        [templateId]
      );

      res.json({ ...template[0], blocks });
    } catch (err) {
      console.error('Error en GET /admin/templates/:id:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/labor-engine/admin/templates
   * Crear una nueva plantilla
   */
  router.post('/admin/templates', async (req, res) => {
    try {
      const tenantId = req.body.tenant_id ?? req.body.tenantId;
      const { name, description, type } = req.body;
      
      if (!tenantId || !name) {
        return res.status(400).json({ error: 'tenant_id y name requeridos' });
      }

      const [result] = await db.query(
        'INSERT INTO work_schedule_templates (tenant_id, name, description, type, active) VALUES (?, ?, ?, ?, 1)',
        [tenantId, name, description || '', type || 'STANDARD']
      );

      res.status(201).json({
        id: result.insertId,
        tenant_id,
        name,
        description: description || '',
        type: type || 'STANDARD',
        active: 1
      });
    } catch (err) {
      console.error('Error en POST /admin/templates:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ SHIFT BLOCKS ============

  /**
   * GET /api/labor-engine/admin/shift-blocks?templateId=X
   * Listar bloques de una plantilla
   */
  router.get('/admin/shift-blocks', async (req, res) => {
    try {
      const { templateId } = req.query;
      
      if (!templateId) {
        return res.status(400).json({ error: 'templateId requerido' });
      }

      const [blocks] = await db.query(
        'SELECT * FROM shift_blocks WHERE template_id = ? ORDER BY day_of_week, start_time',
        [templateId]
      );

      res.json(blocks);
    } catch (err) {
      console.error('Error en GET /admin/shift-blocks:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/labor-engine/admin/shift-blocks
   * Crear un nuevo bloque de turno
   */
  router.post('/admin/shift-blocks', async (req, res) => {
    try {
      const {
        template_id,
        day_of_week,
        block_name,
        start_time,
        end_time,
        block_type,
        crosses_midnight
      } = req.body;

      if (!template_id || day_of_week === undefined || !block_name || !start_time || !end_time) {
        return res.status(400).json({ error: 'Parámetros requeridos faltando' });
      }

      const [result] = await db.query(
        `INSERT INTO shift_blocks 
         (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [template_id, day_of_week, block_name, start_time, end_time, block_type || 'WORK', crosses_midnight ? 1 : 0]
      );

      res.status(201).json({
        id: result.insertId,
        template_id,
        day_of_week,
        block_name,
        start_time,
        end_time,
        block_type: block_type || 'WORK',
        crosses_midnight: crosses_midnight ? 1 : 0,
        active: 1
      });
    } catch (err) {
      console.error('Error en POST /admin/shift-blocks:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/labor-engine/admin/shift-blocks/:blockId
   * Actualizar un bloque de turno
   */
  router.put('/admin/shift-blocks/:blockId', async (req, res) => {
    try {
      const { blockId } = req.params;
      const {
        day_of_week,
        block_name,
        start_time,
        end_time,
        block_type,
        crosses_midnight,
        active
      } = req.body;

      const updates = [];
      const values = [];

      if (day_of_week !== undefined) {
        updates.push('day_of_week = ?');
        values.push(day_of_week);
      }
      if (block_name !== undefined) {
        updates.push('block_name = ?');
        values.push(block_name);
      }
      if (start_time !== undefined) {
        updates.push('start_time = ?');
        values.push(start_time);
      }
      if (end_time !== undefined) {
        updates.push('end_time = ?');
        values.push(end_time);
      }
      if (block_type !== undefined) {
        updates.push('block_type = ?');
        values.push(block_type);
      }
      if (crosses_midnight !== undefined) {
        updates.push('crosses_midnight = ?');
        values.push(crosses_midnight ? 1 : 0);
      }
      if (active !== undefined) {
        updates.push('active = ?');
        values.push(active ? 1 : 0);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      values.push(blockId);
      const [result] = await db.query(
        `UPDATE shift_blocks SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Bloque no encontrado' });
      }

      res.json({ id: blockId, updated: true });
    } catch (err) {
      console.error('Error en PUT /admin/shift-blocks/:id:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/labor-engine/admin/shift-blocks/:blockId
   * Eliminar un bloque de turno
   */
  router.delete('/admin/shift-blocks/:blockId', async (req, res) => {
    try {
      const { blockId } = req.params;
      const [result] = await db.query('DELETE FROM shift_blocks WHERE id = ?', [blockId]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Bloque no encontrado' });
      }

      res.json({ id: blockId, deleted: true });
    } catch (err) {
      console.error('Error en DELETE /admin/shift-blocks/:id:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ EMPLOYEES ============

  /**
   * GET /api/labor-engine/admin/employees
   * Listar todos los empleados
   */
  router.get('/admin/employees', async (req, res) => {
    try {
      const [employees] = await db.query(`
        SELECT 
          id as employee_id,
          nombre as name,
          employee_id as badgeNumber,
          legajo_alt as alternateBadgeNumber,
          tenant_id,
          activo as active
        FROM employees
        WHERE activo = 1 OR activo IS NULL
        ORDER BY nombre
        LIMIT 1000
      `);
      res.json(employees);
    } catch (err) {
      console.error('Error en GET /admin/employees:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/labor-engine/admin/employees/:employeeId/calendar
   * Obtener el historial de calendarios de un empleado
   */
  router.get('/admin/employees/:employeeId/calendar', async (req, res) => {
    try {
      const { employeeId } = req.params;
      
      const [calendars] = await db.query(`
        SELECT id, employee_id, tenant_id, template_id, valid_from, valid_to, created_at, updated_at
        FROM employee_work_calendars
        WHERE employee_id = ?
        ORDER BY valid_from DESC, created_at DESC
      `, [employeeId]);

      res.json(calendars);
    } catch (err) {
      console.error('Error en GET /admin/employees/:id/calendar:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/labor-engine/admin/employees/:employeeId/calendar
   * Asignar una plantilla a un empleado
   */
  router.post('/admin/employees/:employeeId/calendar', async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { template_id, valid_from, valid_to, tenant_id } = req.body;

      if (!template_id || !valid_from) {
        return res.status(400).json({ error: 'template_id y valid_from requeridos' });
      }

      // Validar que el empleado existe
      const [emp] = await db.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
      if (emp.length === 0) {
        return res.status(404).json({ error: 'Empleado no encontrado' });
      }

      const empTenantId = tenant_id || emp[0].tenant_id;

      // Crear la asignación
      const [result] = await db.query(
        `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?)`,
        [employeeId, empTenantId, template_id, valid_from, valid_to || null]
      );

      res.status(201).json({
        id: result.insertId,
        employee_id: employeeId,
        tenant_id: empTenantId,
        template_id,
        valid_from,
        valid_to: valid_to || null
      });
    } catch (err) {
      console.error('Error en POST /admin/employees/:id/calendar:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/labor-engine/admin/employees/:employeeId/calendar/:calendarId
   * Actualizar una asignación de plantilla
   */
  router.put('/admin/employees/:employeeId/calendar/:calendarId', async (req, res) => {
    try {
      const { employeeId, calendarId } = req.params;
      const { template_id, valid_from, valid_to } = req.body;

      const updates = [];
      const values = [];

      if (template_id !== undefined) {
        updates.push('template_id = ?');
        values.push(template_id);
      }
      if (valid_from !== undefined) {
        updates.push('valid_from = ?');
        values.push(valid_from);
      }
      if (valid_to !== undefined) {
        updates.push('valid_to = ?');
        values.push(valid_to);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }

      values.push(employeeId, calendarId);
      const [result] = await db.query(
        `UPDATE employee_work_calendars SET ${updates.join(', ')} WHERE employee_id = ? AND id = ?`,
        values
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Asignación no encontrada' });
      }

      res.json({ id: calendarId, updated: true });
    } catch (err) {
      console.error('Error en PUT /admin/employees/:id/calendar/:calendarId:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/labor-engine/admin/employees/:employeeId/calendar/:calendarId
   * Eliminar una asignación de plantilla
   */
  router.delete('/admin/employees/:employeeId/calendar/:calendarId', async (req, res) => {
    try {
      const { employeeId, calendarId } = req.params;
      
      const [result] = await db.query(
        'DELETE FROM employee_work_calendars WHERE employee_id = ? AND id = ?',
        [employeeId, calendarId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Asignación no encontrada' });
      }

      res.json({ id: calendarId, deleted: true });
    } catch (err) {
      console.error('Error en DELETE /admin/employees/:id/calendar/:calendarId:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ============ ATTENDANCE ============

  /**
   * GET /api/labor-engine/attendance/:date
   * Obtener asistencia de una fecha específica
   */
  router.get('/attendance/:date', async (req, res) => {
    try {
      const { date } = req.params;
      const tenantId = req.query.tenantId || null;

      let query = 'SELECT * FROM attendance WHERE DATE(check_time) = ?';
      const values = [date];

      if (tenantId) {
        query += ' AND tenant_id = ?';
        values.push(tenantId);
      }

      const [rows] = await db.query(query, values);
      res.json(rows);
    } catch (err) {
      console.error('Error en GET /attendance/:date:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/labor-engine/attendance/:date/compare
   * Comparar asistencia con plantilla esperada
   */
  router.get('/attendance/:date/compare', async (req, res) => {
    try {
      const { date } = req.params;
      const tenantId = req.query.tenantId || null;

      // Determinar día de semana
      const dateObj = new Date(date + 'T00:00:00Z');
      const dayOfWeek = dateObj.getUTCDay();

      // Obtener empleados esperados para este día
      let query = `
        SELECT 
          e.id,
          e.nombre,
          e.employee_id as badgeNumber,
          e.legajo_alt as alternateBadgeNumber,
          t.name as template_name,
          sb.block_name,
          sb.start_time,
          sb.end_time,
          COALESCE(att.check_time, 'No registrado') as check_time
        FROM employee_work_calendars ewc
        JOIN employees e ON e.id = ewc.employee_id
        JOIN work_schedule_templates t ON t.id = ewc.template_id
        JOIN shift_blocks sb ON sb.template_id = t.id
        LEFT JOIN attendance att ON att.employee_id = e.id AND DATE(att.check_time) = ?
        WHERE sb.day_of_week = ?
          AND sb.active = 1
          AND ewc.valid_from <= ?
          AND (ewc.valid_to IS NULL OR ewc.valid_to >= ?)
      `;
      const values = [date, dayOfWeek, date, date];

      if (tenantId) {
        query += ' AND ewc.tenant_id = ?';
        values.push(tenantId);
      }

      const [rows] = await db.query(query, values);
      res.json(rows);
    } catch (err) {
      console.error('Error en GET /attendance/:date/compare:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createMotorLaboralRoutes;
