#!/usr/bin/env node
/**
 * Limpia las asignaciones de horario superpuestas de UNA empresa sin cambiar
 * qué horario rige ningún día (motor-laboral/services/vigenciasHorario.js).
 *
 * POR QUÉ
 * -------
 * En AVP había 282 empleados con 2.114 pares de asignaciones superpuestas:
 * copias exactas (una carga del 08/07/2026 repetida hasta tres veces) y
 * rangos que dicen "2012 a 2026" pero en realidad rigen solo hasta 2024
 * porque los tapa otra que empezó después. El cálculo no se equivocaba (rige
 * la que empezó más tarde), pero el historial de la pantalla era ilegible.
 *
 * QUÉ HACE
 * --------
 *   1. borra las copias exactas (misma plantilla, desde, hasta y "día 1");
 *   2. deja a cada asignación con los días en que de verdad rige (recorta el
 *      rango; si rige en dos pedazos, el segundo pasa a ser otra asignación).
 * Las asignaciones con "empate" (dos distintas que empiezan el mismo día) no
 * se tocan: se listan para revisarlas a mano.
 *
 * Antes de escribir nada verifica, persona por persona y día por día (desde
 * su primera asignación hasta un año después de hoy), que lo que rige sea
 * IDÉNTICO antes y después. Si no da igual, esa persona no se toca.
 *
 * USO (PowerShell). Sin --aplicar solo muestra lo que haría:
 *   node scripts/normalizar-asignaciones.js --empresa 6
 *   node scripts/normalizar-asignaciones.js --empresa 6 --aplicar
 * Contra producción, con las variables MYSQL_ADDON_* como run-sql.js (y con
 * un backup del día). Probarlo antes contra la copia local.
 */
require('dotenv').config({ quiet: true });
const db = require('../db');
const { normalizar, rigeEl, sumarDias, dia } = require('../motor-laboral/services/vigenciasHorario');

const args = process.argv.slice(2);
const empresa = Number(args[args.indexOf('--empresa') + 1]);
const aplicarCambios = args.includes('--aplicar');

function aplicarEnMemoria(filas, ops) {
  let r = filas.map((f) => ({ ...f }));
  let nuevo = -1;
  for (const op of ops) {
    if (op.tipo === 'borrar') r = r.filter((f) => f.id !== op.fila.id);
    else if (op.tipo === 'recortar') Object.assign(r.find((f) => f.id === op.fila.id), { valid_from: op.desde, valid_to: op.hasta });
    else r.push({ ...op.fila, id: nuevo--, valid_from: op.desde, valid_to: op.hasta });
  }
  return r;
}

function mismoRegimen(antes, despues, hoy) {
  const desde = antes.reduce((m, f) => (dia(f.valid_from) < m ? dia(f.valid_from) : m), '9999-12-31');
  const hasta = sumarDias(hoy, 365);
  const clave = (g) => (g === null ? '-' : g === 'empate' ? 'E' : `${g.template_id}|${dia(g.cycle_start_date) || ''}`);
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
    if (clave(rigeEl(antes, d)) !== clave(rigeEl(despues, d))) return d;
  }
  return null;
}

(async () => {
  if (!Number.isFinite(empresa)) throw new Error('Falta --empresa <id>');
  const [[base]] = await db.query('SELECT DATABASE() AS d');
  const [[t]] = await db.query('SELECT name FROM tenants WHERE id = ?', [empresa]);
  if (!t) throw new Error(`No existe la empresa ${empresa}`);
  console.log(`Base: ${base.d} · Empresa ${empresa} (${t.name}) · ${aplicarCambios ? 'APLICANDO' : 'solo muestra (sin --aplicar no cambia nada)'}`);

  const [filas] = await db.query('SELECT * FROM employee_work_calendars WHERE tenant_id = ? ORDER BY employee_id, id', [empresa]);
  const porEmpleado = new Map();
  for (const f of filas) {
    if (!porEmpleado.has(f.employee_id)) porEmpleado.set(f.employee_id, []);
    porEmpleado.get(f.employee_id).push(f);
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const total = { personas: 0, borrar: 0, recortar: 0, agregar: 0, conEmpate: 0, noCoincide: 0 };
  const plan = [];
  for (const [empleado, suyas] of porEmpleado) {
    const ops = normalizar(suyas);
    if (suyas.some((f) => rigeEl(suyas, dia(f.valid_from)) === 'empate')) total.conEmpate++;
    if (!ops.length) continue;
    const distinto = mismoRegimen(suyas, aplicarEnMemoria(suyas, ops), hoy);
    if (distinto) { total.noCoincide++; console.log(`  ! empleado ${empleado}: cambiaría lo que rige el ${distinto}; no se toca`); continue; }
    total.personas++;
    for (const op of ops) total[op.tipo]++;
    plan.push({ empleado, ops });
  }
  console.log(`Asignaciones: ${filas.length} · personas a limpiar: ${total.personas}`);
  console.log(`  copias a borrar: ${total.borrar} · rangos a recortar: ${total.recortar} · pedazos a separar: ${total.agregar}`);
  console.log(`  personas con empate (no se tocan sus empates; revisar a mano): ${total.conEmpate} · sin limpiar porque no coincidía: ${total.noCoincide}`);
  for (const { empleado, ops } of plan.slice(0, 3)) {
    console.log(`  ejemplo, empleado ${empleado}:`);
    for (const op of ops) console.log(`    ${op.tipo} #${op.fila.id} (${dia(op.fila.valid_from)} → ${dia(op.fila.valid_to) || '∞'})${op.tipo === 'borrar' ? ' — ' + op.motivo : ` ⇒ ${op.desde} → ${op.hasta || '∞'}`}`);
  }

  if (aplicarCambios && plan.length) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      for (const { ops } of plan) {
        for (const op of ops) {
          const r = op.fila;
          if (op.tipo === 'borrar') await conn.query('DELETE FROM employee_work_calendars WHERE id = ?', [r.id]);
          else if (op.tipo === 'recortar') await conn.query('UPDATE employee_work_calendars SET valid_from = ?, valid_to = ? WHERE id = ?', [op.desde, op.hasta, r.id]);
          else {
            const conDiaUno = r.cycle_start_date != null;
            await conn.query(
              conDiaUno
                ? 'INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to, cycle_start_date) VALUES (?, ?, ?, ?, ?, ?)'
                : 'INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
              [r.employee_id, r.tenant_id, r.template_id, op.desde, op.hasta, ...(conDiaUno ? [dia(r.cycle_start_date)] : [])]);
          }
        }
      }
      await conn.commit();
      console.log('Listo: cambios aplicados.');
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
  await db.end();
})().catch(async (e) => { console.error('ERROR', e.message); try { await db.end(); } catch {} process.exit(1); });
