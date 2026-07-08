const express = require('express');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR MOTIVOS
  // ==========================
  router.get('/', async (req, res) => {
    try {
      const { includeInactive } = req.query;
      const sql = includeInactive === 'true'
        ? 'SELECT * FROM event_types ORDER BY descripcion ASC'
        : 'SELECT * FROM event_types WHERE active = 1 ORDER BY descripcion ASC';
      const [rows] = await db.query(sql);
      res.json({ success: true, eventTypes: rows });
    } catch (err) {
      console.error('ERROR fetching event types:', err);
      res.status(500).json({ success: false, error: 'Error fetching event types' });
    }
  });

  // ==========================
  // 2. CREAR MOTIVO
  // ==========================
  router.post('/', async (req, res) => {
    try {
      const { code, descripcion, descuenta_vacaciones, requiere_aprobacion } = req.body;

      if (!code || !descripcion) {
        return res.status(400).json({ success: false, error: 'code y descripcion son requeridos' });
      }

      const [result] = await db.query(
        `INSERT INTO event_types (code, descripcion, descuenta_vacaciones, requiere_aprobacion, active)
         VALUES (?, ?, ?, ?, 1)`,
        [code, descripcion, descuenta_vacaciones ? 1 : 0, requiere_aprobacion ? 1 : 0]
      );

      res.json({ success: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating event type:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe un motivo con ese código' });
      }
      res.status(500).json({ success: false, error: 'Error creating event type' });
    }
  });

  // ==========================
  // 3. ACTUALIZAR MOTIVO
  // ==========================
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { code, descripcion, descuenta_vacaciones, requiere_aprobacion, active } = req.body;

      if (!code || !descripcion) {
        return res.status(400).json({ success: false, error: 'code y descripcion son requeridos' });
      }

      const [result] = await db.query(
        `UPDATE event_types SET code = ?, descripcion = ?, descuenta_vacaciones = ?, requiere_aprobacion = ?, active = ?
         WHERE id = ?`,
        [code, descripcion, descuenta_vacaciones ? 1 : 0, requiere_aprobacion ? 1 : 0, active !== undefined ? (active ? 1 : 0) : 1, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR updating event type:', err);
      res.status(500).json({ success: false, error: 'Error updating event type' });
    }
  });

  // ==========================
  // 4. DESACTIVAR MOTIVO (soft delete, para no romper exclusiones existentes que lo referencian)
  // ==========================
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await db.query('UPDATE event_types SET active = 0 WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Motivo no encontrado' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deactivating event type:', err);
      res.status(500).json({ success: false, error: 'Error deactivating event type' });
    }
  });

  return router;
};
