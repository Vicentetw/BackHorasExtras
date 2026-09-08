const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const billingRepo = require('../motor-laboral/repositories/billingRepository');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

// Mismo criterio de resolucion que el resto del sistema (employees.js,
// admin.js): un usuario normal siempre importa para SU propia empresa,
// solo el superadmin puede elegir explicitamente para cual.
function effectiveTenantIdFor(req) {
  return req.appUser && !req.appUser.isSuperadmin
    ? req.appUser.tenantId
    : (req.body?.tenant_id || null);
}

// Bug real de seguridad (auditoria general): las 4 rutas de este archivo
// no tenian NINGUN requirePermission -- a diferencia del alta individual
// (routes/employees.js, que exige 'employees:create'), CUALQUIER usuario
// autenticado (con cualquier permiso, o ninguno especifico de empleados)
// podia subir/confirmar un import masivo de empleados. Mismo permiso que
// el alta individual, por consistencia.

console.log('🚀 Cargando import.routes.js v2.0 - con staging_employees');

// Mismo limite que horasdedica2.js -- ver ese comentario.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * 📥 SUBIR CSV → staging_employees (LEGACY - para RRHH)
 */
router.post('/employees/upload', requirePermission('employees', 'create'), upload.single('file'), async (req, res) => {
  try {
    const csv = req.file.buffer.toString('utf8');

    const records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      delimiter: ',' // ⚠️ CSV de RRHH
    });

    const batchId = Date.now().toString();
    // Bug real de seguridad (migracion 20260915): antes esta fila no
    // guardaba de que empresa era el lote -- sin este dato, GET
    // /employees/preview/:batchId y POST /employees/confirm/:batchId no
    // podian verificar dueño (el batchId, un timestamp en milisegundos,
    // no alcanza como control de acceso).
    const tenantId = effectiveTenantIdFor(req);

    for (const r of records) {
      await db.query(`
        INSERT INTO staging_employees
        (import_batch_id, employee_id, nombre, documento, tenant_id)
        VALUES (?, ?, ?, ?, ?)
      `, [
        batchId,
        r.employee_id || null,
        r.name || null,
        r.nrodocumento || null,
        tenantId
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
router.post('/employees', requirePermission('employees', 'create'), async (req, res) => {
  try {
    const { employees } = req.body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: 'Array de empleados requerido' });
    }

    const batchId = Date.now().toString();
    const tenantId = effectiveTenantIdFor(req);
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
            (import_batch_id, employee_id, nombre, documento, tipo_documento, direccion, zona_id, fecha_alta, fecha_baja, activo, tenant_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            employeeData.activo,
            tenantId
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
router.get('/employees/preview/:batchId', requirePermission('employees', 'create'), async (req, res) => {
  const { batchId } = req.params;
  // Bug real de seguridad (migracion 20260915): batchId es un timestamp
  // en milisegundos -- sin filtrar por tenant_id, alguien que coincidiera
  // (o adivinara) el batchId de otra empresa mientras esta sin confirmar
  // podia ver sus datos (nombre, DNI) antes de que esa empresa los cargue.
  const effectiveTenantId = resolveTenantId(req);
  const tenantClause = effectiveTenantId !== null ? 'AND (tenant_id IS NULL OR tenant_id = ?)' : '';
  const tenantParams = effectiveTenantId !== null ? [batchId, effectiveTenantId] : [batchId];

  const [rows] = await db.query(`
    SELECT * FROM staging_employees
    WHERE import_batch_id = ?
    ${tenantClause}
    ORDER BY id
  `, tenantParams);

  res.json(rows);
});

/**
 * ✅ CONFIRMAR IMPORT → employees
 */
router.post('/employees/confirm/:batchId', requirePermission('employees', 'create'), async (req, res) => {
  const { batchId } = req.params;

  try {
    // Bug real de seguridad (migracion 20260915): sin filtrar por
    // tenant_id, un usuario de OTRA empresa podia confirmar (crear como
    // empleados REALES, asignados a SU PROPIA empresa) el lote de otra
    // empresa que todavia estuviera sin confirmar, con solo acertar/
    // conocer el batchId (un timestamp en milisegundos).
    const effectiveTenantId = req.appUser && !req.appUser.isSuperadmin
      ? req.appUser.tenantId
      : (req.body?.tenant_id || null);
    const stagingTenantClause = effectiveTenantId !== null ? 'AND (tenant_id IS NULL OR tenant_id = ?)' : '';
    const stagingParams = effectiveTenantId !== null ? [batchId, effectiveTenantId] : [batchId];

    // Obtener datos del batch
    const [stagingRows] = await db.query(`
      SELECT * FROM staging_employees
      WHERE import_batch_id = ?
      ${stagingTenantClause}
    `, stagingParams);

    if (stagingRows.length === 0) {
      return res.status(404).json({ error: 'Batch no encontrado o ya procesado' });
    }

    // Fase 15 -- tope de empleados del plan contratado ("como una
    // telefonia"): un Excel de 60 filas no puede esquivar el mismo tope que
    // ya se aplica al alta individual (routes/employees.js). Se cuenta
    // ANTES de insertar nada cuantas filas van a ser altas NUEVAS de
    // verdad (excluyendo las que ya existen, que el loop de abajo iba a
    // saltear igual) y se rechaza el batch COMPLETO si se pasaria del tope
    // -- nada de "importar los primeros 5 y cortar a mitad de la lista".
    if (effectiveTenantId != null) {
      const [existingRows] = await db.query(
        `SELECT employee_id FROM employees WHERE employee_id IN (?)`,
        [stagingRows.map((r) => r.employee_id)]
      );
      const existingIds = new Set(existingRows.map((r) => r.employee_id));
      const newCount = stagingRows.filter((r) => !existingIds.has(r.employee_id)).length;
      const capacity = await billingRepo.checkEmployeeCapacity(effectiveTenantId, newCount, db);
      if (!capacity.allowed) {
        return res.status(409).json({
          error: `Este import agregaría ${newCount} empleados nuevos, pero tu plan (${capacity.planName}) permite hasta ${capacity.max} en total (ya tenés ${capacity.current}). Reducí la lista o cambiá a un plan superior.`,
          employeeCap: capacity
        });
      }
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

      // Insertar en employees. OJO -- bug real encontrado armando el tope
      // de empleados (Fase 15): esto usaba `row.tenant_id`, pero la fila de
      // staging NUNCA lo trae seteado (POST /employees de arriba no lo
      // guarda) -- todo empleado importado por Excel quedaba con
      // tenant_id NULL, sin excepcion. Se usa effectiveTenantId (misma
      // resolucion que el alta individual: la empresa del usuario logueado,
      // o la que mande explicitamente el superadmin) en su lugar.
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
        effectiveTenantId
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