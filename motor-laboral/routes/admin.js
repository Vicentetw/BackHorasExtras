const express = require('express');

function createMotorLaboralAdminRoutes(db) {
  const router = express.Router();

  router.get('/tenants', async (req, res) => {
    try {
      const [rows] = await db.query(`SELECT * FROM tenants ORDER BY id ASC`);
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin tenants error:', err);
      res.status(500).json({ error: 'Error al leer tenants' });
    }
  });

  router.post('/tenants', async (req, res) => {
    try {
      const { name, code, timezone } = req.body;
      if (!name || !code) {
        return res.status(400).json({ error: 'name y code son requeridos' });
      }
      const [result] = await db.query(
        `INSERT INTO tenants (name, code, timezone) VALUES (?, ?, ?)`,
        [name, code, timezone || 'America/Argentina/Buenos_Aires']
      );
      res.status(201).json({ ok: true, id: result.insertId, name, code, timezone: timezone || 'America/Argentina/Buenos_Aires' });
    } catch (err) {
      console.error('Motor Laboral admin create tenant error:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Código de empresa ya existe' });
      }
      res.status(500).json({ error: 'Error al crear empresa' });
    }
  });

  router.get('/templates', async (req, res) => {
    try {
      const [rows] = await db.query(`SELECT * FROM work_schedule_templates ORDER BY tenant_id ASC, id ASC`);
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin templates error:', err);
      res.status(500).json({ error: 'Error al leer plantillas' });
    }
  });

  router.post('/templates', async (req, res) => {
    try {
      const tenantId = req.body.tenant_id ?? req.body.tenantId;
      const { name, description, type, active } = req.body;
      if (tenantId === undefined || tenantId === null || !name || !type) {
        return res.status(400).json({ error: 'tenantId/tenant_id, name y type son requeridos' });
      }
      const [result] = await db.query(
        `INSERT INTO work_schedule_templates (tenant_id, name, description, type, active) VALUES (?, ?, ?, ?, ?)`,
        [tenantId, name, description || null, type, active ? 1 : 0]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create template error:', err);
      res.status(500).json({ error: 'Error al crear plantilla' });
    }
  });

  router.put('/templates/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const tenantId = req.body.tenant_id ?? req.body.tenantId;
      const { name, description, type, active } = req.body;
      if (tenantId === undefined || tenantId === null || !name || !type) {
        return res.status(400).json({ error: 'tenantId/tenant_id, name y type son requeridos' });
      }
      const [result] = await db.query(
        `UPDATE work_schedule_templates SET tenant_id = ?, name = ?, description = ?, type = ?, active = ? WHERE id = ?`,
        [tenantId, name, description || null, type, active ? 1 : 0, id]
      );
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update template error:', err);
      res.status(500).json({ error: 'Error al actualizar plantilla' });
    }
  });

  router.delete('/templates/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await db.query(`DELETE FROM work_schedule_templates WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete template error:', err);
      res.status(500).json({ error: 'Error al eliminar plantilla' });
    }
  });

  router.get('/templates/:id/blocks', async (req, res) => {
    try {
      const { id } = req.params;
      const [rows] = await db.query(
        `SELECT * FROM shift_blocks WHERE template_id = ? ORDER BY day_of_week ASC, start_time ASC`,
        [id]
      );
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin blocks error:', err);
      res.status(500).json({ error: 'Error al leer bloques' });
    }
  });

  router.post('/templates/:id/blocks', async (req, res) => {
    try {
      const { id } = req.params;
      const {
        dayOfWeek,
        blockName,
        startTime,
        endTime,
        blockType,
        crossesMidnight,
        active
      } = req.body;

      if (dayOfWeek === undefined || !startTime || !endTime || !blockType) {
        return res.status(400).json({ error: 'dayOfWeek, startTime, endTime y blockType son requeridos' });
      }

      const [result] = await db.query(
        `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, dayOfWeek, blockName || null, startTime, endTime, blockType, crossesMidnight ? 1 : 0, active ? 1 : 0]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create block error:', err);
      res.status(500).json({ error: 'Error al crear bloque' });
    }
  });

  router.put('/blocks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const {
        dayOfWeek,
        blockName,
        startTime,
        endTime,
        blockType,
        crossesMidnight,
        active
      } = req.body;

      if (dayOfWeek === undefined || !startTime || !endTime || !blockType) {
        return res.status(400).json({ error: 'dayOfWeek, startTime, endTime y blockType son requeridos' });
      }

      const [result] = await db.query(
        `UPDATE shift_blocks SET day_of_week = ?, block_name = ?, start_time = ?, end_time = ?, block_type = ?, crosses_midnight = ?, active = ? WHERE id = ?`,
        [dayOfWeek, blockName || null, startTime, endTime, blockType, crossesMidnight ? 1 : 0, active ? 1 : 0, id]
      );
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update block error:', err);
      res.status(500).json({ error: 'Error al actualizar bloque' });
    }
  });

  router.delete('/blocks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await db.query(`DELETE FROM shift_blocks WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete block error:', err);
      res.status(500).json({ error: 'Error al eliminar bloque' });
    }
  });

  router.get('/employees', async (req, res) => {
    try {
      const [employees] = await db.query(`
        SELECT
          id AS employee_id,
          nombre AS name,
          employee_id AS badgeNumber,
          legajo_alt AS alternateBadgeNumber,
          tenant_id,
          activo AS active
        FROM employees
        WHERE activo = 1 OR activo IS NULL
        ORDER BY nombre
        LIMIT 1000
      `);
      res.json(employees);
    } catch (err) {
      console.error('Motor Laboral admin employees error:', err);
      res.status(500).json({ error: 'Error al leer empleados' });
    }
  });

  router.get('/employees/:employeeId/calendar', async (req, res) => {
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
      console.error('Motor Laboral admin employee calendar error:', err);
      res.status(500).json({ error: 'Error al leer calendario del empleado' });
    }
  });

  router.post('/employees/:employeeId/calendar', async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { template_id, valid_from, valid_to, tenant_id } = req.body;

      if (!template_id || !valid_from) {
        return res.status(400).json({ error: 'template_id y valid_from requeridos' });
      }

      const [emp] = await db.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
      if (emp.length === 0) {
        return res.status(404).json({ error: 'Empleado no encontrado' });
      }

      const [templateRows] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [template_id]);
      const templateTenantId = templateRows.length > 0 ? templateRows[0].tenant_id : null;
      const empTenantId = tenant_id || emp[0].tenant_id || templateTenantId;

      if (!empTenantId) {
        return res.status(400).json({ error: 'No hay tenant_id disponible para esta asignación' });
      }

      if (!emp[0].tenant_id && templateTenantId) {
        await db.query('UPDATE employees SET tenant_id = ? WHERE id = ?', [templateTenantId, employeeId]);
      }

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
      console.error('Motor Laboral admin save employee calendar error:', err);
      res.status(500).json({ error: 'Error al guardar calendario del empleado' });
    }
  });

  return router;
}

module.exports = createMotorLaboralAdminRoutes;
