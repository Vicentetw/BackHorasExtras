const express = require('express');

module.exports = function (db) {
  const router = express.Router();

  // ==========================
  // 1. LISTAR CATEGORÍAS
  // ==========================
  router.get('/', async (req, res) => {
    try {
      const { includeInactive } = req.query;
      const sql = includeInactive === 'true'
        ? 'SELECT * FROM employee_categories ORDER BY name ASC'
        : 'SELECT * FROM employee_categories WHERE active = 1 ORDER BY name ASC';
      const [rows] = await db.query(sql);
      res.json({ success: true, categories: rows });
    } catch (err) {
      console.error('ERROR fetching employee categories:', err);
      res.status(500).json({ success: false, error: 'Error fetching employee categories' });
    }
  });

  // ==========================
  // 2. CREAR CATEGORÍA
  // ==========================
  router.post('/', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name es requerido' });
      }

      const [result] = await db.query(
        'INSERT INTO employee_categories (name, active) VALUES (?, 1)',
        [name.trim()]
      );

      res.json({ success: true, id: result.insertId });
    } catch (err) {
      console.error('ERROR creating employee category:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una categoría con ese nombre' });
      }
      res.status(500).json({ success: false, error: 'Error creating employee category' });
    }
  });

  // ==========================
  // 3. RENOMBRAR / ACTUALIZAR CATEGORÍA
  // ==========================
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, active } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name es requerido' });
      }

      const [result] = await db.query(
        'UPDATE employee_categories SET name = ?, active = ? WHERE id = ?',
        [name.trim(), active !== undefined ? (active ? 1 : 0) : 1, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR updating employee category:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, error: 'Ya existe una categoría con ese nombre' });
      }
      res.status(500).json({ success: false, error: 'Error updating employee category' });
    }
  });

  // ==========================
  // 4. DESACTIVAR CATEGORÍA (soft delete, no rompe empleados ya asignados)
  // ==========================
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const [result] = await db.query('UPDATE employee_categories SET active = 0 WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Categoría no encontrada' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('ERROR deactivating employee category:', err);
      res.status(500).json({ success: false, error: 'Error deactivating employee category' });
    }
  });

  return router;
};
