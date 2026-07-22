const express = require('express');
const { resolveTenantId, requirePermission } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  function diffDaysInclusive(fechaDesde, fechaHasta) {
    const [y1, m1, d1] = fechaDesde.split('-').map(Number);
    const [y2, m2, d2] = fechaHasta.split('-').map(Number);
    const start = new Date(y1, m1 - 1, d1);
    const end = new Date(y2, m2 - 1, d2);
    const diffMs = end.getTime() - start.getTime();
    return Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1;
  }

  // ==========================
  // 1. LISTAR EVENTOS (licencias multi-día)
  // ==========================
  router.get('/', requirePermission('leaves', 'read'), async (req, res) => {
    try {
      const { employeeId, year } = req.query;
      let sql = `
        SELECT ee.*, e.employee_id AS legajo, e.nombre AS employeeName,
               et.code AS eventTypeCode, et.descripcion AS eventTypeDescripcion
        FROM employee_events ee
        JOIN employees e ON e.id = ee.employee_id
        LEFT JOIN event_types et ON et.id = ee.event_type_id
        WHERE 1=1
      `;
      const params = [];

      if (employeeId) {
        sql += ' AND ee.employee_id = ?';
        params.push(employeeId);
      }
      if (year) {
        sql += ' AND (YEAR(ee.fecha_desde) = ? OR YEAR(ee.fecha_hasta) = ?)';
        params.push(year, year);
      }
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        sql += ' AND e.tenant_id = ?';
        params.push(effectiveTenantId);
      }

      sql += ' ORDER BY ee.fecha_desde DESC';

      const [rows] = await db.query(sql, params);
      res.json({ success: true, events: rows });
    } catch (err) {
      console.error('ERROR fetching employee events:', err);
      res.status(500).json({ success: false, error: 'Error fetching employee events' });
    }
  });

  // ==========================
  // 2. CREAR EVENTO
  // ==========================
  router.post('/', requirePermission('leaves', 'create'), async (req, res) => {
    try {
      const { employeeId, eventTypeId, fechaDesde, fechaHasta, dias, observaciones } = req.body;

      if (!employeeId || !eventTypeId || !fechaDesde || !fechaHasta) {
        return res.status(400).json({ success: false, error: 'employeeId, eventTypeId, fechaDesde y fechaHasta son requeridos' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[employee]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (!employee || employee.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Empleado no encontrado' });
        }
      }

      const computedDias = dias !== undefined && dias !== null && dias !== ''
        ? Number(dias)
        : diffDaysInclusive(fechaDesde, fechaHasta);

      const [result] = await db.query(
        `INSERT INTO employee_events (employee_id, event_type_id, fecha_desde, fecha_hasta, dias, observaciones)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [employeeId, eventTypeId, fechaDesde, fechaHasta, computedDias, observaciones || null]
      );

      res.json({ success: true, id: result.insertId, dias: computedDias });
    } catch (err) {
      console.error('ERROR creating employee event:', err);
      res.status(500).json({ success: false, error: 'Error creating employee event' });
    }
  });

  // ==========================
  // 3. ACTUALIZAR EVENTO
  // ==========================
  router.put('/:id', requirePermission('leaves', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { eventTypeId, fechaDesde, fechaHasta, dias, observaciones } = req.body;

      if (!eventTypeId || !fechaDesde || !fechaHasta) {
        return res.status(400).json({ success: false, error: 'eventTypeId, fechaDesde y fechaHasta son requeridos' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[event]] = await db.query(
          `SELECT e.tenant_id FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE ee.id = ?`,
          [id]
        );
        if (!event || event.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Evento no encontrado' });
        }
      }

      const computedDias = dias !== undefined && dias !== null && dias !== ''
        ? Number(dias)
        : diffDaysInclusive(fechaDesde, fechaHasta);

      const [result] = await db.query(
        `UPDATE employee_events
         SET event_type_id = ?, fecha_desde = ?, fecha_hasta = ?, dias = ?, observaciones = ?
         WHERE id = ?`,
        [eventTypeId, fechaDesde, fechaHasta, computedDias, observaciones || null, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Evento no encontrado' });
      }

      res.json({ success: true, dias: computedDias });
    } catch (err) {
      console.error('ERROR updating employee event:', err);
      res.status(500).json({ success: false, error: 'Error updating employee event' });
    }
  });

  // ==========================
  // 4. ELIMINAR EVENTO
  // ==========================
  router.delete('/:id', requirePermission('leaves', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[event]] = await db.query(
          `SELECT e.tenant_id FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE ee.id = ?`,
          [id]
        );
        if (!event || event.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Evento no encontrado' });
        }
      }

      const [result] = await db.query('DELETE FROM employee_events WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Evento no encontrado' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deleting employee event:', err);
      res.status(500).json({ success: false, error: 'Error deleting employee event' });
    }
  });

  return router;
};
