// /api/mi -- PORTAL DEL EMPLEADO (etapa 1: solo lectura). Migracion 20261010.
//
//   GET /api/mi/perfil                 quien soy (legajo, nombre, empresa)
//   GET /api/mi/mes?periodo=AAAA-MM    mi mes: resumen, dia por dia, horas
//                                      extra, y lo liquidado si el mes esta
//                                      cerrado
//
// SEGURIDAD, en tres capas:
//   1. appUserMiddleware.js deja a una cuenta de empleado usar SOLO estas
//      rutas (lista blanca), y findByFirebaseUid le saca todo permiso.
//   2. Aca, el empleado sale SIEMPRE del token (req.appUser.employeeId),
//      nunca de un parametro: no existe forma de pedir el legajo de otro.
//      (Leccion F-02 de la auditoria: un id que viene del pedido no prueba
//      que sea tuyo.)
//   3. La respuesta lleva una LISTA de campos elegidos, no la fila entera:
//      lo interno (explicaciones del motor, modo sombra, notas de las cargas
//      manuales) no sale.
//
// El calculo es el MISMO que Presentismo (calcularAsistencia), filtrado a esta
// persona desde el principio: cuesta lo de una persona, no lo de la empresa.
const express = require('express');

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

function ultimoDia(periodo) {
  const [a, m] = periodo.split('-').map(Number);
  return `${periodo}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;
}

// Campos del dia que ve el empleado.
function diaParaElEmpleado(d) {
  return {
    fecha: d.date,
    estado: d.status,
    fichajes: d.checkins || [],
    entrada: d.firstCheckin || null,
    salida: d.lastCheckin || null,
    minutosTarde: d.lateMinutes || 0,
    horasExtraMinutos: Math.round(d.overtimeMinutes || 0),
    horasExtraCargadasMinutos: Math.round(d.overtimeManualMinutes || 0),
    salidaParticular: !!d.hasParticularExit,
    enCampana: !!d.inCampaign,
    motivo: d.eventTypeDescripcion || null,
    regimen: d.regimen ? {
      clase: d.regimen.clase, recargo: d.regimen.recargo ?? null,
      computables: Math.round(d.regimen.computables || 0), excedente: Math.round(d.regimen.excedente || 0),
    } : null,
  };
}

function resumenParaElEmpleado(r) {
  const g = r.regimenHorasExtra;
  return {
    diasTrabajados: r.daysWorked,
    ausencias: r.absent,
    tardanzas: r.late,
    tardanzasJustificadas: r.lateJustified,
    justificadas: r.excused,
    diasEnCampana: r.campaignDays || 0,
    horasExtraMinutos: Math.round(Number(r.overtimeHours || 0) * 60),
    horasParticularesMinutos: Math.round(Number(r.personalLeaveHours || 0) * 60),
    limiteParticularesMinutos: Math.round(Number(r.personalLeaveLimitHours || 0) * 60),
    regimen: g ? {
      reales: Math.round(g.reales), computables: Math.round(g.computables), excedente: Math.round(g.excedente),
      pendiente: Math.round(g.pendiente), dedicacion: Math.round(g.registradas), cargadas: Math.round(g.manuales || 0),
      porRecargo: Object.fromEntries(Object.entries(g.porRecargo || {}).map(([k, v]) => [k, Math.round(v)])),
    } : null,
  };
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {{calcularAsistencia:Function}} deps
 */
module.exports = function (db, { calcularAsistencia }) {
  const router = express.Router();

  // Solo cuentas de empleado, y solo si su legajo sigue siendo de SU empresa.
  router.use(async (req, res, next) => {
    const u = req.appUser;
    if (!u || u.employeeId == null) return res.status(403).json({ error: 'Esta sección es para cuentas de empleado.' });
    try {
      const [[e]] = await db.query(
        `SELECT e.id, e.employee_id AS legajo, e.nombre, e.tenant_id, e.activo, t.name AS empresa
         FROM employees e JOIN tenants t ON t.id = e.tenant_id
         WHERE e.id = ? AND e.tenant_id = ?`, [u.employeeId, u.tenantId]);
      if (!e) return res.status(403).json({ error: 'Tu cuenta no está vinculada a un legajo de tu empresa. Consultá con RRHH.' });
      // Dado de baja: el acceso se corta (la empresa puede reactivarlo).
      if (!Number(e.activo)) return res.status(403).json({ error: 'Tu legajo figura dado de baja. Consultá con RRHH.' });
      req.empleado = e;
      next();
    } catch (err) {
      console.error('ERROR portal empleado:', err);
      res.status(500).json({ error: 'Error leyendo tu legajo' });
    }
  });

  router.get('/perfil', (req, res) => {
    const e = req.empleado;
    res.json({ legajo: e.legajo, nombre: e.nombre, empresa: e.empresa });
  });

  router.get('/mes', async (req, res) => {
    const periodo = String(req.query.periodo || '');
    if (!PERIODO.test(periodo)) return res.status(400).json({ error: 'periodo (AAAA-MM) es requerido' });
    const e = req.empleado;
    try {
      const cuerpo = await calcularAsistencia(req, `${periodo}-01`, ultimoDia(periodo), e.tenant_id, { employeeId: String(e.legajo) });
      const fila = (cuerpo.data || []).find((r) => String(r.employeeId) === String(e.legajo));
      const respuesta = {
        periodo,
        resumen: fila ? resumenParaElEmpleado(fila) : null,
        dias: fila && fila.days ? fila.days.map(diaParaElEmpleado) : [],
        liquidado: await liquidadoDelMes(e, periodo),
      };
      res.json(respuesta);
    } catch (err) {
      console.error('ERROR portal mi mes:', err);
      res.status(err.status || 500).json({ error: 'No se pudo armar tu mes' });
    }
  });

  // Si el mes esta CERRADO, lo que se le liquido (foto del cierre + ajustes de
  // meses anteriores pagados en ese mes). null si el mes sigue abierto.
  async function liquidadoDelMes(e, periodo) {
    try {
      const [[c]] = await db.query(
        `SELECT id, accion, created_at FROM overtime_period_closings WHERE tenant_id = ? AND periodo = ? ORDER BY id DESC LIMIT 1`,
        [e.tenant_id, periodo]);
      if (!c || c.accion !== 'CERRAR') return null;
      const [[r]] = await db.query(
        'SELECT a_liquidar, por_recargo FROM overtime_period_results WHERE closing_id = ? AND employee_id = ?', [c.id, e.id]);
      const [ajustes] = await db.query(
        'SELECT periodo_origen, minutos FROM overtime_period_adjustments WHERE closing_id = ? AND employee_id = ? ORDER BY periodo_origen', [c.id, e.id])
        .catch((err) => (err.code === 'ER_NO_SUCH_TABLE' ? [[]] : Promise.reject(err)));
      const delMes = r ? r.a_liquidar : 0;
      const ajuste = ajustes.reduce((s, a) => s + a.minutos, 0);
      return {
        cerradoEl: c.created_at,
        delMesMinutos: delMes,
        porRecargo: r ? (typeof r.por_recargo === 'string' ? JSON.parse(r.por_recargo) : (r.por_recargo || {})) : {},
        ajustes: ajustes.map((a) => ({ periodo: a.periodo_origen, minutos: a.minutos })),
        totalMinutos: delMes + ajuste,
      };
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return null; // cierre de mes todavia no migrado
      throw err;
    }
  }

  return router;
};

module.exports.diaParaElEmpleado = diaParaElEmpleado;
module.exports.resumenParaElEmpleado = resumenParaElEmpleado;
