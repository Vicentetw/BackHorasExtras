// Regimen de horas extra -- lectura de la configuracion (bloque B1).
// Tablas: migracion 20261006_regimen_horas_extra.sql. Calculo:
// motor-laboral/services/horasExtraRegimen.js. Diseño: HORAS_EXTRA_REGIMENES.md.
//
// EN LOTE, no persona por persona: `cargarConfiguracion` trae TODO lo de un
// periodo para un conjunto de empleados en unas pocas consultas, y despues
// responde en memoria para cada persona/fecha. Con 5000 empleados, una
// consulta por persona y por dia seria inviable.

const { consultarConRegimeId } = require('./regimeIdOpcional');

function fechaStr(v) {
  if (v == null) return null;
  return String(v).slice(0, 10);
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {number} tenantId
 * @param {{empleados:number[], desde:string, hasta:string}} p  ids INTERNOS de employees
 */
async function cargarConfiguracion(db, tenantId, { empleados, desde, hasta }) {
  const ids = [...new Set((empleados || []).filter((x) => Number.isInteger(x)))];
  const ignorarTablaFaltante = (err) => {
    // Backend publicado antes que la migracion 20261006: sin configuracion.
    if (err && err.code === 'ER_NO_SUCH_TABLE') return [[]];
    throw err;
  };

  const [politicas] = await db.query(
    `SELECT * FROM overtime_regime_policies WHERE tenant_id = ? AND vigente_desde <= ? ORDER BY vigente_desde`,
    [tenantId, hasta]
  ).catch(ignorarTablaFaltante);

  const [asignaciones] = ids.length ? await consultarConRegimeId(db,
    `SELECT employee_id, convention_id, regime_id, valid_from, valid_to FROM employee_convention_assignments
     WHERE tenant_id = ? AND employee_id IN (?) AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
     ORDER BY valid_from`,
    [tenantId, ids, hasta, desde]
  ) : [[]];

  const [autorizaciones] = ids.length ? await db.query(
    `SELECT * FROM employee_overtime_authorizations
     WHERE tenant_id = ? AND employee_id IN (?) AND vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
     ORDER BY vigente_desde`,
    [tenantId, ids, hasta, desde]
  ).catch(ignorarTablaFaltante) : [[]];

  const periodos = [];
  for (let d = new Date(`${desde.slice(0, 7)}-01T12:00:00`); fechaStr(d.toISOString()).slice(0, 7) <= hasta.slice(0, 7); d.setMonth(d.getMonth() + 1)) {
    periodos.push(fechaStr(d.toISOString()).slice(0, 7));
  }
  const [aprobaciones] = ids.length ? await db.query(
    `SELECT employee_id, periodo, SUM(minutos) AS minutos FROM overtime_excess_approvals
     WHERE tenant_id = ? AND employee_id IN (?) AND periodo IN (?) GROUP BY employee_id, periodo`,
    [tenantId, ids, periodos]
  ).catch(ignorarTablaFaltante) : [[]];

  const convenciones = [...new Set(asignaciones.map((a) => a.convention_id))];
  // Las reglas de un convenio se guardan con tenant_id NULL (el convenio ya
  // es de la empresa: ver POST /day-type-rules); las de la empresa, con
  // tenant_id y sin convenio. Los convenios vienen de asignaciones ya
  // filtradas por tenant, asi que no se mezclan empresas.
  const [reglas] = await db.query(
    `SELECT * FROM day_type_overtime_rules
     WHERE active = 1 AND template_id IS NULL
       AND ((tenant_id = ? AND convention_id IS NULL) ${convenciones.length ? 'OR convention_id IN (?)' : ''})`,
    convenciones.length ? [tenantId, convenciones] : [tenantId]
  );

  // --- resolutores en memoria ---
  const vigenteA = (filas, fecha, desdeK, hastaK) => {
    let r = null;
    for (const f of filas) {
      if (fechaStr(f[desdeK]) <= fecha && (!hastaK || f[hastaK] == null || fechaStr(f[hastaK]) >= fecha)) r = f;
    }
    return r;
  };

  return {
    // Hay algo configurado para la empresa: si no, el calculo sigue como hoy.
    hayConfiguracion: politicas.length > 0,

    // Convenio de la persona en esa fecha (se mantiene por compatibilidad).
    regimenDe(employeeId, fecha) {
      return this.encuadreDe(employeeId, fecha).conventionId;
    },

    // Convenio Y regimen dentro del convenio (migracion 20261007).
    encuadreDe(employeeId, fecha) {
      const a = vigenteA(asignaciones.filter((x) => x.employee_id === employeeId), fecha, 'valid_from', 'valid_to');
      return { conventionId: a ? a.convention_id : null, regimeId: a ? a.regime_id ?? null : null };
    },

    // La politica mas especifica vigente: regimen > convenio > empresa.
    // null si no hay ninguna.
    politicaPara(conventionId, fecha, regimeId = null) {
      const deNivel = (conv, reg) => vigenteA(
        politicas.filter((p) => (p.convention_id ?? null) === conv && (p.regime_id ?? null) === reg), fecha, 'vigente_desde');
      const p = (conventionId != null && regimeId != null ? deNivel(conventionId, regimeId) : null)
        || (conventionId != null ? deNivel(conventionId, null) : null)
        || deNivel(null, null);
      if (!p) return null;
      return {
        topes: { dia: p.tope_dia_minutos, mes: p.tope_mes_minutos, anio: p.tope_anio_minutos },
        politica: p.politica_excedente,
        fuente: p.fuente,
        minimo: p.minimo_minutos,
        redondeo: p.redondeo_minutos,
        modo: p.redondeo_modo,
      };
    },

    autorizacionPara(employeeId, fecha) {
      const a = vigenteA(autorizaciones.filter((x) => x.employee_id === employeeId), fecha, 'vigente_desde', 'vigente_hasta');
      return a ? { dia: a.tope_dia_minutos, mes: a.tope_mes_minutos, anio: a.tope_anio_minutos, motivo: a.motivo } : null;
    },

    aprobadosEn(employeeId, periodo) {
      const a = aprobaciones.find((x) => x.employee_id === employeeId && x.periodo === periodo);
      return a ? Number(a.minutos) : 0;
    },

    // Reglas por tipo de dia, la mas especifica POR CADA tipo de dia:
    // regimen > convenio > empresa. Asi un regimen puede cambiar solo el
    // sabado y heredar el resto del convenio.
    reglasDe(conventionId, regimeId = null) {
      const nivel = (r) => {
        if (regimeId != null && r.convention_id === conventionId && (r.regime_id ?? null) === regimeId) return 3;
        if (conventionId != null && r.convention_id === conventionId && (r.regime_id ?? null) == null) return 2;
        if (r.convention_id == null && (r.regime_id ?? null) == null) return 1;
        return 0;
      };
      const mejorPorDia = new Map();
      for (const r of reglas) {
        const n = nivel(r);
        if (!n) continue;
        const actual = mejorPorDia.get(r.day_type);
        if (!actual || n > actual.n) mejorPorDia.set(r.day_type, { n, r });
      }
      return [...mejorPorDia.values()].map((x) => x.r);
    },
  };
}

module.exports = { cargarConfiguracion };
