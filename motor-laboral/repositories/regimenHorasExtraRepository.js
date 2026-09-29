// Regimen de horas extra -- lectura de la configuracion (bloque B1).
// Tablas: migracion 20261006_regimen_horas_extra.sql. Calculo:
// motor-laboral/services/horasExtraRegimen.js. Diseño: HORAS_EXTRA_REGIMENES.md.
//
// EN LOTE, no persona por persona: `cargarConfiguracion` trae TODO lo de un
// periodo para un conjunto de empleados en unas pocas consultas, y despues
// responde en memoria para cada persona/fecha. Con 5000 empleados, una
// consulta por persona y por dia seria inviable.

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

  const [asignaciones] = ids.length ? await db.query(
    `SELECT employee_id, convention_id, valid_from, valid_to FROM employee_convention_assignments
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
  const [reglas] = await db.query(
    `SELECT * FROM day_type_overtime_rules
     WHERE tenant_id = ? AND active = 1 AND template_id IS NULL
       AND (convention_id IS NULL ${convenciones.length ? 'OR convention_id IN (?)' : ''})`,
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

    regimenDe(employeeId, fecha) {
      const a = vigenteA(asignaciones.filter((x) => x.employee_id === employeeId), fecha, 'valid_from', 'valid_to');
      return a ? a.convention_id : null;
    },

    // La politica del regimen, o si el regimen no tiene, la de la empresa
    // (convention_id NULL). null si no hay ninguna vigente.
    politicaPara(conventionId, fecha) {
      const propia = conventionId != null
        ? vigenteA(politicas.filter((p) => p.convention_id === conventionId), fecha, 'vigente_desde')
        : null;
      const p = propia || vigenteA(politicas.filter((x) => x.convention_id == null), fecha, 'vigente_desde');
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

    // Reglas por tipo de dia del regimen; si el regimen no tiene propias, las
    // de la empresa (convention_id NULL).
    reglasDe(conventionId) {
      const propias = conventionId != null ? reglas.filter((r) => r.convention_id === conventionId) : [];
      return propias.length ? propias : reglas.filter((r) => r.convention_id == null);
    },
  };
}

module.exports = { cargarConfiguracion };
