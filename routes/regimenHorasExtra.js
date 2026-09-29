// /api/regimen-horas-extra -- configuracion del regimen de horas extra (B4).
// Tablas: migracion 20261006. Diseño: HORAS_EXTRA_REGIMENES.md.
//
//   GET  /politicas                         historial (empresa + cada regimen)
//   POST /politicas                         nueva vigencia { conventionId|null, vigenteDesde, topes..., politica, ... }
//   GET  /autorizaciones?employeeId=        autorizaciones individuales de una persona
//   POST /autorizaciones                    { employeeId, vigenteDesde, vigenteHasta?, topeMes..., motivo }
//   GET  /aprobaciones?employeeId=&periodo= excedentes aprobados
//   POST /aprobaciones                      { employeeId, periodo:'AAAA-MM', minutos, motivo }
//
// Todo se escribe con autor (created_by) y no se borra: una configuracion que
// cambia se reemplaza con una vigencia nueva, asi un mes cerrado se sigue
// pudiendo recalcular con la regla que tenia.
const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

const POLITICAS = ['TAL_CUAL', 'AVISAR', 'NO_COMPUTAR', 'AUTORIZAR'];
const FUENTES = ['MARCADORES', 'FICHAJES', 'MARCADORES_O_ESTIMADO'];
const MODOS = ['ABAJO', 'CERCANO', 'ARRIBA'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// minutos: entero >= 0 o vacio (null). Devuelve undefined si es invalido.
function minutosOpcional(v, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
}

module.exports = function (db) {
  const router = express.Router();
  const autor = (req) => (req.appUser ? req.appUser.id : null);

  function tenantONada(req, res) {
    const t = resolveTenantId(req);
    if (t == null) { res.status(400).json({ error: 'Elegí una empresa' }); return null; }
    return t;
  }
  // Acepta el id interno (employeeId) o el legajo (legajo), que es con lo
  // que identifica a cada persona la pantalla de Presentismo.
  async function empleadoDeLaEmpresa(fuente, tenantId) {
    const porLegajo = fuente && fuente.legajo != null && fuente.legajo !== '';
    const valor = porLegajo ? fuente.legajo : fuente && fuente.employeeId;
    if (valor == null || valor === '') return null;
    const [[e]] = await db.query(
      `SELECT id FROM employees WHERE ${porLegajo ? 'employee_id' : 'id'} = ? AND tenant_id = ?`, [Number(valor), tenantId]);
    return e ? e.id : null;
  }

  router.get('/politicas', requirePermission('schedules', 'read'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const [rows] = await db.query(
        `SELECT p.*, c.name AS regimen, au.email AS created_by_email
         FROM overtime_regime_policies p
         LEFT JOIN labor_conventions c ON c.id = p.convention_id
         LEFT JOIN app_users au ON au.id = p.created_by
         WHERE p.tenant_id = ? ORDER BY p.convention_key, p.vigente_desde DESC`, [tenantId]);
      res.json({ politicas: rows });
    } catch (err) {
      console.error('ERROR regimen politicas:', err);
      res.status(500).json({ error: 'Error leyendo las políticas' });
    }
  });

  router.post('/politicas', requirePermission('schedules', 'update'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const b = req.body || {};
      const conventionId = b.conventionId == null || b.conventionId === '' ? null : Number(b.conventionId);
      if (conventionId != null) {
        const [[c]] = await db.query('SELECT id FROM labor_conventions WHERE id = ? AND tenant_id = ?', [conventionId, tenantId]);
        if (!c) return res.status(404).json({ error: 'Régimen no encontrado' });
      }
      if (!FECHA.test(b.vigenteDesde || '')) return res.status(400).json({ error: 'vigenteDesde (AAAA-MM-DD) es requerido' });
      const topes = {
        dia: minutosOpcional(b.topeDiaMinutos, 1440),
        mes: minutosOpcional(b.topeMesMinutos, 44640),
        anio: minutosOpcional(b.topeAnioMinutos, 527040),
        minimo: minutosOpcional(b.minimoMinutos, 1440),
        redondeo: minutosOpcional(b.redondeoMinutos, 120),
      };
      const invalido = Object.entries(topes).find(([, v]) => v === undefined);
      if (invalido) return res.status(400).json({ error: `${invalido[0]}: tiene que ser un número entero de minutos, o vacío` });
      const politica = b.politicaExcedente || 'AVISAR';
      const fuente = b.fuente || 'MARCADORES_O_ESTIMADO';
      const modo = b.redondeoModo || 'ABAJO';
      if (!POLITICAS.includes(politica) || !FUENTES.includes(fuente) || !MODOS.includes(modo)) {
        return res.status(400).json({ error: 'politicaExcedente, fuente o redondeoModo inválidos' });
      }
      const [r] = await db.query(
        `INSERT INTO overtime_regime_policies
           (tenant_id, convention_id, vigente_desde, tope_dia_minutos, tope_mes_minutos, tope_anio_minutos,
            politica_excedente, fuente, minimo_minutos, redondeo_minutos, redondeo_modo, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, conventionId, b.vigenteDesde, topes.dia, topes.mes, topes.anio, politica, fuente, topes.minimo, topes.redondeo, modo, autor(req)]
      );
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay una política con esa misma fecha para ese régimen' });
      console.error('ERROR regimen crear politica:', err);
      res.status(500).json({ error: 'Error guardando la política' });
    }
  });

  router.get('/autorizaciones', requirePermission('attendance', 'read'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const empId = await empleadoDeLaEmpresa(req.query, tenantId);
      if (!empId) return res.status(404).json({ error: 'Empleado no encontrado' });
      const [rows] = await db.query(
        `SELECT a.*, au.email AS created_by_email FROM employee_overtime_authorizations a
         LEFT JOIN app_users au ON au.id = a.created_by
         WHERE a.tenant_id = ? AND a.employee_id = ? ORDER BY a.vigente_desde DESC`, [tenantId, empId]);
      res.json({ autorizaciones: rows });
    } catch (err) {
      console.error('ERROR regimen autorizaciones:', err);
      res.status(500).json({ error: 'Error leyendo las autorizaciones' });
    }
  });

  router.post('/autorizaciones', requirePermission('attendance', 'update'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const b = req.body || {};
      const empId = await empleadoDeLaEmpresa(b, tenantId);
      if (!empId) return res.status(404).json({ error: 'Empleado no encontrado' });
      if (!FECHA.test(b.vigenteDesde || '')) return res.status(400).json({ error: 'vigenteDesde (AAAA-MM-DD) es requerido' });
      if (b.vigenteHasta && (!FECHA.test(b.vigenteHasta) || b.vigenteHasta < b.vigenteDesde)) {
        return res.status(400).json({ error: 'vigenteHasta tiene que ser una fecha posterior a vigenteDesde' });
      }
      const motivo = String(b.motivo || '').trim();
      if (!motivo) return res.status(400).json({ error: 'El motivo es obligatorio' });
      const dia = minutosOpcional(b.topeDiaMinutos, 1440);
      const mes = minutosOpcional(b.topeMesMinutos, 44640);
      const anio = minutosOpcional(b.topeAnioMinutos, 527040);
      if ([dia, mes, anio].includes(undefined)) return res.status(400).json({ error: 'Los topes tienen que ser minutos enteros, o vacío' });
      if (dia == null && mes == null && anio == null) return res.status(400).json({ error: 'Cargá al menos un tope' });
      const [r] = await db.query(
        `INSERT INTO employee_overtime_authorizations
           (tenant_id, employee_id, tope_dia_minutos, tope_mes_minutos, tope_anio_minutos, vigente_desde, vigente_hasta, motivo, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, empId, dia, mes, anio, b.vigenteDesde, b.vigenteHasta || null, motivo.slice(0, 255), autor(req)]
      );
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      console.error('ERROR regimen crear autorizacion:', err);
      res.status(500).json({ error: 'Error guardando la autorización' });
    }
  });

  router.get('/aprobaciones', requirePermission('attendance', 'read'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const empId = await empleadoDeLaEmpresa(req.query, tenantId);
      if (!empId) return res.status(404).json({ error: 'Empleado no encontrado' });
      const [rows] = await db.query(
        `SELECT a.*, au.email AS created_by_email FROM overtime_excess_approvals a
         LEFT JOIN app_users au ON au.id = a.created_by
         WHERE a.tenant_id = ? AND a.employee_id = ? ${req.query.periodo ? 'AND a.periodo = ?' : ''}
         ORDER BY a.periodo DESC, a.id DESC`,
        req.query.periodo ? [tenantId, empId, req.query.periodo] : [tenantId, empId]);
      res.json({ aprobaciones: rows });
    } catch (err) {
      console.error('ERROR regimen aprobaciones:', err);
      res.status(500).json({ error: 'Error leyendo las aprobaciones' });
    }
  });

  router.post('/aprobaciones', requirePermission('attendance', 'update'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    try {
      const b = req.body || {};
      const empId = await empleadoDeLaEmpresa(b, tenantId);
      if (!empId) return res.status(404).json({ error: 'Empleado no encontrado' });
      if (!/^\d{4}-\d{2}$/.test(b.periodo || '')) return res.status(400).json({ error: 'periodo (AAAA-MM) es requerido' });
      const minutos = Number(b.minutos);
      if (!Number.isInteger(minutos) || minutos <= 0 || minutos > 44640) return res.status(400).json({ error: 'minutos tiene que ser un entero positivo' });
      const motivo = String(b.motivo || '').trim();
      if (!motivo) return res.status(400).json({ error: 'El motivo es obligatorio' });
      const [r] = await db.query(
        `INSERT INTO overtime_excess_approvals (tenant_id, employee_id, periodo, minutos, motivo, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, empId, b.periodo, minutos, motivo.slice(0, 255), autor(req)]
      );
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      console.error('ERROR regimen crear aprobacion:', err);
      res.status(500).json({ error: 'Error guardando la aprobación' });
    }
  });

  return router;
};
