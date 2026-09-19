// ############################################################################
// ARCHIVO MUERTO -- NO SE USA. NO MONTAR SIN ARREGLARLO ANTES.
// ############################################################################
//
// Este router no lo requiere ni lo monta NADIE. El unico servidor del
// proyecto es horasdedica.js (es el unico archivo con `app.listen`) y su
// lista de `require('./routes/...')` no lo incluye. Verificado el 2026-09-19
// buscando "routes/manual" en todo el repo: 0 resultados fuera de este
// archivo.
//
// Las rutas que SI se usan para entradas manuales son, en horasdedica.js:
//   POST   /add/manual
//   PUT    /update/manual/:id
//   DELETE /delete/manual/:id
//
// POR QUE NO ALCANZA CON IGNORARLO. Si alguien lo monta tal como esta,
// entrega de una tres problemas que las rutas de verdad ya no tienen:
//   1. No tiene NINGUN middleware de permisos (las reales usan
//      requirePermission('attendance', ...)).
//   2. No filtra ni guarda `tenant_id`, asi que escribe y borra entradas de
//      cualquier empresa (ver migracion 20260927).
//   3. No deja rastro de auditoria: ni created_by ni manual_entry_log.
//
// Ya paso una vez que se gasto trabajo aca al pedo: el commit fd36be5
// ("8 endpoints de exclusiones podian tocar la justificacion de empleados de
// OTRA empresa") corrigio codigo de este archivo y de routes/dashboard.js,
// que no corre. Un arreglo de seguridad aplicado a codigo muerto da una
// sensacion de seguridad que no existe.
//
// QUE HACER: borrarlo. Se deja por ahora solo porque borrar archivos es
// decision del dueno del repo; git conserva el historial igual.
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