/**
 * Copia los datos de UNA persona real a la empresa de demostración, con
 * nombre y legajo inventados. Lo usa scripts/crear-empresa-demo.js con la
 * opción --copiar-legajo (pedido del dueño, 2026-10-10: sus propios
 * fichajes, legajo 2525, para que la demo muestre salidas particulares,
 * oficiales, horas extra y campaña reales, que los datos inventados no
 * tienen).
 *
 * QUÉ SE COPIA (desde la fecha `desde` hasta hoy)
 * -----------------------------------------------
 *   - los fichajes de la persona;
 *   - los fichajes de MARCADOR que el sistema le atribuyó (ver abajo);
 *   - sus asignaciones de horario, con copias de esas plantillas;
 *   - sus justificaciones, licencias, horas extra cargadas a mano y saldo de
 *     vacaciones, SIN los textos libres (razón, observaciones, notas): pueden
 *     decir cosas personales que no van en un video;
 *   - su convenio (y las reglas por tipo de día de ese convenio);
 *   - los feriados de la empresa de origen en ese período;
 *   - la configuración de marcadores y campaña de la empresa de origen.
 * No se copia: nombre, documento, email, ni nada de otras personas.
 *
 * LOS MARCADORES (lo delicado)
 * ----------------------------
 * Las salidas y horas extra no están en los fichajes de la persona sino en
 * los del MARCADOR (la tecla del reloj) que va antes. El sistema le da cada
 * marcador al próximo fichaje del mismo reloj (MARCADORES_Y_SALIDAS.md). Para
 * saber cuáles fueron suyos se corre la MISMA detección que usan los reportes
 * (campanaService + movementsCalculations.detectMovements, código
 * compartido, no una copia) sobre TODOS los fichajes de la empresa de origen,
 * día por día, y se toman los marcadores de los eventos de esta persona.
 *
 * En la demo, sus fichajes y esos marcadores van a un RELOJ PROPIO donde no
 * ficha nadie más: así ningún empleado inventado puede llevarse uno de sus
 * marcadores, y la detección da lo mismo que en la empresa de origen. Eso se
 * verifica comparando las pantallas (ver el final de crear-empresa-demo.js).
 *
 * Solo LEE de la empresa de origen. Todo lo que escribe lleva el tenant_id de
 * la demo.
 */
const campanaService = require('../motor-laboral/services/campanaService');
const movementsCalc = require('../motor-laboral/services/movementsCalculations');

const MARCA = 'copia-demo'; // identifica lo copiado (feriados) para poder rehacerlo
const CONFIG_A_COPIAR = ['markerMaxGapSeconds', 'markerBounceSeconds', 'markerArrivalWindowMinutes', 'campanaArrivalCutoffTime', 'campanaPresentismoModo',
  'particularExitMonthlyLimitMinutes', 'personalLeaveMonthlyLimitMinutes'];

const p2 = (n) => String(n).padStart(2, '0');
const fechaLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const sumarDias = (fecha, n) => { const [a, m, d] = fecha.split('-').map(Number); return fechaLocal(new Date(a, m - 1, d + n)); };
const primeroDelMesSiguiente = (fecha) => { const [a, m] = fecha.split('-').map(Number); return fechaLocal(new Date(a, m, 1)); };

/**
 * @param db conexión (mysql2/promise, dateStrings: true)
 * @param o { origen, legajo, demo, nombre, legajoNuevo, userIdNuevo, desde, hasta,
 *            ciudadId, sucursalId, relojIp, userIdMarcador: (badge) => USERID en la demo }
 */
async function copiarLegajoADemo(db, o) {
  const log = [];
  const [[emp]] = await db.query(
    `SELECT e.*, uem.USERID AS userId FROM employees e
       JOIN user_employee_map uem ON uem.employee_id = e.id AND uem.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.employee_id = ? LIMIT 1`, [o.origen, o.legajo]);
  if (!emp) throw new Error(`No existe el legajo ${o.legajo} (vinculado a un usuario de reloj) en la empresa ${o.origen}`);
  const legajoTxt = String(emp.employee_id);

  // ---- 1. Qué marcadores fueron suyos: la misma detección de los reportes.
  const todosLosMarcadores = await campanaService.fetchMarkerMap(db, null, o.origen);
  const maxMarkerGapMs = await campanaService.fetchMarkerMaxGapMs(db, o.origen);
  const ventanaReboteMs = await campanaService.fetchVentanaReboteMs(db, o.origen);
  const ventanaLlegadaParticularMs = await campanaService.fetchVentanaLlegadaParticularMs(db, o.origen);
  const mapasPorCategoria = {};
  for (const cat of ['PARTICULAR', 'OFICIAL', 'HE', 'CAMPANA']) mapasPorCategoria[cat] = await campanaService.fetchMarkerMap(db, cat, o.origen);

  const suyos = new Map(); // `${userId}|${hora}` -> { userId, at: Date }
  const anotar = (userId, at) => {
    if (userId == null || !at) return;
    const d = at instanceof Date ? at : new Date(String(at).replace(' ', 'T'));
    suyos.set(`${userId}|${+d}`, { userId, at: d });
  };
  const hastaExcl = sumarDias(o.hasta, 1);
  for (let ini = o.desde; ini < hastaExcl; ini = primeroDelMesSiguiente(ini)) {
    const fin = primeroDelMesSiguiente(ini) < hastaExcl ? primeroDelMesSiguiente(ini) : hastaExcl;
    const checkins = await campanaService.fetchMovementCheckins(db, ini, fin, o.origen);
    const correcciones = await campanaService.fetchCorreccionesMarcadores(db, ini, fin, o.origen);
    const porDia = new Map();
    for (const c of checkins) {
      const dia = fechaLocal(c.checktime);
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia).push(c);
    }
    for (const [, delDia] of porDia) {
      if (!delDia.some((c) => c.employeeId === legajoTxt)) continue;
      for (const cat of Object.keys(mapasPorCategoria)) {
        if (!Object.keys(mapasPorCategoria[cat]).length) continue;
        const r = movementsCalc.detectMovements(delDia, mapasPorCategoria[cat],
          { maxMarkerGapMs, todosLosMarcadores, correccionesMarcadores: correcciones, ownCheckinBounceMs: ventanaReboteMs, ventanaLlegadaParticularMs });
        for (const ev of r.closedEvents) if (ev.employeeId === legajoTxt) { anotar(ev.salidaMarkerUserId, ev.salidaMarkerAt); anotar(ev.regresoMarkerUserId, ev.regresoMarkerAt); }
        for (const [id, ev] of r.openEvents) if (id === legajoTxt) anotar(ev.salidaMarkerUserId, ev.salidaMarkerAt);
        for (const ev of r.orphanReturns) if (ev.employeeId === legajoTxt) anotar(ev.regresoMarkerUserId, ev.regresoMarkerAt);
        for (const ev of r.regresosDescartados || []) if (ev.employeeId === legajoTxt) anotar(ev.regresoMarkerUserId, ev.regresoMarkerAt);
      }
    }
  }
  // Campaña dura varios días: su propia detección, como el reporte.
  for (const ev of await campanaService.detectarCampanas(db, o.origen, o.desde, o.hasta)) {
    if (ev.employeeId !== legajoTxt) continue;
    anotar(ev.salidaMarkerUserId, ev.salidaMarkerAt);
    anotar(ev.regresoMarkerUserId, ev.regresoMarkerAt);
  }

  // ---- 2. Marcadores en la demo: los mismos botones que en el origen.
  const [defs] = await db.query('SELECT userId, badgeNumber, name, category, direction FROM specialusers WHERE tenant_id = ? AND isActive = 1', [o.origen]);
  const demoMarcador = new Map(); // userId de origen -> USERID en la demo
  for (const d of defs) {
    const uid = o.userIdMarcador(d.badgeNumber);
    demoMarcador.set(String(d.userId), uid);
    if (todosLosMarcadores[d.badgeNumber]) demoMarcador.set(String(d.badgeNumber), uid); // alias por badge
    const [[ya]] = await db.query('SELECT 1 FROM specialusers WHERE tenant_id = ? AND userId = ?', [o.demo, uid]);
    if (ya) continue;
    await db.query('INSERT IGNORE INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [uid, o.demo, String(d.badgeNumber), 'Marcador']);
    await db.query('INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [uid, o.demo, String(d.badgeNumber), d.name || `Marcador ${d.badgeNumber}`, d.category, d.direction]);
  }

  // ---- 3. Configuración del origen que cambia lo que se detecta.
  for (const nombre of CONFIG_A_COPIAR) {
    const [[v]] = await db.query('SELECT value FROM app_settings WHERE name = ? AND tenant_id = ?', [nombre, o.origen]);
    if (!v) continue;
    await db.query(`INSERT INTO app_settings (name, tenant_id, value) VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE value = VALUES(value)`, [nombre, o.demo, v.value]);
  }
  const [[capOrigen]] = await db.query("SELECT value FROM app_settings WHERE name = 'overtimeCapMinutes' AND tenant_id = ?", [o.origen]);

  // ---- 4. Categoría y empleado (inventado).
  let categoriaId = null;
  if (emp.category_id) {
    const [[cat]] = await db.query('SELECT name FROM employee_categories WHERE id = ?', [emp.category_id]);
    if (cat) {
      const [[ya]] = await db.query('SELECT id FROM employee_categories WHERE tenant_id = ? AND name = ?', [o.demo, cat.name]);
      categoriaId = ya ? ya.id : (await db.query('INSERT INTO employee_categories (tenant_id, name, active) VALUES (?, ?, 1)', [o.demo, cat.name]))[0].insertId;
    }
  }
  const [e] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tipo_documento, tenant_id, activo, fecha_alta, exclude_from_report, ciudad_id, sucursal_id,
                            overtime_authorized, category_id, payroll_regime, afectado_campana)
     VALUES (?, ?, 1, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [o.legajoNuevo, o.nombre, o.demo, emp.fecha_alta, o.ciudadId, o.sucursalId, emp.overtime_authorized, categoriaId,
      emp.payroll_regime || 'monthly', emp.afectado_campana || 0]);
  const E = e.insertId;
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [o.userIdNuevo, o.demo, String(o.legajoNuevo), o.nombre]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'demo')`, [o.userIdNuevo, o.demo, E]);

  // ---- 5. Fichajes y marcadores, en su reloj propio.
  const [fich] = await db.query(
    `SELECT DISTINCT CHECKTIME FROM Checkins WHERE tenant_id = ? AND (USERID = ? OR USERID = ?) AND CHECKTIME >= ? AND CHECKTIME < ?`,
    [o.origen, emp.userId, emp.employee_id, o.desde, hastaExcl]);
  const filas = fich.map((f) => [o.userIdNuevo, o.demo, f.CHECKTIME, o.relojIp]);
  let sinMarcadorEnDemo = 0;
  for (const { userId, at } of suyos.values()) {
    const uid = demoMarcador.get(String(userId));
    if (!uid) { sinMarcadorEnDemo++; continue; }
    filas.push([uid, o.demo, movementsCalc.fechaHoraLocal(at), o.relojIp]);
  }
  for (let k = 0; k < filas.length; k += 500) {
    await db.query('INSERT IGNORE INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES ?', [filas.slice(k, k + 500)]);
  }
  log.push(`${fich.length} fichajes y ${suyos.size - sinMarcadorEnDemo} marcadores suyos`);

  // ---- 6. Horarios: copia de cada plantilla que usa (las que existen en el origen).
  const [cals] = await db.query(
    `SELECT c.template_id, c.valid_from, c.valid_to, c.cycle_start_date FROM employee_work_calendars c
       JOIN work_schedule_templates t ON t.id = c.template_id
      WHERE c.employee_id = ?`, [emp.id]).catch(async (err) => {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err; // sin la migración 20261015 no hay cycle_start_date
    return db.query(`SELECT c.template_id, c.valid_from, c.valid_to, NULL AS cycle_start_date FROM employee_work_calendars c
                       JOIN work_schedule_templates t ON t.id = c.template_id WHERE c.employee_id = ?`, [emp.id]);
  });
  const plantillaNueva = new Map();
  for (const c of cals) {
    if (!plantillaNueva.has(c.template_id)) {
      const [[t]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [c.template_id]);
      const copia = { ...t };
      delete copia.id; delete copia.created_at; delete copia.updated_at;
      copia.tenant_id = o.demo;
      copia.is_default = 0;
      // El tope diario de horas extra: el de la plantilla, o el de la empresa
      // de origen. Se pone en la plantilla para no cambiarle el tope a toda la demo.
      if (copia.overtime_cap_minutes == null && capOrigen) copia.overtime_cap_minutes = Number(capOrigen.value);
      const [r] = await db.query('INSERT INTO work_schedule_templates SET ?', [copia]);
      plantillaNueva.set(c.template_id, r.insertId);
      const [bloques] = await db.query('SELECT * FROM shift_blocks WHERE template_id = ?', [c.template_id]);
      for (const b of bloques) {
        const nb = { ...b }; delete nb.id; delete nb.created_at; delete nb.updated_at; nb.template_id = r.insertId;
        await db.query('INSERT INTO shift_blocks SET ?', [nb]);
      }
      // Plantillas rotativas: su ciclo y sus turnos.
      const [ciclo] = await db.query('SELECT * FROM template_cycle_days WHERE template_id = ?', [c.template_id]).catch(() => [[]]);
      const turnoNuevo = new Map();
      for (const d of ciclo) {
        let sid = null;
        if (d.shift_id != null) {
          if (!turnoNuevo.has(d.shift_id)) {
            const [[s]] = await db.query('SELECT * FROM shift_definitions WHERE id = ?', [d.shift_id]);
            const [ns] = await db.query('INSERT INTO shift_definitions (tenant_id, nombre, color, activo) VALUES (?, ?, ?, ?)', [o.demo, s.nombre, s.color, s.activo]);
            const [tramos] = await db.query('SELECT * FROM shift_definition_tramos WHERE shift_id = ?', [d.shift_id]);
            for (const tr of tramos) await db.query('INSERT INTO shift_definition_tramos (shift_id, orden, inicio, fin, cruza_medianoche) VALUES (?, ?, ?, ?, ?)', [ns.insertId, tr.orden, tr.inicio, tr.fin, tr.cruza_medianoche]);
            turnoNuevo.set(d.shift_id, ns.insertId);
          }
          sid = turnoNuevo.get(d.shift_id);
        }
        await db.query('INSERT INTO template_cycle_days (template_id, day_number, shift_id) VALUES (?, ?, ?)', [r.insertId, d.day_number, sid]);
      }
    }
    const fila = { employee_id: E, tenant_id: o.demo, template_id: plantillaNueva.get(c.template_id), valid_from: c.valid_from, valid_to: c.valid_to };
    if (c.cycle_start_date) fila.cycle_start_date = c.cycle_start_date;
    await db.query('INSERT INTO employee_work_calendars SET ?', [fila]);
  }
  log.push(`${cals.length} asignaciones de horario (${plantillaNueva.size} plantillas)`);

  // ---- 7. Motivos de ausencia que use (por código), justificaciones, licencias, HE a mano.
  const motivoNuevo = new Map();
  const motivoDemo = async (idOrigen) => {
    if (idOrigen == null) return null;
    if (motivoNuevo.has(idOrigen)) return motivoNuevo.get(idOrigen);
    const [[m]] = await db.query('SELECT * FROM event_types WHERE id = ?', [idOrigen]);
    if (!m) return null;
    let [[ya]] = await db.query('SELECT id FROM event_types WHERE tenant_id = ? AND code = ?', [o.demo, m.code]);
    if (!ya) {
      const [r] = await db.query('INSERT INTO event_types (tenant_id, code, descripcion, descuenta_vacaciones, requiere_aprobacion, active) VALUES (?, ?, ?, ?, ?, ?)',
        [o.demo, m.code, m.descripcion, m.descuenta_vacaciones, m.requiere_aprobacion, m.active]);
      ya = { id: r.insertId };
      // Cómo cuenta los días (hábiles o corridos), si el origen lo tiene configurado.
      const [modos] = await db.query('SELECT modo, vigente_desde FROM event_type_count_modes WHERE event_type_id = ?', [idOrigen]).catch(() => [[]]);
      for (const md of modos) await db.query('INSERT INTO event_type_count_modes (event_type_id, modo, vigente_desde) VALUES (?, ?, ?)', [ya.id, md.modo, md.vigente_desde]).catch(() => {});
    }
    motivoNuevo.set(idOrigen, ya.id);
    return ya.id;
  };
  const [justs] = await db.query('SELECT * FROM userexclusions WHERE tenant_id = ? AND userId = ? AND excDate >= ? AND excDate < ?', [o.origen, emp.userId, o.desde, hastaExcl]);
  for (const j of justs) {
    await db.query('INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type, event_type_id, excFrom, excTo) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
      [o.userIdNuevo, o.demo, j.excDate, j.type, await motivoDemo(j.event_type_id), j.excFrom, j.excTo]);
  }
  const [licencias] = await db.query('SELECT * FROM employee_events WHERE employee_id = ? AND fecha_hasta >= ? AND fecha_desde < ?', [emp.id, o.desde, hastaExcl]);
  for (const l of licencias) {
    await db.query('INSERT INTO employee_events (employee_id, event_type_id, fecha_desde, fecha_hasta, dias, observaciones, balance_year) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      [E, await motivoDemo(l.event_type_id), l.fecha_desde, l.fecha_hasta, l.dias, l.balance_year]);
  }
  const [manuales] = await db.query('SELECT * FROM ManualEntries WHERE tenant_id = ? AND userId = ? AND startDatetime >= ? AND startDatetime < ?', [o.origen, emp.userId, o.desde, hastaExcl]);
  for (const m of manuales) {
    await db.query('INSERT INTO ManualEntries (tenant_id, userId, startDatetime, endDatetime, durationMinutes, type, note) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      [o.demo, o.userIdNuevo, m.startDatetime, m.endDatetime, m.durationMinutes, m.type]);
  }
  const [saldos] = await db.query('SELECT * FROM employee_leave_balances WHERE employee_id = ? AND year >= ?', [emp.id, Number(o.desde.slice(0, 4))]);
  for (const s of saldos) {
    await db.query('INSERT INTO employee_leave_balances (employee_id, year, allotted_days, notes, expiration_date, is_automatic) VALUES (?, ?, ?, NULL, ?, ?)',
      [E, s.year, s.allotted_days, s.expiration_date, s.is_automatic]);
  }
  log.push(`${justs.length} justificaciones, ${licencias.length} licencias, ${manuales.length} horas extra a mano, ${saldos.length} saldo(s) de vacaciones`);

  // ---- 8. Convenio (y sus reglas por tipo de día).
  const [asig] = await db.query('SELECT * FROM employee_convention_assignments WHERE employee_id = ?', [emp.id]).catch(() => [[]]);
  const convenioNuevo = new Map();
  for (const a of asig) {
    if (!convenioNuevo.has(a.convention_id)) {
      const [[cv]] = await db.query('SELECT * FROM labor_conventions WHERE id = ?', [a.convention_id]);
      if (!cv) continue;
      let [[ya]] = await db.query('SELECT id FROM labor_conventions WHERE tenant_id = ? AND name = ?', [o.demo, cv.name]);
      if (!ya) {
        const [r] = await db.query('INSERT INTO labor_conventions (tenant_id, name, description, active) VALUES (?, ?, ?, ?)', [o.demo, cv.name, cv.description, cv.active]);
        ya = { id: r.insertId };
        const [reglas] = await db.query('SELECT * FROM day_type_overtime_rules WHERE tenant_id = ? AND convention_id = ? AND regime_id IS NULL AND template_id IS NULL', [o.origen, a.convention_id]);
        for (const rg of reglas) {
          const nr = { ...rg }; delete nr.id; delete nr.created_at; nr.tenant_id = o.demo; nr.convention_id = ya.id;
          await db.query('INSERT INTO day_type_overtime_rules SET ?', [nr]);
        }
      }
      convenioNuevo.set(a.convention_id, ya.id);
    }
    // Régimen y categoría del convenio no se copian (AVP no los usa en esta persona).
    await db.query('INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, regime_id, category_id, valid_from, valid_to) VALUES (?, ?, ?, NULL, NULL, ?, ?)',
      [E, o.demo, convenioNuevo.get(a.convention_id), a.valid_from, a.valid_to]);
  }

  // ---- 9. Feriados del período (para toda la demo, sin ciudad).
  await db.query('DELETE FROM holidays WHERE tenant_id = ? AND reason = ?', [o.demo, MARCA]);
  const [fer] = await db.query('SELECT * FROM holidays WHERE tenant_id = ? AND date >= ? AND date < ?', [o.origen, o.desde, hastaExcl]);
  let feriados = 0;
  for (const h of fer) {
    const [[ya]] = await db.query('SELECT 1 FROM holidays WHERE tenant_id = ? AND date = ? AND ciudad_id IS NULL', [o.demo, h.date]);
    if (ya) continue;
    await db.query('INSERT INTO holidays (tenant_id, ciudad_id, date, year, name, description, type, reason, isWorkDay, recurring) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)',
      [o.demo, h.date, h.year, h.name, h.type, MARCA, h.isWorkDay, h.recurring]);
    feriados++;
  }
  log.push(`${feriados} feriados`);

  return { employeeId: E, resumen: log.join(', '), marcadoresSinBoton: sinMarcadorEnDemo };
}

module.exports = { copiarLegajoADemo, MARCA };
