const express = require('express');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // HELPERS
  // ==========================
  function parseDate(dateStr) {
    if (!dateStr) return null;
    return dateStr.split('T')[0]; // YYYY-MM-DD
  }

  // ==========================
  // 1. LISTAR FERIADOS (con filtros)
  // ==========================
  router.get('/', async (req, res) => {
    try {
      const { year, month, type } = req.query;

      let sql = 'SELECT * FROM holidays WHERE 1=1';
      const params = [];

      if (year) {
        sql += ' AND year = ?';
        params.push(parseInt(year));
      }

      if (month) {
        sql += ' AND MONTH(date) = ?';
        params.push(parseInt(month));
      }

      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }

      sql += ' ORDER BY date ASC';

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
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;

      const [rows] = await db.query('SELECT * FROM holidays WHERE id = ?', [id]);

      if (rows.length === 0) {
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
  router.post('/', async (req, res) => {
    try {
      const { date, name, description, type, reason, isWorkDay, recurring } = req.body;

      if (!date || !name) {
        return res.status(400).json({ success: false, error: 'Date and name are required' });
      }

      const year = new Date(date).getFullYear();

      const [result] = await db.query(
        `INSERT INTO holidays (date, year, name, description, type, reason, isWorkDay, recurring)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
  // 4. ACTUALIZAR FERIADO
  // ==========================
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { date, name, description, type, reason, isWorkDay, recurring } = req.body;

      if (!date || !name) {
        return res.status(400).json({ success: false, error: 'Date and name are required' });
      }

      const year = new Date(date).getFullYear();

      await db.query(
        `UPDATE holidays SET 
          date = ?, year = ?, name = ?, description = ?, type = ?, 
          reason = ?, isWorkDay = ?, recurring = ?
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
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;

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
  router.post('/import', async (req, res) => {
    try {
      const { holidays } = req.body;

      if (!Array.isArray(holidays) || holidays.length === 0) {
        return res.status(400).json({ success: false, error: 'No holidays to import' });
      }

      let imported = 0;
      let skipped = 0;

      for (const h of holidays) {
        if (!h.date || !h.name) {
          skipped++;
          continue;
        }

        const year = new Date(h.date).getFullYear();

        // Upsert: actualizar si existe, insertar si no
        const [existing] = await db.query(
          'SELECT id FROM holidays WHERE date = ?',
          [h.date]
        );

        if (existing.length > 0) {
          await db.query(
            `UPDATE holidays SET 
              name = ?, description = ?, type = ?, reason = ?, 
              isWorkDay = ?, recurring = ?, year = ?
             WHERE date = ?`,
            [
              h.name,
              h.description || null,
              h.type || 'NATIONAL',
              h.reason || null,
              h.isWorkDay ? 1 : 0,
              h.recurring ? 1 : 0,
              year,
              h.date
            ]
          );
        } else {
          await db.query(
            `INSERT INTO holidays (date, year, name, description, type, reason, isWorkDay, recurring)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
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