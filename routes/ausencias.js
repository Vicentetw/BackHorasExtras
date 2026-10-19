// /api/ausencias -- lo que necesita el formulario único "Cargar ausencia"
// (rediseño de ausencias, A, 2026-10-19; ver REDISENO_AUSENCIAS.md).
//
// El formulario pregunta quién, qué días y por qué, y guarda en el lugar que
// corresponde con las rutas de siempre (una justificación va a
// /config/user-exclusions con el USERID del reloj; una licencia va a
// /api/employee-events con el id interno del empleado). Esta ruta le da, para
// una persona, los dos números y su saldo de vacaciones del año, para poder
// mostrar "le quedan X; con esta carga quedarían Y" ANTES de guardar.
const express = require('express');
const { requireAnyPermission, resolveTenantId } = require('../appUserMiddleware');
const { saldos } = require('../motor-laboral/services/saldoVacaciones');

module.exports = function ausenciasRoutes(db) {
  const router = express.Router();

  router.get('/persona', requireAnyPermission([['exclusions', 'create'], ['leaves', 'create'], ['leaves', 'read']]), async (req, res) => {
    const tenantId = resolveTenantId(req);
    const legajo = String(req.query.legajo || '').trim();
    const anio = Number(req.query.anio) || new Date().getFullYear();
    if (!legajo) return res.status(400).json({ error: 'legajo es requerido' });
    try {
      const [[e]] = await db.query(
        `SELECT id, employee_id AS legajo, nombre, fecha_alta, tenant_id FROM employees
          WHERE employee_id = ? AND (? IS NULL OR tenant_id = ?) LIMIT 1`,
        [legajo, tenantId, tenantId]);
      if (!e) return res.status(404).json({ error: 'No se encontró esa persona' });
      // El USERID del reloj (para las justificaciones). Puede no tener: alguien
      // que todavía no está vinculado en Matching.
      const [[m]] = await db.query('SELECT USERID FROM user_employee_map WHERE employee_id = ? AND tenant_id = ? LIMIT 1', [e.id, e.tenant_id]);
      const saldo = (await saldos(db, e.tenant_id, anio, [{ id: e.id, fecha_alta: e.fecha_alta }])).get(e.id);
      res.json({
        employeeId: e.id,
        legajo: e.legajo,
        nombre: e.nombre,
        userId: m ? m.USERID : null,
        anio,
        saldoVacaciones: saldo,
      });
    } catch (err) {
      console.error('ERROR persona para ausencia:', err);
      res.status(500).json({ error: 'No se pudo leer la persona' });
    }
  });

  return router;
};
