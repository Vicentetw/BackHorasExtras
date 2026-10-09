const express = require('express');
const { requirePermission, requireSuperadmin, resolveTenantId, resolveTenantForWrite, MENSAJE_ELEGIR_EMPRESA } = require('../appUserMiddleware');
const { registrar, autorDe } = require('../registroActividad');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // HELPERS
  // ==========================
  function parseDate(dateStr) {
    if (!dateStr) return null;
    return dateStr.split('T')[0]; // YYYY-MM-DD
  }

  // Mismo criterio que sucursales.js: la ciudad tiene que existir y ser de
  // la empresa del feriado. Ya no hay ciudades globales
  // (AISLAMIENTO_POR_EMPRESA.md, D).
  async function findCiudadOrNull(ciudadId, effectiveTenantId) {
    const [[row]] = await db.query('SELECT id, tenant_id FROM ciudades WHERE id = ?', [ciudadId]);
    if (!row) return null;
    if (effectiveTenantId !== null && row.tenant_id !== effectiveTenantId) return null;
    return row;
  }

  // NULL no es comparable de forma confiable en un unique key de MySQL (dos
  // filas con ciudad_id IS NULL no colisionan entre si) -- se valida el
  // duplicado (mismo tenant+fecha+ciudad) a mano antes de insertar/
  // actualizar, con <=> (null-safe equal) para que NULL SI compare igual a
  // NULL aca.
  async function findDuplicate(tenantId, date, ciudadId, excludeId) {
    const params = [tenantId, date, ciudadId ?? null];
    let sql = 'SELECT id FROM holidays WHERE tenant_id <=> ? AND date = ? AND ciudad_id <=> ?';
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    const [rows] = await db.query(sql, params);
    return rows.length > 0;
  }

  // ==========================
  // 1. LISTAR FERIADOS (con filtros)
  // ==========================
  router.get('/', requirePermission('holidays', 'read'), async (req, res) => {
    try {
      const { year, month, type } = req.query;

      let sql = `SELECT h.*, c.nombre AS ciudad_nombre
                  FROM holidays h
                  LEFT JOIN ciudades c ON c.id = h.ciudad_id
                  WHERE 1=1`;
      const params = [];

      // Ya no hace fallback a tenant_id IS NULL -- la migracion de la Fase A
      // (feriados globales -> por tenant) esta completa, no deberia quedar
      // ninguna fila sin tenant. Si alguna vez aparece una (import/bug), que
      // quede invisible para todos en vez de visible para todos: mas seguro
      // por default.
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        sql += ' AND h.tenant_id = ?';
        params.push(effectiveTenantId);
      }

      if (year) {
        sql += ' AND h.year = ?';
        params.push(parseInt(year));
      }

      if (month) {
        sql += ' AND MONTH(h.date) = ?';
        params.push(parseInt(month));
      }

      if (type) {
        sql += ' AND h.type = ?';
        params.push(type);
      }

      sql += ' ORDER BY h.date ASC';

      const [rows] = await db.query(sql, params);

      res.json({
        success: true,
        count: rows.length,
        holidays: rows
      });
    } catch (err) {
      console.error('ERROR fetching holidays:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' });
      }
      res.status(500).json({ success: false, error: 'Error fetching holidays' });
    }
  });

  // ==========================
  // 2. OBTENER UN FERIADO
  // ==========================
  router.get('/:id', requirePermission('holidays', 'read'), async (req, res) => {
    try {
      const { id } = req.params;

      const [rows] = await db.query('SELECT * FROM holidays WHERE id = ?', [id]);

      const effectiveTenantId = resolveTenantId(req);
      const belongsToTenant = rows.length > 0 && (
        effectiveTenantId === null || rows[0].tenant_id === effectiveTenantId
      );

      if (!belongsToTenant) {
        return res.status(404).json({ success: false, error: 'Holiday not found' });
      }

      res.json({ success: true, holiday: rows[0] });
    } catch (err) {
      console.error('ERROR fetching holiday:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' });
      }
      res.status(500).json({ success: false, error: 'Error fetching holiday' });
    }
  });

  // ==========================
  // 3. CREAR FERIADO
  // ==========================
  router.post('/', requirePermission('holidays', 'create'), async (req, res) => {
    try {
      const { date, name, description, type, reason, isWorkDay, recurring } = req.body;
      const ciudadId = req.body.ciudad_id ?? req.body.ciudadId ?? null;

      if (!date || !name) {
        return res.status(400).json({ success: false, error: 'Date and name are required' });
      }

      const year = new Date(date).getFullYear();
      // Siempre de UNA empresa: la propia, o la que eligio el superadmin.
      // Ya no se crean feriados globales (AISLAMIENTO_POR_EMPRESA.md, B): un
      // feriado como el Dia del Camino es de AVP, no de todas.
      const tenantId = resolveTenantForWrite(req);
      if (req.appUser && tenantId === null) {
        return res.status(400).json({ success: false, error: MENSAJE_ELEGIR_EMPRESA });
      }

      if (ciudadId) {
        const ciudad = await findCiudadOrNull(ciudadId, tenantId);
        if (!ciudad) {
          return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
        }
      }

      if (await findDuplicate(tenantId, date, ciudadId)) {
        return res.status(409).json({ success: false, error: 'Ya existe un feriado para esa fecha y ese alcance (empresa/ciudad)' });
      }

      const [result] = await db.query(
        `INSERT INTO holidays (tenant_id, ciudad_id, date, year, name, description, type, reason, isWorkDay, recurring)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          ciudadId,
          date,
          year,
          name,
          description || null,
          type || 'NATIONAL',
          reason || null,
          isWorkDay !== undefined ? (isWorkDay ? 1 : 0) : 0,
          recurring !== undefined ? (recurring ? 1 : 0) : 0
        ]
      );

      res.json({
        success: true,
        message: 'Holiday created',
        id: result.insertId
      });
    } catch (err) {
      console.error('ERROR creating holiday:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' });
      }
      res.status(500).json({ success: false, error: 'Error creating holiday' });
    }
  });

  // ==========================
  // 3b. CARGAR UN FERIADO EN VARIAS EMPRESAS (superadmin, 2026-10-09)
  // ==========================
  // Para un feriado nacional nuevo (ej. un feriado puente decretado): el
  // superadmin elige las empresas y se crea UNA COPIA en cada una. No es un
  // feriado "global": cada empresa queda con el suyo y lo puede editar o
  // borrar sin afectar a las demás. Si una empresa ya tiene un feriado
  // general ese día, se saltea (no se duplica ni se pisa).
  // Cada copia queda en el registro de actividad DE ESA EMPRESA, a nombre del
  // superadmin: su administrador ve quién se lo cargó.
  router.post('/varias-empresas', requireSuperadmin, async (req, res) => {
    try {
      const { date, name, description, type, reason, isWorkDay, recurring } = req.body;
      const empresas = Array.isArray(req.body.tenantIds)
        ? [...new Set(req.body.tenantIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
        : [];
      if (!date || !name) return res.status(400).json({ success: false, error: 'Faltan la fecha y el nombre del feriado.' });
      if (!empresas.length) return res.status(400).json({ success: false, error: 'Elegí al menos una empresa.' });

      const [existentes] = await db.query('SELECT id, name FROM tenants WHERE id IN (?)', [empresas]);
      const nombres = new Map(existentes.map((t) => [t.id, t.name]));
      const fecha = parseDate(date);
      const year = new Date(fecha).getFullYear();
      const creados = []; const salteados = [];

      for (const tenantId of empresas) {
        if (!nombres.has(tenantId)) { salteados.push({ tenantId, motivo: 'La empresa no existe' }); continue; }
        if (await findDuplicate(tenantId, fecha, null)) {
          salteados.push({ tenantId, empresa: nombres.get(tenantId), motivo: 'Ya tenía un feriado ese día' });
          continue;
        }
        const [r] = await db.query(
          `INSERT INTO holidays (tenant_id, ciudad_id, date, year, name, description, type, reason, isWorkDay, recurring)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tenantId, fecha, year, name, description || null, type || 'NATIONAL', reason || null,
            isWorkDay ? 1 : 0, recurring ? 1 : 0]
        );
        creados.push({ tenantId, empresa: nombres.get(tenantId), id: r.insertId });
        await registrar(db, {
          // Lo hizo el equipo de la plataforma en esta empresa: se marca como soporte.
          ...autorDe(req), comoSoporte: true, tenantId, metodo: 'POST', ruta: '/api/holidays/varias-empresas',
          descripcion: `Creó un feriado (cargado por el superadmin en varias empresas): ${fecha} ${name}`.slice(0, 255),
          estado: 200, detalle: JSON.stringify({ id: r.insertId, date: fecha, name, type: type || 'NATIONAL' }),
        });
      }
      res.json({ success: true, creados, salteados });
    } catch (err) {
      console.error('ERROR creating holiday in several tenants:', err);
      res.status(500).json({ success: false, error: 'No se pudo cargar el feriado en las empresas elegidas.' });
    }
  });

  // ==========================
  // 4. ACTUALIZAR FERIADO
  // ==========================
  router.put('/:id', requirePermission('holidays', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const { date, name, description, type, reason, isWorkDay, recurring } = req.body;
      const ciudadId = req.body.ciudad_id ?? req.body.ciudadId ?? null;

      if (!date || !name) {
        return res.status(400).json({ success: false, error: 'Date and name are required' });
      }

      const [[existing]] = await db.query('SELECT tenant_id FROM holidays WHERE id = ?', [id]);
      const effectiveTenantId = resolveTenantId(req);
      if (!existing || (effectiveTenantId !== null && existing.tenant_id !== effectiveTenantId)) {
        // Un usuario normal solo edita SUS propios feriados -- los globales
        // (tenant_id NULL, ej. feriados nacionales) son de solo lectura para
        // el, edicion reservada al superadmin.
        return res.status(404).json({ success: false, error: 'Holiday not found' });
      }

      if (ciudadId) {
        // La ciudad tiene que ser de la empresa DEL FERIADO (tambien cuando
        // edita el superadmin).
        const ciudad = await findCiudadOrNull(ciudadId, existing.tenant_id);
        if (!ciudad) {
          return res.status(404).json({ success: false, error: 'Ciudad no encontrada' });
        }
      }

      if (await findDuplicate(existing.tenant_id, date, ciudadId, id)) {
        return res.status(409).json({ success: false, error: 'Ya existe un feriado para esa fecha y ese alcance (empresa/ciudad)' });
      }

      const year = new Date(date).getFullYear();

      await db.query(
        `UPDATE holidays SET
          date = ?, year = ?, name = ?, description = ?, type = ?,
          reason = ?, isWorkDay = ?, recurring = ?, ciudad_id = ?
         WHERE id = ?`,
        [
          date,
          year,
          name,
          description || null,
          type || 'NATIONAL',
          reason || null,
          isWorkDay !== undefined ? (isWorkDay ? 1 : 0) : 0,
          recurring !== undefined ? (recurring ? 1 : 0) : 0,
          ciudadId,
          id
        ]
      );

      res.json({ success: true, message: 'Holiday updated' });
    } catch (err) {
      console.error('ERROR updating holiday:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' });
      }
      res.status(500).json({ success: false, error: 'Error updating holiday' });
    }
  });

  // ==========================
  // 5. ELIMINAR FERIADO
  // ==========================
  router.delete('/:id', requirePermission('holidays', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM holidays WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ success: false, error: 'Holiday not found' });
        }
      }

      await db.query('DELETE FROM holidays WHERE id = ?', [id]);

      res.json({ success: true, message: 'Holiday deleted' });
    } catch (err) {
      console.error('ERROR deleting holiday:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' });
      }
      res.status(500).json({ success: false, error: 'Error deleting holiday' });
    }
  });

  // ==========================
  // 6. IMPORTAR DESDE CSV
  // ==========================
  router.post('/import', requirePermission('holidays', 'create'), async (req, res) => {
    try {
      const { holidays } = req.body;

      if (!Array.isArray(holidays) || holidays.length === 0) {
        return res.status(400).json({ success: false, error: 'No holidays to import' });
      }

      let imported = 0;
      let skipped = 0;
      // Siempre de UNA empresa (ver CREAR FERIADO).
      const tenantId = resolveTenantForWrite(req);
      if (req.appUser && tenantId === null) {
        return res.status(400).json({ success: false, error: MENSAJE_ELEGIR_EMPRESA });
      }

      for (const h of holidays) {
        if (!h.date || !h.name) {
          skipped++;
          continue;
        }

        const year = new Date(h.date).getFullYear();

        // Upsert: actualizar si existe, insertar si no -- acotado SOLO a la
        // propia empresa. Antes tambien buscaba entre los globales: importar
        // en una empresa podia MODIFICAR un feriado que veian todas.
        const [existing] = tenantId !== null
          ? await db.query('SELECT id FROM holidays WHERE date = ? AND tenant_id = ?', [h.date, tenantId])
          : await db.query('SELECT id FROM holidays WHERE date = ? AND tenant_id IS NULL', [h.date]);

        if (existing.length > 0) {
          await db.query(
            `UPDATE holidays SET
              name = ?, description = ?, type = ?, reason = ?,
              isWorkDay = ?, recurring = ?, year = ?
             WHERE id = ?`,
            [
              h.name,
              h.description || null,
              h.type || 'NATIONAL',
              h.reason || null,
              h.isWorkDay ? 1 : 0,
              h.recurring ? 1 : 0,
              year,
              existing[0].id
            ]
          );
        } else {
          await db.query(
            `INSERT INTO holidays (tenant_id, date, year, name, description, type, reason, isWorkDay, recurring)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              tenantId,
              h.date,
              year,
              h.name,
              h.description || null,
              h.type || 'NATIONAL',
              h.reason || null,
              h.isWorkDay ? 1 : 0,
              h.recurring ? 1 : 0
            ]
          );
        }
        imported++;
      }

      res.json({
        success: true,
        message: `Importados: ${imported}, Omitidos: ${skipped}`
      });
    } catch (err) {
      console.error('ERROR importing holidays:', err);
      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({ success: false, error: 'Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.' });
      }
      res.status(500).json({ success: false, error: 'Error importing holidays' });
    }
  });

  return router;
};
