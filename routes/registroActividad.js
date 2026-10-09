// Registro de actividad: quién hizo qué en la empresa (2026-10-09).
// Lo escribe registroActividad.js (raíz del repo); acá solo se lee.
//
// Cada empresa ve SOLO lo de su empresa (incluido lo que hizo el superadmin
// trabajando en ella como soporte: para eso existe). El superadmin, desde la
// plataforma, ve todo o filtra por empresa con ?tenantId=.
const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

// Límites del filtro: un instante en UTC (la pantalla manda el comienzo y el
// fin del día en SU hora local, ya pasados a UTC) o una fecha sola.
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
function limite(valor, finDelDia) {
  const v = String(valor || '');
  if (INSTANTE.test(v)) return v.slice(0, 19).replace('T', ' ');
  if (FECHA.test(v)) return `${v} ${finDelDia ? '23:59:59' : '00:00:00'}`;
  return null;
}

module.exports = function (db) {
  const router = express.Router();

  router.get('/', requirePermission('users', 'read'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    const where = [];
    const params = [];
    if (tenantId !== null) { where.push('r.tenant_id = ?'); params.push(tenantId); }
    const desde = limite(req.query.desde, false);
    const hasta = limite(req.query.hasta, true);
    if (desde) { where.push('r.creado_en >= ?'); params.push(desde); }
    if (hasta) { where.push('r.creado_en <= ?'); params.push(hasta); }
    if (req.query.email) { where.push('r.email LIKE ?'); params.push(`%${String(req.query.email).slice(0, 100)}%`); }
    if (req.query.soloSoporte === '1') where.push('r.como_soporte = 1');
    if (req.query.soloErrores === '1') where.push('r.estado >= 400');
    if (req.query.texto) {
      where.push('(r.descripcion LIKE ? OR r.detalle LIKE ?)');
      const t = `%${String(req.query.texto).slice(0, 100)}%`;
      params.push(t, t);
    }
    const condicion = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const porPagina = Math.min(Math.max(parseInt(req.query.porPagina, 10) || 50, 1), 200);
    const pagina = Math.max(parseInt(req.query.pagina, 10) || 1, 1);

    try {
      const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM registro_actividad r ${condicion}`, params);
      const [filas] = await db.query(
        `SELECT r.id, DATE_FORMAT(r.creado_en, '%Y-%m-%dT%H:%i:%sZ') AS creado_en, r.tenant_id, t.name AS empresa, r.app_user_id, r.email, r.como_soporte,
                r.metodo, r.ruta, r.descripcion, r.estado, r.detalle
           FROM registro_actividad r
           LEFT JOIN tenants t ON t.id = r.tenant_id
           ${condicion}
          ORDER BY r.creado_en DESC, r.id DESC
          LIMIT ? OFFSET ?`,
        [...params, porPagina, (pagina - 1) * porPagina]
      );
      res.json({ filas, total, pagina, porPagina, faltaMigracion: false });
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        return res.json({ filas: [], total: 0, pagina, porPagina, faltaMigracion: true });
      }
      console.error('ERROR leyendo registro de actividad:', err);
      res.status(500).json({ error: 'No se pudo leer el registro de actividad.' });
    }
  });

  return router;
};
