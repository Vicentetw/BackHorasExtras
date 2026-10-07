const express = require('express');
const { resolveTenantId, requirePermission, requireAnyPermission } = require('../appUserMiddleware');
const eventTypeCountModeRepository = require('../motor-laboral/repositories/eventTypeCountModeRepository');
const cupoMotivoRepository = require('../motor-laboral/repositories/cupoMotivoRepository');
const licenciasLargasRepository = require('../motor-laboral/repositories/licenciasLargasRepository');
const { hoyDeEmpresa } = require('../motor-laboral/services/hoyEmpresa');

module.exports = function (db) {
  const router = express.Router();

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
        // Toda licencia que TOQUE el año: empieza antes de que termine y
        // termina despues de que empieza. Antes era "año de inicio O año de
        // fin", y una licencia 2025-2028 no aparecia al mirar 2026 o 2027
        // (aunque si se aplicaba en Presentismo). Ver LICENCIAS_LARGAS.md, A.
        // Desde 1, no desde 1900: la pantalla recarga mientras se escribe, y
        // "20" camino a "2026" tiene que dar lista vacia, no un error.
        const anio = Number(year);
        if (!Number.isInteger(anio) || anio < 1 || anio > 9999) {
          return res.status(400).json({ success: false, error: 'Año inválido' });
        }
        sql += ' AND ee.fecha_desde <= ? AND ee.fecha_hasta >= ?';
        params.push(`${anio}-12-31`, `${anio}-01-01`);
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
  // 2. PREVIEW DE DIAS (calculo en vivo, ANTES de guardar)
  // GET /api/employee-events/preview-dias?eventTypeId=&from=&to=
  //
  // El dialogo de Licencias (frontend) antes calculaba los dias el mismo
  // ahi nomas (dias corridos siempre, a ciegas de feriados) y mandaba ese
  // numero ya hecho -- el backend casi nunca llegaba a calcularlo el.
  // Ahora que la modalidad (corridos/habiles) depende del motivo y puede
  // tener vigencias con fecha, SOLO el backend tiene todo lo necesario
  // (motor-laboral/services/leaveDaysCalculations.js + los feriados de la
  // tabla holidays) -- este endpoint es lo que el dialogo llama en vivo
  // mientras el usuario elige motivo/fechas, para mostrar el numero real
  // antes de guardar. POST/PUT de abajo usan la MISMA funcion si no les
  // mandan `dias` a mano -- nunca hay dos calculos que puedan divergir.
  // ==========================
  router.get('/preview-dias', requirePermission('leaves', 'read'), async (req, res) => {
    try {
      const { eventTypeId, from, to } = req.query;
      if (!eventTypeId || !from || !to) {
        return res.status(400).json({ success: false, error: 'eventTypeId, from y to son requeridos' });
      }
      if (from > to) {
        return res.status(400).json({ success: false, error: 'La fecha "desde" no puede ser posterior a "hasta"' });
      }

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[eventType]] = await db.query('SELECT tenant_id FROM event_types WHERE id = ?', [eventTypeId]);
        if (!eventType || eventType.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
        }
      }

      const dias = await eventTypeCountModeRepository.computeDiasLicencia(eventTypeId, from, to, db);
      res.json({ success: true, dias });
    } catch (err) {
      console.error('ERROR previewing dias:', err);
      res.status(500).json({ success: false, error: 'Error calculando los días' });
    }
  });

  // ==========================
  // 2b. VENCIMIENTO DE LICENCIAS LARGAS (avisos de Presentismo)
  // GET /api/employee-events/vencimientos?largaDesde=&porVencerDias=&fecha=
  //   largaDesde     desde cuantos dias una licencia es "larga" (vacio = apagado)
  //   porVencerDias  avisar cuantos dias antes (vacio = solo las vencidas)
  //   fecha          por defecto, hoy de la empresa
  // Los valores los manda Presentismo desde /config/avisos-asistencia (mismo
  // patron que /api/event-types/cupos/estado). Ver licenciasLargasRepository.
  // ==========================
  router.get('/vencimientos', requireAnyPermission([['attendance', 'read'], ['leaves', 'read']]), async (req, res) => {
    try {
      const tenantId = resolveTenantId(req);
      if (tenantId == null) return res.json({ success: true, filas: [] });
      const entero = (v, min, max) => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
      };
      const largaDesde = entero(req.query.largaDesde, 1, 3650);
      const porVencerDias = entero(req.query.porVencerDias, 1, 365);
      if (largaDesde === undefined || porVencerDias === undefined) {
        return res.status(400).json({ success: false, error: 'largaDesde (1-3650) y porVencerDias (1-365) deben ser enteros, o vacíos' });
      }
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : await hoyDeEmpresa(db, tenantId);
      const filas = await licenciasLargasRepository.vencimientosDeLicencias(db, tenantId, { fecha, largaDesde, porVencerDias });
      res.json({ success: true, fecha, filas });
    } catch (err) {
      console.error('ERROR fetching vencimientos de licencias:', err);
      res.status(500).json({ success: false, error: 'Error calculando los vencimientos de licencias' });
    }
  });

  // ==========================
  // 3. CREAR EVENTO
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

      // Cupo del motivo (migracion 20261005): 'bloquear' corta aca, 'avisar'
      // guarda y devuelve el aviso.
      const cupo = await cupoMotivoRepository.verificarCarga(db, {
        employeeInternalId: employeeId, eventTypeId, desde: fechaDesde, hasta: fechaHasta,
      });
      if (cupo.bloquear) return res.status(409).json({ success: false, error: cupo.mensaje, excesos: cupo.excesos });

      const computedDias = dias !== undefined && dias !== null && dias !== ''
        ? Number(dias)
        : await eventTypeCountModeRepository.computeDiasLicencia(eventTypeId, fechaDesde, fechaHasta, db);

      const [result] = await db.query(
        `INSERT INTO employee_events (employee_id, event_type_id, fecha_desde, fecha_hasta, dias, observaciones)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [employeeId, eventTypeId, fechaDesde, fechaHasta, computedDias, observaciones || null]
      );

      res.json({ success: true, id: result.insertId, dias: computedDias, avisoCupo: cupo.mensaje });
    } catch (err) {
      console.error('ERROR creating employee event:', err);
      res.status(500).json({ success: false, error: 'Error creating employee event' });
    }
  });

  // ==========================
  // 4. ACTUALIZAR EVENTO
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

      const [[actual]] = await db.query('SELECT employee_id FROM employee_events WHERE id = ?', [id]);
      const cupo = await cupoMotivoRepository.verificarCarga(db, {
        employeeInternalId: actual ? actual.employee_id : null, eventTypeId,
        desde: fechaDesde, hasta: fechaHasta, excluirLicenciaId: id,
      });
      if (cupo.bloquear) return res.status(409).json({ success: false, error: cupo.mensaje, excesos: cupo.excesos });

      const computedDias = dias !== undefined && dias !== null && dias !== ''
        ? Number(dias)
        : await eventTypeCountModeRepository.computeDiasLicencia(eventTypeId, fechaDesde, fechaHasta, db);

      const [result] = await db.query(
        `UPDATE employee_events
         SET event_type_id = ?, fecha_desde = ?, fecha_hasta = ?, dias = ?, observaciones = ?
         WHERE id = ?`,
        [eventTypeId, fechaDesde, fechaHasta, computedDias, observaciones || null, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Evento no encontrado' });
      }

      res.json({ success: true, dias: computedDias, avisoCupo: cupo.mensaje });
    } catch (err) {
      console.error('ERROR updating employee event:', err);
      res.status(500).json({ success: false, error: 'Error updating employee event' });
    }
  });

  // ==========================
  // 5. ELIMINAR EVENTO
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
