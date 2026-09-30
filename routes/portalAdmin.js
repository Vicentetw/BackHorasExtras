// /api/portal-empleados -- el ADMINISTRADOR gestiona las cuentas del portal
// del empleado (migracion 20261010). Separado de /api/employees a proposito:
// el alta/edicion de empleados ya funciona y no se toca.
//
//   GET  /                         empleados con su mail y el estado de su cuenta
//   PUT  /:employeeId/email        { email }   cargar/corregir el mail
//   POST /invitar                  { employeeIds: [...] }  crea las cuentas y
//                                  Firebase les manda el mail para poner clave
//   POST /:employeeId/desactivar   corta el acceso (no borra nada)
//   POST /:employeeId/reactivar
//
// employeeId = employees.id (interno). Todo filtrado por la empresa de quien
// pide: un empleado de otra empresa responde igual que uno que no existe.
const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');
const appUserRepository = require('../motor-laboral/repositories/appUserRepository');
const { enviarEmailDeContrasena } = require('../motor-laboral/services/firebaseEmail');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Cada invitacion son varias llamadas a Firebase: de a tandas, para que un
// pedido nunca tarde tanto como para cortarse. El frontend manda las tandas.
const MAX_POR_TANDA = 50;

module.exports = function (db, { enviarEmail = enviarEmailDeContrasena } = {}) {
  const router = express.Router();

  function tenantONada(req, res) {
    const t = resolveTenantId(req);
    if (t == null) { res.status(400).json({ error: 'Elegí una empresa' }); return null; }
    return t;
  }

  async function empleadoDe(tenantId, employeeId) {
    const [[e]] = await db.query('SELECT id, employee_id AS legajo, nombre, email, activo FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, tenantId]);
    return e || null;
  }

  const faltaMigracion = (res, err) => {
    if (err.code === 'ER_BAD_FIELD_ERROR') { res.status(503).json({ error: 'Falta correr la migración 20261010 (portal del empleado).' }); return true; }
    return false;
  };

  router.get('/', requirePermission('users', 'read'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const [rows] = await db.query(
        `SELECT e.id, e.employee_id AS legajo, e.nombre, e.email, e.activo,
                u.id AS cuenta_id, u.is_active AS cuenta_activa, u.email AS cuenta_email, u.created_at AS invitado_el
         FROM employees e
         LEFT JOIN app_users u ON u.employee_id = e.id
         WHERE e.tenant_id = ? AND (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)
         ORDER BY e.nombre`, [tenantId]);
      res.json({
        empleados: rows.map((r) => ({
          id: r.id, legajo: r.legajo, nombre: r.nombre, email: r.email, activo: !!r.activo,
          cuenta: r.cuenta_id ? (r.cuenta_activa ? 'ACTIVA' : 'DESACTIVADA') : (r.email ? 'SIN_INVITAR' : 'SIN_EMAIL'),
          invitadoEl: r.invitado_el || null,
        })),
      });
    } catch (err) {
      if (faltaMigracion(res, err)) return;
      console.error('ERROR portal listar:', err);
      res.status(500).json({ error: 'Error leyendo los empleados' });
    }
  });

  router.put('/:employeeId/email', requirePermission('employees', 'update'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: 'Ese mail no parece válido.' });
    try {
      const e = await empleadoDe(tenantId, req.params.employeeId);
      if (!e) return res.status(404).json({ error: 'Empleado no encontrado' });
      // Con la cuenta ya creada, el mail de ingreso es el de la cuenta: se
      // cambia desactivando y volviendo a invitar, no en silencio desde aca.
      const [[cuenta]] = await db.query('SELECT id FROM app_users WHERE employee_id = ?', [e.id]);
      if (cuenta) return res.status(409).json({ error: 'Ya tiene cuenta: para cambiar el mail de ingreso, desactivala y volvé a invitar.' });
      await db.query('UPDATE employees SET email = ? WHERE id = ?', [email || null, e.id]);
      res.json({ ok: true });
    } catch (err) {
      if (faltaMigracion(res, err)) return;
      console.error('ERROR portal email:', err);
      res.status(500).json({ error: 'Error guardando el mail' });
    }
  });

  router.post('/invitar', requirePermission('users', 'create'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    const ids = [...new Set(((req.body || {}).employeeIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return res.status(400).json({ error: 'employeeIds es requerido' });
    if (ids.length > MAX_POR_TANDA) return res.status(400).json({ error: `De a ${MAX_POR_TANDA} por vez.` });
    const resultados = [];
    for (const id of ids) {
      try {
        const e = await empleadoDe(tenantId, id);
        if (!e) { resultados.push({ id, ok: false, error: 'Empleado no encontrado' }); continue; }
        if (!e.activo) { resultados.push({ id, ok: false, error: 'Está dado de baja' }); continue; }
        const [[ya]] = await db.query('SELECT id FROM app_users WHERE employee_id = ?', [e.id]);
        if (ya) { resultados.push({ id, ok: false, error: 'Ya tiene cuenta' }); continue; }
        if (!e.email) { resultados.push({ id, ok: false, error: 'No tiene mail cargado' }); continue; }
        // Sin rol ni permisos: una cuenta de empleado no los usa (ver
        // appUserMiddleware.js, lista blanca del portal).
        const cuenta = await appUserRepository.createInvitedUser({ email: e.email, tenantId, isSuperadmin: false }, db);
        await db.query('UPDATE app_users SET employee_id = ? WHERE id = ?', [e.id, cuenta.id]);
        const envio = await enviarEmail(e.email);
        resultados.push({ id, ok: true, emailEnviado: envio.enviado, ...(envio.enviado ? {} : { motivo: envio.motivo }) });
      } catch (err) {
        if (err.code === 'EMAIL_TAKEN') { resultados.push({ id, ok: false, error: 'Ese mail ya tiene una cuenta en el sistema' }); continue; }
        if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: 'Falta correr la migración 20261010 (portal del empleado).' });
        console.error('ERROR portal invitar:', err);
        resultados.push({ id, ok: false, error: 'No se pudo crear la cuenta' });
      }
    }
    res.json({ resultados, invitados: resultados.filter((r) => r.ok).length });
  });

  async function cambiarAcceso(req, res, activa) {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const e = await empleadoDe(tenantId, req.params.employeeId);
      if (!e) return res.status(404).json({ error: 'Empleado no encontrado' });
      const [r] = await db.query('UPDATE app_users SET is_active = ? WHERE employee_id = ? AND tenant_id = ?', [activa ? 1 : 0, e.id, tenantId]);
      if (!r.affectedRows) return res.status(404).json({ error: 'No tiene cuenta' });
      res.json({ ok: true });
    } catch (err) {
      if (faltaMigracion(res, err)) return;
      console.error('ERROR portal acceso:', err);
      res.status(500).json({ error: 'Error cambiando el acceso' });
    }
  }
  router.post('/:employeeId/desactivar', requirePermission('users', 'update'), (req, res) => cambiarAcceso(req, res, false));
  router.post('/:employeeId/reactivar', requirePermission('users', 'update'), (req, res) => cambiarAcceso(req, res, true));

  return router;
};
