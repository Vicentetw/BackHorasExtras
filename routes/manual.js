const express = require('express');

module.exports = function(db, upload) {
  const router = express.Router();

  // ADD MANUAL ENTRY
  router.post('/add', async (req, res) => {
    try {
      const { userId, startDatetime, endDatetime, durationMinutes, type, note } = req.body;
      if (!userId || !startDatetime || !endDatetime || typeof durationMinutes !== 'number' || !type)
        return res.status(400).json({ error: 'Datos inválidos' });

      const start = startDatetime;
      const end = endDatetime;

      await db.query(`
        INSERT INTO ManualEntries
        (userId, startDatetime, endDatetime, durationMinutes, type, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, start, end, durationMinutes, type, note || null]);

      res.json({ ok: true, message: 'Registro manual guardado' });
    } catch(err) {
      console.error('ADD MANUAL ERROR:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  router.delete('/delete/:id', async (req,res)=>{
    const {id} = req.params;
    if (!id || isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    try {
      const [result] = await db.query(`DELETE FROM ManualEntries WHERE id=?`, [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Registro no encontrado' });
      res.json({ ok: true, deletedId: id });
    } catch(err) {
      console.error('DELETE MANUAL ERROR:', err);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  return router;
};