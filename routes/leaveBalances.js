const express = require('express');
const { resolveTenantId, requirePermission } = require('../appUserMiddleware');

module.exports = function (db) {
  const router = express.Router();

  // GET /api/leave-balances/suggest/:legajo?year= -- dias sugeridos para
  // ese empleado segun su antiguedad a esa fecha (1/enero del anio pedido,
  // criterio simple y transparente) y la escala vigente. Es solo una
  // sugerencia -- el admin puede pisarla a mano (isAutomatic=false).
  // OJO orden: tiene que registrarse ANTES de '/:legajo/:year' -- sino
  // Express interpreta "suggest" como el legajo y nunca llega aca.
  router.get('/suggest/:legajo', requirePermission('leaves', 'read'), async (req, res) => {
    try {
      const { legajo } = req.params;
      const year = Number(req.query.year) || new Date().getFullYear();

      const [[employee]] = await db.query(
        `SELECT id, tenant_id, fecha_alta FROM employees WHERE employee_id = ?`,
        [legajo]
      );
      const effectiveTenantId = resolveTenantId(req);
      if (!employee || (effectiveTenantId !== null && employee.tenant_id !== effectiveTenantId)) {
        return res.status(404).json({ success: false, error: 'Empleado no encontrado' });
      }
      if (!employee.fecha_alta) {
        return res.json({ success: true, suggestedDays: null, years: null, reason: 'El empleado no tiene fecha de alta cargada' });
      }

      const tenantForScale = employee.tenant_id;
      let [scaleRows] = await db.query(
        `SELECT min_years, max_years, days FROM vacation_scale WHERE tenant_id = ? ORDER BY min_years ASC`,
        [tenantForScale]
      );
      if (scaleRows.length === 0) {
        [scaleRows] = await db.query(
          `SELECT min_years, max_years, days FROM vacation_scale WHERE tenant_id IS NULL ORDER BY min_years ASC`
        );
      }

      const referenceDate = new Date(year, 0, 1); // antiguedad al 1/enero del anio del saldo
      const altaDate = new Date(employee.fecha_alta);
      const years = Math.max(0, (referenceDate - altaDate) / (365.25 * 24 * 60 * 60 * 1000));

      const step = scaleRows.find(s => years >= s.min_years && (s.max_years === null || years < s.max_years));
      res.json({
        success: true,
        suggestedDays: step ? step.days : null,
        years: Number(years.toFixed(1))
      });
    } catch (err) {
      console.error('ERROR suggesting vacation days:', err);
      res.status(500).json({ success: false, error: 'Error suggesting vacation days' });
    }
  });

  // GET /api/leave-balances/vacation-scale -- ver mas abajo el bloque 4
  // completo (GET+POST); tiene que ir registrado antes de '/:legajo/:year'
  // por el mismo motivo que /suggest/:legajo (Express matchea por orden).
  router.get('/vacation-scale', requirePermission('leaves', 'read'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      let rows;
      if (effectiveTenantId !== null) {
        [rows] = await db.query(
          `SELECT id, min_years, max_years, days FROM vacation_scale WHERE tenant_id = ? ORDER BY min_years ASC`,
          [effectiveTenantId]
        );
        if (rows.length === 0) {
          [rows] = await db.query(
            `SELECT id, min_years, max_years, days FROM vacation_scale WHERE tenant_id IS NULL ORDER BY min_years ASC`
          );
        }
      } else {
        [rows] = await db.query(
          `SELECT id, min_years, max_years, days, tenant_id AS tenantId FROM vacation_scale WHERE tenant_id IS NULL ORDER BY min_years ASC`
        );
      }
      res.json({ success: true, scale: rows });
    } catch (err) {
      console.error('ERROR fetching vacation scale:', err);
      res.status(500).json({ success: false, error: 'Error fetching vacation scale' });
    }
  });

  router.post('/vacation-scale', requirePermission('leaves', 'update'), async (req, res) => {
    try {
      const { scale } = req.body;
      if (!Array.isArray(scale) || scale.length === 0) {
        return res.status(400).json({ success: false, error: 'scale debe ser un array no vacío' });
      }
      for (const step of scale) {
        if (!Number.isFinite(Number(step.minYears)) || !Number.isFinite(Number(step.days))) {
          return res.status(400).json({ success: false, error: 'Cada escalón necesita minYears y days numéricos' });
        }
      }

      const effectiveTenantId = resolveTenantId(req);
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        if (effectiveTenantId !== null) {
          await conn.query('DELETE FROM vacation_scale WHERE tenant_id = ?', [effectiveTenantId]);
        } else {
          await conn.query('DELETE FROM vacation_scale WHERE tenant_id IS NULL');
        }
        for (const step of scale) {
          await conn.query(
            'INSERT INTO vacation_scale (tenant_id, min_years, max_years, days) VALUES (?, ?, ?, ?)',
            [effectiveTenantId, Number(step.minYears), step.maxYears === null || step.maxYears === undefined ? null : Number(step.maxYears), Number(step.days)]
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR saving vacation scale:', err);
      res.status(500).json({ success: false, error: 'Error saving vacation scale' });
    }
  });

  // ==========================
  // 1. SALDO DE UN EMPLEADO PARA UN AÑO
  // GET /api/leave-balances/:legajo/:year
  // El parámetro es el LEGAJO (employees.employee_id), no el id interno —
  // porque así es como attendance.html identifica empleados en todos lados
  // (viene de /attendance-range, que expone legajo, no el id interno de la
  // tabla employees). Se resuelve acá adentro para no filtrar por la columna
  // equivocada y devolver siempre 0.
  // ==========================
  router.get('/:legajo/:year', requirePermission('leaves', 'read'), async (req, res) => {
    try {
      const { legajo, year } = req.params;

      const [[employee]] = await db.query(
        `SELECT id, tenant_id FROM employees WHERE employee_id = ?`,
        [legajo]
      );
      const effectiveTenantId = resolveTenantId(req);
      if (!employee || (effectiveTenantId !== null && employee.tenant_id !== effectiveTenantId)) {
        return res.status(404).json({ success: false, error: 'Empleado no encontrado' });
      }
      const employeeId = employee.id;

      const [[balanceRow]] = await db.query(
        `SELECT allotted_days, notes, expiration_date, is_automatic FROM employee_leave_balances WHERE employee_id = ? AND year = ?`,
        [employeeId, year]
      );

      // balance_year explicito (arrastre entre anios) tiene prioridad sobre
      // inferir el anio de la fecha del evento -- asi un mismo evento puede
      // descontar del saldo de un anio aunque las fechas caigan en otro
      // (ej. licencia de fin de diciembre que se carga contra el saldo del
      // anio siguiente a proposito).
      const [[takenRow]] = await db.query(
        `SELECT COALESCE(SUM(ee.dias), 0) AS taken
         FROM employee_events ee
         JOIN event_types et ON et.id = ee.event_type_id
         WHERE ee.employee_id = ? AND et.code = 'VACACIONES'
           AND COALESCE(ee.balance_year, YEAR(ee.fecha_desde)) = ?`,
        [employeeId, year]
      );

      const allotted = balanceRow ? Number(balanceRow.allotted_days) : 0;
      const taken = Number(takenRow.taken);

      res.json({
        success: true,
        employeeId: Number(legajo),
        year: Number(year),
        allotted,
        taken,
        pending: Number((allotted - taken).toFixed(2)),
        notes: balanceRow ? balanceRow.notes : null,
        expirationDate: balanceRow ? balanceRow.expiration_date : null,
        isAutomatic: balanceRow ? !!balanceRow.is_automatic : false
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
  router.get('/', requirePermission('leaves', 'read'), async (req, res) => {
    try {
      const year = req.query.year || new Date().getFullYear();
      const effectiveTenantId = resolveTenantId(req);
      const tenantClause = effectiveTenantId !== null ? 'AND e.tenant_id = ?' : '';
      const tenantParams = effectiveTenantId !== null ? [effectiveTenantId] : [];

      const [rows] = await db.query(
        `SELECT e.id AS employeeId, e.employee_id AS legajo, e.nombre AS employeeName,
                e.fecha_alta AS fechaAlta,
                COALESCE(b.allotted_days, 0) AS allotted,
                COALESCE((
                  SELECT SUM(ee.dias) FROM employee_events ee
                  JOIN event_types et ON et.id = ee.event_type_id
                  WHERE ee.employee_id = e.id AND et.code = 'VACACIONES'
                    AND COALESCE(ee.balance_year, YEAR(ee.fecha_desde)) = ?
                ), 0) AS taken,
                b.notes,
                b.expiration_date AS expirationDate,
                b.is_automatic AS isAutomatic
         FROM employees e
         LEFT JOIN employee_leave_balances b ON b.employee_id = e.id AND b.year = ?
         WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)
           ${tenantClause}
         ORDER BY e.nombre ASC`,
        [year, year, ...tenantParams]
      );

      const balances = rows.map(r => ({
        ...r,
        allotted: Number(r.allotted),
        taken: Number(r.taken),
        pending: Number((Number(r.allotted) - Number(r.taken)).toFixed(2)),
        isAutomatic: !!r.isAutomatic
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
  router.post('/', requirePermission('leaves', 'update'), async (req, res) => {
    try {
      const { employeeId, year, allottedDays, notes, expirationDate, isAutomatic } = req.body;

      if (!employeeId || !year || allottedDays === undefined) {
        return res.status(400).json({ success: false, error: 'employeeId, year y allottedDays son requeridos' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[employee]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (!employee || employee.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Empleado no encontrado' });
        }
      }

      await db.query(
        `INSERT INTO employee_leave_balances (employee_id, year, allotted_days, notes, expiration_date, is_automatic)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE allotted_days = VALUES(allotted_days), notes = VALUES(notes),
           expiration_date = VALUES(expiration_date), is_automatic = VALUES(is_automatic)`,
        [employeeId, year, allottedDays, notes || null, expirationDate || null, isAutomatic ? 1 : 0]
      );

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR saving leave balance:', err);
      res.status(500).json({ success: false, error: 'Error saving leave balance' });
    }
  });

  return router;
};
