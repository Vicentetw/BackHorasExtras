const express = require('express');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. SALDO DE UN EMPLEADO PARA UN AÑO
  // GET /api/leave-balances/:employeeId/:year
  // ==========================
  router.get('/:employeeId/:year', async (req, res) => {
    try {
      const { employeeId, year } = req.params;

      const [[balanceRow]] = await db.query(
        `SELECT allotted_days, notes FROM employee_leave_balances WHERE employee_id = ? AND year = ?`,
        [employeeId, year]
      );

      const [[takenRow]] = await db.query(
        `SELECT COALESCE(SUM(ee.dias), 0) AS taken
         FROM employee_events ee
         JOIN event_types et ON et.id = ee.event_type_id
         WHERE ee.employee_id = ? AND et.code = 'VACACIONES'
           AND (YEAR(ee.fecha_desde) = ? OR YEAR(ee.fecha_hasta) = ?)`,
        [employeeId, year, year]
      );

      const allotted = balanceRow ? Number(balanceRow.allotted_days) : 0;
      const taken = Number(takenRow.taken);

      res.json({
        success: true,
        employeeId: Number(employeeId),
        year: Number(year),
        allotted,
        taken,
        pending: Number((allotted - taken).toFixed(2)),
        notes: balanceRow ? balanceRow.notes : null
      });
    } catch (err) {
      console.error('ERROR fetching leave balance:', err);
      res.status(500).json({ success: false, error: 'Error fetching leave balance' });
    }
  });

  // ==========================
  // 2. LISTAR TODOS LOS SALDOS DE UN AÑO (para el panel de administración)
  // GET /api/leave-balances?year=2026
  // ==========================
  router.get('/', async (req, res) => {
    try {
      const year = req.query.year || new Date().getFullYear();

      const [rows] = await db.query(
        `SELECT e.id AS employeeId, e.employee_id AS legajo, e.nombre AS employeeName,
                COALESCE(b.allotted_days, 0) AS allotted,
                COALESCE((
                  SELECT SUM(ee.dias) FROM employee_events ee
                  JOIN event_types et ON et.id = ee.event_type_id
                  WHERE ee.employee_id = e.id AND et.code = 'VACACIONES'
                    AND (YEAR(ee.fecha_desde) = ? OR YEAR(ee.fecha_hasta) = ?)
                ), 0) AS taken,
                b.notes
         FROM employees e
         LEFT JOIN employee_leave_balances b ON b.employee_id = e.id AND b.year = ?
         WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)
         ORDER BY e.nombre ASC`,
        [year, year, year]
      );

      const balances = rows.map(r => ({
        ...r,
        allotted: Number(r.allotted),
        taken: Number(r.taken),
        pending: Number((Number(r.allotted) - Number(r.taken)).toFixed(2))
      }));

      res.json({ success: true, year: Number(year), balances });
    } catch (err) {
      console.error('ERROR listing leave balances:', err);
      res.status(500).json({ success: false, error: 'Error listing leave balances' });
    }
  });

  // ==========================
  // 3. ASIGNAR / ACTUALIZAR SALDO
  // POST /api/leave-balances
  // ==========================
  router.post('/', async (req, res) => {
    try {
      const { employeeId, year, allottedDays, notes } = req.body;

      if (!employeeId || !year || allottedDays === undefined) {
        return res.status(400).json({ success: false, error: 'employeeId, year y allottedDays son requeridos' });
      }

      await db.query(
        `INSERT INTO employee_leave_balances (employee_id, year, allotted_days, notes)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE allotted_days = VALUES(allotted_days), notes = VALUES(notes)`,
        [employeeId, year, allottedDays, notes || null]
      );

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR saving leave balance:', err);
      res.status(500).json({ success: false, error: 'Error saving leave balance' });
    }
  });

  return router;
};
