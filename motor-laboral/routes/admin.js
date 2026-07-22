const express = require('express');
const { resolveTenantId, requireSuperadmin, requirePermission } = require('../../appUserMiddleware');

function createMotorLaboralAdminRoutes(db) {
  const router = express.Router();

  router.get('/tenants', requireSuperadmin, async (req, res) => {
    try {
      const { code, name } = req.query;
      if (code) {
        const [rows] = await db.query(
          `SELECT id, name, code, timezone FROM tenants WHERE code = ? LIMIT 1`,
          [code]
        );
        return res.json(rows);
      }
      if (name) {
        const [rows] = await db.query(
          `SELECT id, name, code, timezone FROM tenants WHERE name = ? LIMIT 1`,
          [name]
        );
        return res.json(rows);
      }

      const [rows] = await db.query(`SELECT * FROM tenants ORDER BY id ASC`);
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin tenants error:', err);
      res.status(500).json({ error: 'Error al leer tenants' });
    }
  });

  router.post('/tenants', requireSuperadmin, async (req, res) => {
    try {
      const rawName = req.body.name;
      const rawCode = req.body.code;
      const timezone = req.body.timezone;

      if (!rawName || !rawCode) {
        return res.status(400).json({ error: 'name y code son requeridos' });
      }

      const name = String(rawName).trim();
      const code = String(rawCode).trim();
      if (!name || !code) {
        return res.status(400).json({ error: 'name y code no pueden estar vacíos' });
      }

      const [existing] = await db.query(
        `SELECT id FROM tenants WHERE code = ? OR name = ? LIMIT 1`,
        [code, name]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Código o nombre de empresa ya existe', code, name });
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

  router.put('/tenants/:id', requireSuperadmin, async (req, res) => {
    try {
      const { id } = req.params;
      const rawName = req.body.name;
      const rawCode = req.body.code;
      const timezone = req.body.timezone;

      if (!rawName || !rawCode) {
        return res.status(400).json({ error: 'name y code son requeridos' });
      }

      const name = String(rawName).trim();
      const code = String(rawCode).trim();
      if (!name || !code) {
        return res.status(400).json({ error: 'name y code no pueden estar vacíos' });
      }

      const [existing] = await db.query(
        `SELECT id FROM tenants WHERE (code = ? OR name = ?) AND id != ? LIMIT 1`,
        [code, name, id]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Código o nombre de empresa ya existe' });
      }

      const [result] = await db.query(
        `UPDATE tenants SET name = ?, code = ?, timezone = ? WHERE id = ?`,
        [name, code, timezone || 'America/Argentina/Buenos_Aires', id]
      );

      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update tenant error:', err);
      res.status(500).json({ error: 'Error al actualizar empresa' });
    }
  });

  router.delete('/tenants/:id', requireSuperadmin, async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await db.query(`DELETE FROM tenants WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete tenant error:', err);
      res.status(500).json({ error: 'Error al eliminar empresa' });
    }
  });

  router.get('/templates', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      const [rows] = effectiveTenantId !== null
        ? await db.query(`SELECT * FROM work_schedule_templates WHERE tenant_id = ? ORDER BY id ASC`, [effectiveTenantId])
        : await db.query(`SELECT * FROM work_schedule_templates ORDER BY tenant_id ASC, id ASC`);
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin templates error:', err);
      res.status(500).json({ error: 'Error al leer plantillas' });
    }
  });

  router.post('/templates', requirePermission('schedules', 'create'), async (req, res) => {
    try {
      const bodyTenantId = req.body.tenant_id ?? req.body.tenantId;
      // Un usuario normal solo puede crear plantillas para su propia
      // empresa; solo el superadmin puede elegir el tenant_id a mano.
      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : bodyTenantId;
      const { name, description, type, active, is_default } = req.body;
      if (tenantId === undefined || tenantId === null || !name || !type) {
        return res.status(400).json({ error: 'tenantId/tenant_id, name y type son requeridos' });
      }
      // If marking this template as default, unset other defaults for the tenant
      if (is_default) {
        try {
          await db.query(`UPDATE work_schedule_templates SET is_default = 0 WHERE tenant_id = ?`, [tenantId]);
        } catch (err2) {
          console.error('Error unsetting other defaults for tenant', tenantId, err2);
        }
      }
      const [result] = await db.query(
        `INSERT INTO work_schedule_templates (tenant_id, name, description, type, active, is_default) VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, name, description || null, type, active ? 1 : 0, is_default ? 1 : 0]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create template error:', err);
      res.status(500).json({ error: 'Error al crear plantilla' });
    }
  });

  router.put('/templates/:id', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Plantilla no encontrada' });
        }
      }
      const bodyTenantId = req.body.tenant_id ?? req.body.tenantId;
      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : bodyTenantId;
      const { name, description, type, active, is_default } = req.body;
      if (tenantId === undefined || tenantId === null || !name || !type) {
        return res.status(400).json({ error: 'tenantId/tenant_id, name y type son requeridos' });
      }
      // If marking this template as default, unset other defaults for the tenant
      if (is_default) {
        try {
          await db.query(`UPDATE work_schedule_templates SET is_default = 0 WHERE tenant_id = ?`, [tenantId]);
        } catch (err2) {
          console.error('Error unsetting other defaults for tenant', tenantId, err2);
        }
      }
      const [result] = await db.query(
        `UPDATE work_schedule_templates SET tenant_id = ?, name = ?, description = ?, type = ?, active = ?, is_default = ? WHERE id = ?`,
        [tenantId, name, description || null, type, active ? 1 : 0, is_default ? 1 : 0, id]
      );
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update template error:', err);
      res.status(500).json({ error: 'Error al actualizar plantilla' });
    }
  });

  router.delete('/templates/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Plantilla no encontrada' });
        }
      }
      const [result] = await db.query(`DELETE FROM work_schedule_templates WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete template error:', err);
      res.status(500).json({ error: 'Error al eliminar plantilla' });
    }
  });

  router.get('/templates/:id/blocks', requirePermission('schedules', 'read'), async (req, res) => {
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

  router.post('/templates/:id/blocks', requirePermission('schedules', 'create'), async (req, res) => {
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

  router.put('/blocks/:id', requirePermission('schedules', 'update'), async (req, res) => {
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

  router.delete('/blocks/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await db.query(`DELETE FROM shift_blocks WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete block error:', err);
      res.status(500).json({ error: 'Error al eliminar bloque' });
    }
  });

  router.get('/employees', requirePermission('employees', 'read'), async (req, res) => {
    try {
      const { categoryId } = req.query;
      const params = [];
      let where = 'WHERE (e.activo = 1 OR e.activo IS NULL)';
      if (categoryId) {
        where += ' AND e.category_id = ?';
        params.push(categoryId);
      }

      const [employees] = await db.query(`
        SELECT
          e.id AS employee_id,
          e.nombre AS name,
          e.employee_id AS badgeNumber,
          e.legajo_alt AS alternateBadgeNumber,
          e.tenant_id,
          e.category_id,
          ec.name AS categoryName,
          e.activo AS active
        FROM employees e
        LEFT JOIN employee_categories ec ON ec.id = e.category_id
        ${where}
        ORDER BY e.nombre
        LIMIT 1000
      `, params);
      res.json(employees);
    } catch (err) {
      console.error('Motor Laboral admin employees error:', err);
      res.status(500).json({ error: 'Error al leer empleados' });
    }
  });

  /**
   * POST /api/labor-engine/admin/employees/bulk-set-categoria
   * Setea la categoría de puesto (catálogo employee_categories) a varios
   * empleados de una, para después poder filtrarlos y asignarles horario en bloque.
   */
  router.post('/employees/bulk-set-categoria', requirePermission('employees', 'update'), async (req, res) => {
    try {
      const { employeeIds, categoryId } = req.body;

      if (!Array.isArray(employeeIds) || employeeIds.length === 0 || !categoryId) {
        return res.status(400).json({ error: 'employeeIds (array) y categoryId son requeridos' });
      }

      const [result] = await db.query(
        `UPDATE employees SET category_id = ? WHERE id IN (?)`,
        [categoryId, employeeIds]
      );

      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin bulk-set-categoria error:', err);
      res.status(500).json({ error: 'Error al setear categoría en bloque' });
    }
  });

  // ============ ASIGNACIÓN MASIVA DE HORARIOS ============

  /**
   * POST /api/labor-engine/admin/employees/bulk-assign-calendar
   * Asigna una plantilla a varios empleados de una, cerrando cualquier
   * asignación previa abierta de cada uno (misma lógica que el alta individual,
   * pero para N empleados en un solo request).
   */
  router.post('/employees/bulk-assign-calendar', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { employeeIds, template_id, valid_from, valid_to } = req.body;

      if (!Array.isArray(employeeIds) || employeeIds.length === 0 || !template_id || !valid_from) {
        return res.status(400).json({ error: 'employeeIds (array), template_id y valid_from son requeridos' });
      }

      const [templateRows] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [template_id]);
      if (templateRows.length === 0) {
        return res.status(404).json({ error: 'Plantilla no encontrada' });
      }
      const templateTenantId = templateRows[0].tenant_id;

      const results = { assigned: [], skipped: [] };

      for (const employeeId of employeeIds) {
        const [emp] = await db.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (emp.length === 0) {
          results.skipped.push({ employeeId, reason: 'Empleado no encontrado' });
          continue;
        }

        const empTenantId = emp[0].tenant_id || templateTenantId;
        if (!empTenantId) {
          results.skipped.push({ employeeId, reason: 'Sin tenant_id disponible' });
          continue;
        }

        if (!emp[0].tenant_id && templateTenantId) {
          await db.query('UPDATE employees SET tenant_id = ? WHERE id = ?', [templateTenantId, employeeId]);
        }

        // Cerrar cualquier asignación abierta anterior (valid_to IS NULL) justo
        // antes de que empiece la nueva, para no dejar rangos superpuestos.
        await db.query(
          `UPDATE employee_work_calendars
           SET valid_to = DATE_SUB(?, INTERVAL 1 DAY)
           WHERE employee_id = ? AND valid_to IS NULL AND valid_from < ?`,
          [valid_from, employeeId, valid_from]
        );

        const [result] = await db.query(
          `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to)
           VALUES (?, ?, ?, ?, ?)`,
          [employeeId, empTenantId, template_id, valid_from, valid_to || null]
        );

        results.assigned.push({ employeeId, calendarId: result.insertId });
      }

      res.status(201).json(results);
    } catch (err) {
      console.error('Motor Laboral admin bulk-assign-calendar error:', err);
      res.status(500).json({ error: 'Error al asignar horarios en bloque' });
    }
  });

  router.get('/employees/:employeeId/calendar', requirePermission('schedules', 'read'), async (req, res) => {
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

  router.post('/employees/:employeeId/calendar', requirePermission('schedules', 'update'), async (req, res) => {
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

  router.delete('/employees/:employeeId/calendar/:calendarId', requirePermission('schedules', 'delete'), async (req, res) => {
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
      console.error('Motor Laboral admin delete employee calendar error:', err);
      res.status(500).json({ error: 'Error al eliminar calendario del empleado' });
    }
  });

  return router;
}

module.exports = createMotorLaboralAdminRoutes;
