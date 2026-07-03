const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');

console.log('🚀 Cargando import.routes.js v2.0 - con staging_employees');

const upload = multer({ storage: multer.memoryStorage() });

/**
 * 📥 SUBIR CSV → staging_employees (LEGACY - para RRHH)
 */
router.post('/employees/upload', upload.single('file'), async (req, res) => {
  try {
    const csv = req.file.buffer.toString('utf8');

    const records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      delimiter: ',' // ⚠️ CSV de RRHH
    });

    const batchId = Date.now().toString();

    for (const r of records) {
      await db.query(`
        INSERT INTO staging_employees
        (import_batch_id, employee_id, nombre, documento)
        VALUES (?, ?, ?, ?)
      `, [
        batchId,
        r.employee_id || null,
        r.name || null,
        r.nrodocumento || null
      ]);
    }

    res.json({
      ok: true,
      batchId,
      total: records.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error importando CSV' });
  }
});

/**
 * 📥 IMPORTAR EMPLEADOS DESDE JSON (desde frontend Excel)
 * POST /api/import/employees
 * Retorna status detallado de CADA fila para permitir correcciones
 */
router.post('/employees', async (req, res) => {
  try {
    const { employees } = req.body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: 'Array de empleados requerido' });
    }

    const batchId = Date.now().toString();
    const rows = []; // Resultado por fila

    for (let idx = 0; idx < employees.length; idx++) {
      const emp = employees[idx];
      const rowNum = idx + 1;
      let status = 'success';
      let message = null;
      let data = null;

      try {
        // Mapear campos comunes (flexible para diferentes formatos Excel)
        const employeeData = {
          employee_id: emp.employee_id || emp.legajo || emp['Employee ID'] || emp['Legajo'] || null,
          nombre: emp.nombre || emp.name || emp['Nombre'] || emp['Name'] || null,
          documento: emp.documento || emp.nrodocumento || emp['Documento'] || emp['DNI'] || null,
          tipo_documento: emp.tipo_documento || emp['Tipo Documento'] || 1,
          direccion: emp.direccion || emp['Dirección'] || emp['Direccion'] || null,
          zona: emp.zona || emp['Zona'] || null,
          fecha_alta: emp.fecha_alta || emp['Fecha Alta'] || emp['Fecha_Alta'] || null,
          fecha_baja: emp.fecha_baja || emp['Fecha Baja'] || emp['Fecha_Baja'] || null,
          activo: emp.activo !== undefined ? emp.activo : (emp['Activo'] !== undefined ? emp['Activo'] : true),
          legajo_alt: emp.legajo_alt || emp['Legajo Alt'] || null
        };

        // Validaciones básicas
        if (!employeeData.employee_id) {
          status = 'error';
          message = 'Falta: Employee ID / Legajo (requerido)';
        } else if (!employeeData.nombre) {
          status = 'error';
          message = 'Falta: Nombre (requerido)';
        } else {
          // Insertar en staging
          await db.query(`
            INSERT INTO staging_employees
            (import_batch_id, employee_id, nombre, documento, tipo_documento, direccion, zona_id, fecha_alta, fecha_baja, activo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            batchId,
            employeeData.employee_id,
            employeeData.nombre,
            employeeData.documento,
            employeeData.tipo_documento,
            employeeData.direccion,
            employeeData.zona,
            employeeData.fecha_alta || null,
            employeeData.fecha_baja || null,
            employeeData.activo
          ]);
          message = 'Listo para confirmar';
          data = employeeData;
        }
      } catch (err) {
        status = 'error';
        message = err.message;
      }

      rows.push({
        row: rowNum,
        status,
        message,
        data: data || emp
      });
    }

    const success = rows.filter(r => r.status === 'success').length;
    const errors = rows.filter(r => r.status === 'error').length;

    res.json({
      ok: true,
      batchId,
      summary: {
        total: employees.length,
        success,
        errors
      },
      rows // Detalle por fila - IMPORTANTE!
    });

  } catch (err) {
    console.error('Error importing employees:', err);
    res.status(500).json({ error: 'Error importando empleados', details: err.message });
  }
});

/**
 * 👁️ PREVIEW DEL BATCH
 */
router.get('/employees/preview/:batchId', async (req, res) => {
  const { batchId } = req.params;

  const [rows] = await db.query(`
    SELECT * FROM staging_employees
    WHERE import_batch_id = ?
    ORDER BY id
  `, [batchId]);

  res.json(rows);
});

/**
 * ✅ CONFIRMAR IMPORT → employees
 */
router.post('/employees/confirm/:batchId', async (req, res) => {
  const { batchId } = req.params;

  try {
    // Obtener datos del batch
    const [stagingRows] = await db.query(`
      SELECT * FROM staging_employees
      WHERE import_batch_id = ?
    `, [batchId]);

    if (stagingRows.length === 0) {
      return res.status(404).json({ error: 'Batch no encontrado o ya procesado' });
    }

    let inserted = 0;
    let skipped = 0;
    let errors = [];

    for (const row of stagingRows) {
      console.log('Procesando empleado:', row.employee_id, row.nombre);
      
      // Verificar si ya existe
      const [existing] = await db.query(
        'SELECT id FROM employees WHERE employee_id = ?',
        [row.employee_id]
      );
      
      console.log('Empleado existente:', existing.length);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      console.log('Insertando empleado...');
      
      // Insertar en employees (incluye tenant_id si viene en el CSV)
      await db.query(`
        INSERT INTO employees
        (employee_id, nombre, documento, tipo_documento, direccion, zona_id, zona_real_id, fecha_alta, fecha_baja, activo, overtime_authorized, exclude_from_report, legajo_alt, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        row.employee_id,
        row.nombre,
        row.documento,
        row.tipo_documento || 1,
        row.direccion,
        row.zona_id,
        row.zona_real_id,
        row.fecha_alta,
        row.fecha_baja,
        row.activo !== undefined ? row.activo : true,
        row.overtime_authorized !== undefined ? (row.overtime_authorized ? 1 : 0) : 1,
        row.exclude_from_report !== undefined ? (row.exclude_from_report ? 1 : 0) : 0,
        row.legajo_alt,
        row.tenant_id || null
      ]);

      console.log('Empleado insertado correctamente');
      inserted++;
    }

    res.json({
      ok: true,
      inserted,
      skipped,
      errors,
      total: stagingRows.length
    });

  } catch (err) {
    console.error('Error confirming import:', err);
    res.status(500).json({ error: 'Error confirmando importación' });
  }
});

module.exports = router;