// Asignaciones de horario (employee_work_calendars) que se superponen: qué
// rige cada día y cómo reemplazar sin dejar superposiciones nuevas.
//
// Regla que usa el cálculo de asistencia (horasdedica.js, scheduleRepository):
// entre las asignaciones que cubren un día, rige la que EMPEZÓ MÁS TARDE
// (ORDER BY valid_from DESC). Si dos empiezan el mismo día, el desempate no
// está definido: esas no se tocan nunca automáticamente.
//
// Fechas como texto 'AAAA-MM-DD' (se comparan como texto). valid_to NULL =
// sin fin ('9999-12-31' para las cuentas).
const SIN_FIN = '9999-12-31';

const dia = (v) => (v == null ? null : (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10)));
function sumarDias(fecha, n) {
  if (fecha === SIN_FIN) return SIN_FIN;
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const hasta = (r) => dia(r.valid_to) || SIN_FIN;

// Resta a [desde, hasta] la unión de los intervalos dados. Devuelve los
// pedazos que quedan.
function restar(desde, fin, intervalos) {
  let pedazos = [[desde, fin]];
  for (const [a, b] of intervalos) {
    const siguientes = [];
    for (const [x, y] of pedazos) {
      if (b < x || a > y) { siguientes.push([x, y]); continue; }
      if (a > x) siguientes.push([x, sumarDias(a, -1)]);
      if (b < y) siguientes.push([sumarDias(b, 1), y]);
    }
    pedazos = siguientes;
  }
  return pedazos;
}

// Para cada asignación: los tramos en los que rige de verdad. Una
// asignación tapada por otra que empezó estrictamente después no rige en esos
// días. `empate`: otra asignación empieza el mismo día y se superpone (qué
// rige ahí no está definido).
function tramosVigentes(filas) {
  return filas.map((r) => {
    const desde = dia(r.valid_from);
    const fin = hasta(r);
    const posteriores = filas.filter((o) => o !== r && dia(o.valid_from) > desde).map((o) => [dia(o.valid_from), hasta(o)]);
    const empate = filas.some((o) => o !== r && dia(o.valid_from) === desde && hasta(o) >= desde && fin >= desde && !mismoContenido(o, r));
    return { fila: r, tramos: restar(desde, fin, posteriores), empate };
  });
}

function mismoContenido(a, b) {
  return a.template_id === b.template_id && dia(a.valid_from) === dia(b.valid_from)
    && hasta(a) === hasta(b) && dia(a.cycle_start_date) === dia(b.cycle_start_date);
}

// Normalizar las asignaciones de UNA persona sin cambiar lo que rige ningún
// día (limpieza de superposiciones, scripts/normalizar-asignaciones.js):
//   1. copias exactas: se borran (queda la de menor id);
//   2. cada asignación queda solo con los días en que de verdad rige: se
//      recorta su rango, y si rige en dos pedazos (otra cae en el medio), el
//      segundo pedazo pasa a ser una asignación aparte.
// Una asignación siempre rige el día en que empieza, salvo empate (otra
// distinta empieza el mismo día): las que tienen empate no se tocan.
function normalizar(filas) {
  const ops = [];
  const ordenadas = [...filas].sort((a, b) => a.id - b.id);
  const quedan = [];
  for (const r of ordenadas) {
    const original = quedan.find((q) => mismoContenido(q, r));
    if (original) ops.push({ tipo: 'borrar', fila: r, motivo: `copia exacta de la asignación ${original.id}` });
    else quedan.push(r);
  }
  for (const v of tramosVigentes(quedan)) {
    if (v.empate || v.tramos.length === 0) continue;
    const r = v.fila;
    const [primero, ...resto] = v.tramos;
    const finOriginal = hasta(r);
    if (primero[0] !== dia(r.valid_from) || primero[1] !== finOriginal) {
      ops.push({ tipo: 'recortar', fila: r, desde: primero[0], hasta: primero[1] === SIN_FIN ? null : primero[1] });
    }
    for (const [a, b] of resto) ops.push({ tipo: 'agregar', fila: r, desde: a, hasta: b === SIN_FIN ? null : b });
  }
  return ops;
}

// "Reemplazar" al asignar [desde, fin]: que la nueva sea la única en esas
// fechas. Devuelve las operaciones sobre las existentes:
//   borrar: quedan enteras adentro;
//   acortar: empiezan antes -> terminan el día anterior;
//   correr: terminan después -> empiezan el día siguiente al fin;
//   partir: la nueva cae en el medio -> se acorta y se crea el resto.
function planReemplazo(filas, desdeNueva, finNueva) {
  const desde = dia(desdeNueva);
  const fin = dia(finNueva) || SIN_FIN;
  const ops = [];
  for (const r of filas) {
    const a = dia(r.valid_from);
    const b = hasta(r);
    if (b < desde || a > fin) continue;
    if (a >= desde && b <= fin) ops.push({ tipo: 'borrar', fila: r });
    else if (a < desde && b > fin) ops.push({ tipo: 'partir', fila: r, nuevoFin: sumarDias(desde, -1), restoDesde: sumarDias(fin, 1), restoFin: r.valid_to == null ? null : b });
    else if (a < desde) ops.push({ tipo: 'acortar', fila: r, nuevoFin: sumarDias(desde, -1) });
    else ops.push({ tipo: 'correr', fila: r, nuevoDesde: sumarDias(fin, 1) });
  }
  return ops;
}

// Aplica el plan en la base (dentro de la conexión/transacción que se pase).
async function aplicarReemplazo(conn, filas, desde, fin) {
  const ops = planReemplazo(filas, desde, fin);
  for (const op of ops) {
    const r = op.fila;
    if (op.tipo === 'borrar') await conn.query('DELETE FROM employee_work_calendars WHERE id = ?', [r.id]);
    else if (op.tipo === 'acortar') await conn.query('UPDATE employee_work_calendars SET valid_to = ? WHERE id = ?', [op.nuevoFin, r.id]);
    else if (op.tipo === 'correr') await conn.query('UPDATE employee_work_calendars SET valid_from = ? WHERE id = ?', [op.nuevoDesde, r.id]);
    else {
      await conn.query('UPDATE employee_work_calendars SET valid_to = ? WHERE id = ?', [op.nuevoFin, r.id]);
      const conDiaUno = r.cycle_start_date != null;
      await conn.query(
        conDiaUno
          ? 'INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to, cycle_start_date) VALUES (?, ?, ?, ?, ?, ?)'
          : 'INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
        [r.employee_id, r.tenant_id, r.template_id, op.restoDesde, op.restoFin, ...(conDiaUno ? [dia(r.cycle_start_date)] : [])]);
    }
  }
  return ops;
}

// Lo que rige un día: la asignación que lo cubre y empezó más tarde (misma
// regla que el cálculo de asistencia). null si no hay; 'empate' si dos
// distintas empiezan el mismo día y lo cubren.
function rigeEl(filas, fecha) {
  const cubren = filas.filter((r) => dia(r.valid_from) <= fecha && hasta(r) >= fecha);
  if (!cubren.length) return null;
  const max = cubren.reduce((m, r) => (dia(r.valid_from) > m ? dia(r.valid_from) : m), '');
  const ganan = cubren.filter((r) => dia(r.valid_from) === max);
  return ganan.every((r) => mismoContenido(r, ganan[0])) ? ganan[0] : 'empate';
}

module.exports = { SIN_FIN, dia, sumarDias, tramosVigentes, normalizar, rigeEl, planReemplazo, aplicarReemplazo, mismoContenido };
