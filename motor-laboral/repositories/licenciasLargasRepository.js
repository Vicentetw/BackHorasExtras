// ============================================================================
// Licencias largas: avisos de vencimiento (LICENCIAS_LARGAS.md, letra E)
// ============================================================================
//
// EL PROBLEMA
// -----------
// Una licencia gremial (o un cargo electivo, una reserva de puesto...) dura
// meses o años y tiene fecha de fin: el fin del mandato. Cuando llega esa
// fecha pasa una de dos cosas:
//   - lo reeligen: alguien tiene que cargar la licencia nueva;
//   - vuelve a trabajar: tiene que volver a fichar.
// Si no pasa ninguna de las dos, desde el día siguiente la persona figura
// Ausente todos los días y nadie se entera hasta que el número ya es grande.
//
// LOS DOS AVISOS
// --------------
//   por_vencer  la licencia termina dentro de los próximos N días
//               (configurable por empresa; da tiempo a cargar la reelección).
//   vencida     ya terminó, no hay otra licencia que la continúe y la persona
//               no volvió a fichar desde entonces. Es el que pide actuar ya.
//
// Solo cuentan las licencias LARGAS (desde N días, configurable): una de
// vacaciones de 14 días que vence la semana que viene no es una novedad, y
// avisar de todas las licencias haría que nadie lea los avisos.
//
// ESCALA: dos consultas para toda la empresa, no una por empleado (pensado
// para 5.000 empleados). Los avisos solo se muestran: no cambian ningún número.

// Una licencia vencida hace más de esto ya no se avisa: para entonces la
// persona lleva meses de faltas y el aviso de "faltas seguidas" ya lo marca.
const VENTANA_VENCIDA_DIAS = 90;

const sumarDias = (fecha, n) => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const diasEntre = (desde, hasta) =>
  Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000);
// Las fechas llegan como texto (DATE_FORMAT en la consulta): un Date de JS
// puede correrse un día según la zona horaria del servidor.
const aTexto = (v) => String(v).slice(0, 10);

/**
 * @param {object} db
 * @param {number} tenantId
 * @param {object} opciones
 * @param {string} opciones.fecha          hoy de la empresa (YYYY-MM-DD)
 * @param {number|null} opciones.largaDesde    desde cuántos días una licencia es "larga"; null = avisos apagados
 * @param {number|null} opciones.porVencerDias cuántos días antes avisar; null = solo "vencida"
 */
async function vencimientosDeLicencias(db, tenantId, { fecha, largaDesde, porVencerDias }) {
  if (largaDesde == null) return [];
  const desdeVentana = sumarDias(fecha, -VENTANA_VENCIDA_DIAS);
  const hastaVentana = porVencerDias == null ? sumarDias(fecha, -1) : sumarDias(fecha, porVencerDias);

  // 1. Licencias largas de empleados activos que terminan dentro de la ventana
  //    y que NO tienen otra licencia que las continúe (la reelección cargada
  //    como licencia nueva desde el día siguiente, o una superpuesta que
  //    termina más tarde). Con eso cargado, el aviso desaparece solo.
  const [licencias] = await db.query(
    `SELECT ee.id, ee.employee_id AS empleadoInterno, e.employee_id AS legajo,
            DATE_FORMAT(ee.fecha_desde, '%Y-%m-%d') AS desde,
            DATE_FORMAT(ee.fecha_hasta, '%Y-%m-%d') AS hasta,
            COALESCE(et.descripcion, 'Licencia') AS motivo
     FROM employee_events ee
     JOIN employees e ON e.id = ee.employee_id
     LEFT JOIN event_types et ON et.id = ee.event_type_id
     WHERE e.tenant_id = ? AND e.activo = 1
       AND DATEDIFF(ee.fecha_hasta, ee.fecha_desde) + 1 >= ?
       AND ee.fecha_hasta BETWEEN ? AND ?
       AND NOT EXISTS (
         SELECT 1 FROM employee_events sig
         WHERE sig.employee_id = ee.employee_id AND sig.id <> ee.id
           AND sig.fecha_desde <= DATE_ADD(ee.fecha_hasta, INTERVAL 1 DAY)
           AND sig.fecha_hasta > ee.fecha_hasta
       )`,
    [tenantId, largaDesde, desdeVentana, hastaVentana]
  );
  if (!licencias.length) return [];

  // 2. Para las vencidas: ¿volvió a fichar después del fin? Una sola consulta
  //    con todos los números con que esas personas aparecen en el reloj (el
  //    USERID y el legajo grabado en Badgenumber: hay relojes que graban uno
  //    y relojes que graban el otro -- ver campanaService.fetchMovementCheckins).
  const vencidas = licencias.filter((l) => aTexto(l.hasta) < fecha);
  const ultimoFichaje = new Map(); // id interno -> último día fichado (YYYY-MM-DD)
  if (vencidas.length) {
    const internos = [...new Set(vencidas.map((l) => l.empleadoInterno))];
    const [users] = await db.query(
      `SELECT m.employee_id, u.USERID, u.Badgenumber FROM user_employee_map m
       JOIN users u ON u.USERID = m.USERID AND u.tenant_id = m.tenant_id
       WHERE m.tenant_id = ? AND m.employee_id IN (?)`,
      [tenantId, internos]
    );
    const empleadoDeNumero = new Map();
    users.forEach((u) => {
      empleadoDeNumero.set(Number(u.USERID), u.employee_id);
      const b = Number(u.Badgenumber);
      if (Number.isInteger(b) && !empleadoDeNumero.has(b)) empleadoDeNumero.set(b, u.employee_id);
    });
    if (empleadoDeNumero.size) {
      const [fichajes] = await db.query(
        `SELECT USERID, DATE_FORMAT(MAX(CHECKTIME), '%Y-%m-%d') AS ultimo FROM Checkins
         WHERE tenant_id = ? AND USERID IN (?) AND CHECKTIME >= ? AND CHECKTIME < DATE_ADD(?, INTERVAL 1 DAY)
         GROUP BY USERID`,
        [tenantId, [...empleadoDeNumero.keys()], desdeVentana, fecha]
      );
      fichajes.forEach((f) => {
        const id = empleadoDeNumero.get(Number(f.USERID));
        if (!ultimoFichaje.has(id) || ultimoFichaje.get(id) < f.ultimo) ultimoFichaje.set(id, f.ultimo);
      });
    }
  }

  const filas = [];
  for (const l of licencias) {
    const desde = aTexto(l.desde);
    const hasta = aTexto(l.hasta);
    const base = { employeeId: String(l.legajo), licenciaId: l.id, motivo: l.motivo, desde, hasta };
    if (hasta >= fecha) {
      filas.push({ ...base, estado: 'por_vencer', dias: diasEntre(fecha, hasta) });
    } else {
      const ultimo = ultimoFichaje.get(l.empleadoInterno);
      if (ultimo && ultimo > hasta) continue; // volvió a trabajar: nada que avisar
      filas.push({ ...base, estado: 'vencida', dias: diasEntre(hasta, fecha) });
    }
  }
  // Lo más urgente primero: las vencidas (más días sin volver arriba), después
  // las que vencen antes.
  return filas.sort((a, b) =>
    (a.estado === b.estado ? 0 : a.estado === 'vencida' ? -1 : 1)
    || (a.estado === 'vencida' ? b.dias - a.dias : a.dias - b.dias));
}

module.exports = { vencimientosDeLicencias, VENTANA_VENCIDA_DIAS };
