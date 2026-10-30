// /api/correcciones-fichajes -- correcciones de fichajes (etapa G,
// 2026-10-30). Diseño: CORRECCIONES_FICHAJES.md. Cómo se aplican:
// motor-laboral/services/correccionesFichajes.js.
//
//   GET  /                          historial (filtros y paginación en el servidor)
//   GET  /fichaje/:checkinId        todas las correcciones de un fichaje
//   GET  /vista-previa?checkinId=&accion=[&marcadorUserId=]
//   POST /                          { checkinId, accion, marcadorUserId?, motivo, comprobante, confirmoOtros? }
//   GET  /:id/deshacer/vista-previa
//   POST /:id/deshacer              { motivo, comprobante, confirmoOtros? }
//
// LA VISTA PREVIA ES OBLIGATORIA. Calcula toda la empresa, con y sin la
// corrección, con el MISMO cálculo de las pantallas (Presentismo, Salidas,
// Campaña), y dice a quién le cambia qué. Devuelve un comprobante firmado.
// Al confirmar se vuelve a calcular: si el resultado ya no es el mismo
// (llegaron fichajes, alguien corrigió otra cosa), se rechaza y hay que
// mirar la vista previa de nuevo. Si cambia a otras personas, hace falta
// confirmarlo explícitamente. Si algo no se puede calcular, no se confirma.
//
// Usuarios limitados a algunas áreas: no entran (alcance.js cierra toda ruta
// que no esté en su lista), porque la vista previa muestra gente de toda la
// empresa.
const express = require('express');
const crypto = require('crypto');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');
const auditLog = require('../auditLog');
const correcciones = require('../motor-laboral/services/correccionesFichajes');
const campanaService = require('../motor-laboral/services/campanaService');
const movementsCalc = require('../motor-laboral/services/movementsCalculations');
const { hoyDeEmpresa } = require('../motor-laboral/services/hoyEmpresa');

// Los ajustes de un mes cerrado solo los toma Liquidación si el mes abierto
// que se cierra está a esta distancia o menos (MESES_AJUSTE en
// routes/liquidacionHorasExtra.js).
const MESES_AJUSTE = 3;
const VIGENCIA_COMPROBANTE_MS = 15 * 60 * 1000;
const MAX_PERSONAS_CON_DETALLE = 10;
const CATEGORIAS_DIA = ['PARTICULAR', 'OFICIAL', 'HE'];
// Firma de los comprobantes: vive lo que vive el proceso (un comprobante
// dura 15 minutos; si el servidor se reinicia, se pide la vista previa otra vez).
const SECRETO = crypto.randomBytes(32);

const fmt = movementsCalc.fechaHoraLocal;
const aFecha = (s) => new Date(String(s).replace(' ', 'T'));
const mesDe = (s) => String(s).slice(0, 7);
function mesMas(periodo, n) {
  let [a, m] = periodo.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; a += 1; }
  while (m < 1) { m += 12; a -= 1; }
  return `${a}-${String(m).padStart(2, '0')}`;
}
const finDeMes = (periodo) => {
  const [a, m] = periodo.split('-').map(Number);
  return `${periodo}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;
};
const huella = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');

function firmar(datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}
function leerComprobante(texto) {
  const [cuerpo, firma] = String(texto || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('base64url');
  if (esperada.length !== firma.length || !crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(firma))) return null;
  try { return JSON.parse(Buffer.from(cuerpo, 'base64url').toString()); } catch { return null; }
}

class Rechazo extends Error {
  constructor(status, error, codigo) { super(error); this.status = status; this.codigo = codigo; }
}

module.exports = function correccionesFichajesRoutes(db, { calcularAsistencia, calcularSalidas }) {
  const router = express.Router();

  let tablaLista = false;
  async function tablaDisponible() {
    if (tablaLista) return true;
    const [r] = await db.query("SHOW TABLES LIKE 'fichajes_correcciones'");
    tablaLista = r.length > 0;
    return tablaLista;
  }
  const exigirTabla = async (req, res, next) => {
    try {
      if (await tablaDisponible()) return next();
      return res.status(503).json({ error: 'Falta correr la migración 20261027_correcciones_fichajes.', codigo: 'FALTA_MIGRACION' });
    } catch (err) { return next(err); }
  };
  const empresa = (req) => {
    const t = resolveTenantId(req);
    if (t == null) throw new Rechazo(400, 'Elegí una empresa');
    return Number(t);
  };

  // ---------------------------------------------------------------------
  // El fichaje, tal como lo mandó el reloj, y de quién es (misma resolución
  // de persona que los motores).
  async function fichaje(tenantId, checkinId) {
    const [[c]] = await db.query(
      'SELECT id, USERID, CHECKTIME, MACHINE_IP, source FROM Checkins WHERE id = ? AND tenant_id = ?', [checkinId, tenantId]);
    if (!c) throw new Rechazo(404, 'No se encontró ese fichaje.');
    const hora = String(c.CHECKTIME);
    const lecturas = await campanaService.fetchMovementCheckinsCrudos(db, hora, fmt(new Date(aFecha(hora).getTime() + 1000)), tenantId);
    // Mismo número crudo y misma hora (únicos por empresa): ese es el fichaje.
    const propia = lecturas.find((x) => Number(x.userId) === Number(c.USERID) && fmt(x.checktime) === hora);
    if (!propia || !propia.employeeId) {
      throw new Rechazo(400, 'Ese fichaje no es de una persona (es un marcador o un número del reloj sin vincular). '
        + 'Los marcadores se corrigen con "Corregir marcador"; los números sin vincular, en la vinculación de fichajes.', 'NO_ES_DE_PERSONA');
    }
    const [[emp]] = await db.query('SELECT nombre FROM employees WHERE tenant_id = ? AND employee_id = ?', [tenantId, propia.employeeId]);
    return { id: Number(c.id), userid: Number(c.USERID), time: hora, machineIp: c.MACHINE_IP || null, source: c.source,
      legajo: String(propia.employeeId), nombre: emp ? emp.nombre : null };
  }

  // Los movimientos del día por marcador (Particular, Oficial, horas extra),
  // como los arma cada pantalla, sobre la lista que devuelve
  // fetchMovementCheckins (con las correcciones del contexto aplicadas).
  async function movimientosDelDia(tenantId, fecha) {
    const hasta = fmt(new Date(aFecha(`${fecha} 00:00:00`).getTime() + 86400000)).slice(0, 10);
    const filas = await campanaService.fetchMovementCheckins(db, fecha, hasta, tenantId);
    const opciones = {
      maxMarkerGapMs: await campanaService.fetchMarkerMaxGapMs(db, tenantId),
      todosLosMarcadores: await campanaService.fetchMarkerMap(db, null, tenantId),
      correccionesMarcadores: await campanaService.fetchCorreccionesMarcadores(db, fecha, hasta, tenantId),
      ownCheckinBounceMs: await campanaService.fetchVentanaReboteMs(db, tenantId),
      ventanaLlegadaParticularMs: await campanaService.fetchVentanaLlegadaParticularMs(db, tenantId),
    };
    const eventos = [];
    for (const cat of CATEGORIAS_DIA) {
      const mapa = await campanaService.fetchMarkerMap(db, cat, tenantId);
      if (!Object.keys(mapa).length) continue;
      const r = movementsCalc.detectMovements(filas, mapa, opciones);
      for (const e of r.closedEvents) eventos.push(e);
      for (const [employeeId, e] of r.openEvents) eventos.push({ ...e, employeeId });
      for (const e of r.orphanReturns) eventos.push(e);
    }
    return { filas, eventos };
  }

  // Auditoría de relojes: cada marcador asignado tiene que venir del MISMO
  // reloj que el fichaje que se lo llevó (o del carril privado de la misma
  // corrección). Lo único que cruza relojes a propósito es "Corregir
  // marcador" ("era de X"), que viene marcado como corregido.
  function relojesMezclados(filas, eventos) {
    const carril = (f) => (f ? f.machineIp ?? null : undefined);
    const buscar = (pred) => filas.find(pred);
    // (buscar: la lectura de la persona es única por persona y segundo.)
    const problemas = [];
    for (const e of eventos) {
      for (const [t, u, at, manual] of [[e.timeOut, e.salidaMarkerUserId, e.salidaMarkerAt, e.salidaCorregida], [e.timeIn, e.regresoMarkerUserId, e.regresoMarkerAt, e.regresoCorregido]]) {
        if (!t || u == null || !at || manual === true) continue;
        const persona = buscar((f) => String(f.employeeId) === String(e.employeeId) && +f.checktime === +t);
        // El mismo marcador puede haberse apretado en el mismo segundo en dos
        // relojes: hay problema solo si NINGUNA de esas lecturas es del reloj
        // (o carril) del fichaje.
        const marcadores = filas.filter((f) => !f.employeeId && String(f.userId) === String(u) && +f.checktime === +at);
        const a = carril(persona);
        if (a === undefined || a === null || !marcadores.length || marcadores.some((m) => carril(m) == null)) continue;
        if (!marcadores.some((m) => carril(m) === a)) problemas.push(`${e.employeeId} ${fmt(t)}: marcador de ${carril(marcadores[0])}, fichaje de ${a}`);
      }
    }
    return problemas;
  }

  // Todo lo que muestra el sistema para un mes, por persona: el resumen de
  // Presentismo, las salidas (Particular y Oficial) y las campañas.
  async function estadoDelMes(req, tenantId, periodo) {
    const desde = `${periodo}-01`;
    const hasta = finDeMes(periodo);
    const [asis, part, ofi, camp] = await Promise.all([
      calcularAsistencia(req, desde, hasta, tenantId),
      calcularSalidas(req, desde, hasta, tenantId, 'PARTICULAR'),
      calcularSalidas(req, desde, hasta, tenantId, 'OFICIAL'),
      campanaService.detectarCampanas(db, tenantId, desde, hasta),
    ]);
    const porLegajo = new Map();
    const de = (l) => {
      const k = String(l);
      if (!porLegajo.has(k)) porLegajo.set(k, { resumen: null, nombre: null, salidas: [], campanas: [] });
      return porLegajo.get(k);
    };
    for (const r of asis.data || []) { const p = de(r.employeeId); p.resumen = r; p.nombre = r.name; }
    for (const r of [...(part.rows || []), ...(ofi.rows || [])]) {
      de(r.employeeId).salidas.push(`${r.category} ${r.timeOut || '—'} → ${r.timeIn || '—'}${r.durationMinutes != null ? ` (${r.durationMinutes} min)` : ''}`);
    }
    for (const e of camp) {
      de(e.employeeId).campanas.push(`${e.timeOut ? fmt(e.timeOut) : '—'} → ${e.timeIn ? fmt(e.timeIn) : 'abierta'}`);
    }
    for (const p of porLegajo.values()) { p.salidas.sort(); p.campanas.sort(); }
    return porLegajo;
  }

  function diferencias(antes, despues) {
    const cambios = [];
    for (const legajo of new Set([...antes.keys(), ...despues.keys()])) {
      const a = antes.get(legajo) || { resumen: {}, salidas: [], campanas: [] };
      const d = despues.get(legajo) || { resumen: {}, salidas: [], campanas: [] };
      const resumen = [];
      const ra = a.resumen || {}, rd = d.resumen || {};
      for (const campo of new Set([...Object.keys(ra), ...Object.keys(rd)])) {
        if (JSON.stringify(ra[campo]) !== JSON.stringify(rd[campo])) resumen.push({ campo, antes: ra[campo] ?? null, despues: rd[campo] ?? null });
      }
      const quitadas = a.salidas.filter((x) => !d.salidas.includes(x));
      const agregadas = d.salidas.filter((x) => !a.salidas.includes(x));
      const campQ = a.campanas.filter((x) => !d.campanas.includes(x));
      const campA = d.campanas.filter((x) => !a.campanas.includes(x));
      if (resumen.length || quitadas.length || agregadas.length || campQ.length || campA.length) {
        cambios.push({ legajo, nombre: d.nombre || a.nombre || null, resumen,
          salidas: { quitadas, agregadas }, campanas: { quitadas: campQ, agregadas: campA } });
      }
    }
    return cambios;
  }

  // Detalle por día (estado, fichajes, horas extra...) de las personas con
  // cambios, para que se vea QUÉ día cambia y cómo.
  const CAMPOS_DIA = ['status', 'firstCheckin', 'lastCheckin', 'totalCheckins', 'checkins', 'overtimeMinutes', 'hasParticularExit', 'workedMinutes', 'lateMinutes'];
  async function diasQueCambian(req, tenantId, periodo, legajo, sim) {
    const desde = `${periodo}-01`, hasta = finDeMes(periodo);
    const [a, d] = await Promise.all([
      calcularAsistencia(req, desde, hasta, tenantId, { employeeId: legajo }),
      correcciones.conSimulacion(sim, () => calcularAsistencia(req, desde, hasta, tenantId, { employeeId: legajo })),
    ]);
    const dias = (r) => new Map((((r.data || []).find((x) => String(x.employeeId) === legajo) || {}).days || []).map((x) => [x.date, x]));
    const da = dias(a), dd = dias(d);
    const out = [];
    for (const fecha of [...new Set([...da.keys(), ...dd.keys()])].sort()) {
      const x = da.get(fecha) || {}, y = dd.get(fecha) || {};
      const campos = CAMPOS_DIA.filter((c) => JSON.stringify(x[c]) !== JSON.stringify(y[c]))
        .map((c) => ({ campo: c, antes: x[c] ?? null, despues: y[c] ?? null }));
      if (campos.length) out.push({ fecha, campos });
    }
    return out;
  }

  // Meses cerrados en Liquidación y si la diferencia se puede pagar como ajuste.
  async function situacionDeCierres(tenantId, periodos, hayCambios) {
    let estados = {};
    try {
      const desde = periodos[0], hasta = mesMas(periodos[periodos.length - 1], MESES_AJUSTE);
      const [filas] = await db.query(
        `SELECT c.periodo, c.accion FROM overtime_period_closings c
          WHERE c.id IN (SELECT MAX(id) FROM overtime_period_closings WHERE tenant_id = ? AND periodo BETWEEN ? AND ? GROUP BY periodo)`,
        [tenantId, desde, hasta]);
      estados = Object.fromEntries(filas.map((f) => [f.periodo, f.accion]));
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err; // sin migración 20261008: ningún mes cerrado
    }
    const cerrado = (p) => estados[p] === 'CERRAR';
    const cerrados = periodos.filter(cerrado);
    if (!cerrados.length || !hayCambios) return { cerrados, bloqueo: null, ajusteEn: null };
    let tablaAjustes = true;
    try { await db.query('SELECT 1 FROM overtime_period_adjustments LIMIT 1'); } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') tablaAjustes = false; else throw err;
    }
    const ajusteEn = {};
    for (const m of cerrados) {
      let p = mesMas(m, 1);
      while (cerrado(p) && p <= mesMas(m, MESES_AJUSTE)) p = mesMas(p, 1);
      if (!tablaAjustes || p > mesMas(m, MESES_AJUSTE)) {
        return { cerrados, ajusteEn: null,
          bloqueo: `${m} está cerrado en Liquidación y esta corrección cambia lo calculado. `
            + (tablaAjustes
              ? `La diferencia solo se paga como ajuste si se cierra un mes dentro de los ${MESES_AJUSTE} siguientes, y están todos cerrados. Reabrí los meses en Liquidación para poder corregir.`
              : 'Falta la migración de ajustes de Liquidación (20261009): la diferencia no se podría pagar.') };
      }
      ajusteEn[m] = p;
    }
    return { cerrados, bloqueo: null, ajusteEn };
  }

  // ---------------------------------------------------------------------
  // El análisis completo de una propuesta. `prop`:
  //   { tipo: 'crear', checkinId, accion, marcadorUserId }
  //   { tipo: 'deshacer', correccionId }
  async function analizar(req, tenantId, prop) {
    const bloqueos = [];
    let fic, sim, existente = null;
    if (prop.tipo === 'crear') {
      if (!correcciones.ACCIONES.includes(prop.accion)) throw new Rechazo(400, `accion tiene que ser ${correcciones.ACCIONES.join(', ')}`);
      fic = await fichaje(tenantId, prop.checkinId);
      const [[activa]] = await db.query(
        'SELECT id FROM fichajes_correcciones WHERE tenant_id = ? AND checkin_id = ? AND deshecha_at IS NULL', [tenantId, fic.id]);
      if (activa) throw new Rechazo(409, `Ese fichaje ya tiene una corrección activa (#${activa.id}). Deshacela primero.`, 'YA_CORREGIDO');
      let marcadorUserId = null;
      if (prop.accion === 'CAMBIAR_MARCADOR') {
        marcadorUserId = Number(prop.marcadorUserId);
        const [[m]] = await db.query(
          'SELECT userId, badgeNumber FROM specialusers WHERE tenant_id = ? AND userId = ? AND isActive = TRUE AND direction IS NOT NULL', [tenantId, marcadorUserId]);
        if (!m) throw new Rechazo(400, 'Ese marcador no está configurado en la empresa.');
        // El marcador elegido lleva la hora exacta del fichaje. Si ese mismo
        // marcador se leyó de verdad en ese mismo segundo, podrían confundirse.
        const numeros = [m.userId, m.badgeNumber].filter((x) => x != null && /^\d+$/.test(String(x))).map(Number);
        const [[mismo]] = await db.query(
          'SELECT COUNT(*) AS n FROM Checkins WHERE tenant_id = ? AND CHECKTIME = ? AND USERID IN (?)', [tenantId, fic.time, numeros]);
        if (Number(mismo.n) > 0) bloqueos.push('Ese marcador se apretó en el mismo segundo que el fichaje: no se puede asignar sin riesgo de confundirlos.');
      }
      // Multireloj: sin reloj identificado no se puede asegurar que los
      // marcadores no se mezclen entre relojes.
      if (!fic.machineIp) bloqueos.push('El fichaje no tiene reloj identificado: no se puede corregir sin riesgo de mezclar relojes.');
      const gapMs = await campanaService.fetchMarkerMaxGapMs(db, tenantId);
      const [[sinReloj]] = await db.query(
        `SELECT COUNT(*) AS n FROM Checkins WHERE tenant_id = ? AND CHECKTIME BETWEEN ? AND ?
            AND (MACHINE_IP IS NULL OR MACHINE_IP = '') AND id <> ?`,
        [tenantId, fmt(new Date(aFecha(fic.time).getTime() - gapMs)), fmt(new Date(aFecha(fic.time).getTime() + gapMs)), fic.id]);
      if (Number(sinReloj.n) > 0) bloqueos.push('Hay lecturas sin reloj identificado en los segundos de alrededor: no se puede corregir sin riesgo de mezclar relojes.');
      // Convivencia con "Corregir marcador": si a esta persona le asignaron
      // a mano un marcador poco antes, ese marcador puede ser justamente el
      // de este fichaje (sección 3 ter del diseño).
      const [mc] = await db.query(
        `SELECT id, marker_time FROM marker_corrections WHERE tenant_id = ? AND assigned_employee_id = ?
            AND marker_time BETWEEN ? AND ?`,
        [tenantId, fic.legajo, fmt(new Date(aFecha(fic.time).getTime() - movementsCalc.VENTANA_MARCADOR_CORREGIDO_MS)), fic.time]).catch((err) => {
        if (err.code === 'ER_NO_SUCH_TABLE') return [[]];
        throw err;
      });
      if (mc.length) bloqueos.push(`A esta persona le asignaron a mano un marcador poco antes (${String(mc[0].marker_time).slice(11)}, corrección de marcador #${mc[0].id}). Deshacé esa corrección primero para que no se contradigan.`);
      sim = { tenantId, agregar: [{ id: 0, checkinId: fic.id, userid: fic.userid, time: fic.time, machineIp: fic.machineIp,
        employeeId: fic.legajo, accion: prop.accion, marcadorUserId, motivo: '(vista previa)', por: null, en: null }] };
    } else {
      const [[c]] = await db.query('SELECT * FROM fichajes_correcciones WHERE id = ? AND tenant_id = ?', [prop.correccionId, tenantId]);
      if (!c) throw new Rechazo(404, 'No se encontró esa corrección.');
      if (c.deshecha_at) throw new Rechazo(409, 'Esa corrección ya está deshecha.', 'YA_DESHECHA');
      existente = c;
      fic = { id: Number(c.checkin_id), userid: Number(c.checkin_userid), time: String(c.checkin_time), machineIp: c.checkin_machine_ip,
        legajo: c.employee_id != null ? String(c.employee_id) : null, nombre: null };
      sim = { tenantId, quitar: [c.id] };
    }

    // Los meses que se calculan: el del fichaje y, si ya empezó, el siguiente
    // (una salida o una campaña de varios días puede cruzar el fin de mes).
    const mes = mesDe(fic.time);
    const hoy = await hoyDeEmpresa(db, tenantId);
    const periodos = [mes];
    if (`${mesMas(mes, 1)}-01` <= hoy) periodos.push(mesMas(mes, 1));

    let cambios = [];
    const detalle = {};
    let comprobacion = [];
    try {
      for (const p of periodos) {
        const [antes, despues] = await Promise.all([
          estadoDelMes(req, tenantId, p),
          correcciones.conSimulacion(sim, () => estadoDelMes(req, tenantId, p)),
        ]);
        for (const c of diferencias(antes, despues)) cambios.push({ periodo: p, ...c });
      }
      // Día del fichaje: qué interpreta el motor de cada fichaje (salidas y
      // horas extra por marcador), persona por persona. Puede cambiarle la
      // interpretación a alguien aunque sus totales no cambien (ej. su
      // fichaje pasa a ser "inicio de horas extra"): eso también es un cambio.
      const fecha = fic.time.slice(0, 10);
      const [diaAntes, dia] = await Promise.all([
        movimientosDelDia(tenantId, fecha),
        correcciones.conSimulacion(sim, () => movimientosDelDia(tenantId, fecha)),
      ]);
      const textos = (d) => {
        const m = new Map();
        for (const e of d.eventos) {
          if (correcciones.esInterno(e.employeeId)) continue;
          const k = String(e.employeeId);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(`${e.category} ${e.timeOut ? fmt(e.timeOut).slice(11) : '—'} → ${e.timeIn ? fmt(e.timeIn).slice(11) : '—'}`);
        }
        return m;
      };
      const movA = textos(diaAntes), movD = textos(dia);
      for (const legajo of new Set([...movA.keys(), ...movD.keys()])) {
        const a = movA.get(legajo) || [], d = movD.get(legajo) || [];
        const quitados = a.filter((x) => !d.includes(x)), agregados = d.filter((x) => !a.includes(x));
        if (!quitados.length && !agregados.length) continue;
        let c = cambios.find((x) => x.legajo === legajo && x.periodo === mesDe(fecha));
        if (!c) {
          const [[e]] = await db.query('SELECT nombre FROM employees WHERE tenant_id = ? AND employee_id = ?', [tenantId, legajo]);
          c = { periodo: mesDe(fecha), legajo, nombre: e ? e.nombre : null, resumen: [], salidas: { quitadas: [], agregadas: [] }, campanas: { quitadas: [], agregadas: [] } };
          cambios.push(c);
        }
        c.movimientosDelDia = { fecha, quitados, agregados };
      }
      comprobacion = relojesMezclados(dia.filas, dia.eventos);
      if (comprobacion.length) bloqueos.push(`Con esta corrección, un marcador quedaría con un fichaje de otro reloj (${comprobacion[0]}). No se puede confirmar.`);
      if (prop.tipo === 'crear' && prop.accion === 'CAMBIAR_MARCADOR') {
        const t = aFecha(fic.time).getTime();
        const tomado = dia.eventos.some((e) => String(e.employeeId) === fic.legajo && (
          (e.timeOut && +e.timeOut === t && String(e.salidaMarkerUserId) === String(sim.agregar[0].marcadorUserId) && e.salidaMarkerAt && +e.salidaMarkerAt === t)
          || (e.timeIn && +e.timeIn === t && String(e.regresoMarkerUserId) === String(sim.agregar[0].marcadorUserId) && e.regresoMarkerAt && +e.regresoMarkerAt === t)));
        if (!tomado) bloqueos.push('El cálculo no le asignaría ese marcador a este fichaje (por ejemplo, porque hay otra lectura de la persona en el mismo segundo). No se puede confirmar.');
      }
      // Detalle por día de la persona y de las otras afectadas (hasta 10).
      const legajos = [...new Set([fic.legajo, ...cambios.map((c) => c.legajo)])].filter(Boolean).slice(0, MAX_PERSONAS_CON_DETALLE + 1);
      for (const p of periodos) {
        for (const l of legajos) {
          const dias = await diasQueCambian(req, tenantId, p, l, sim);
          if (dias.length) (detalle[l] ||= []).push(...dias);
        }
      }
    } catch (err) {
      if (err instanceof Rechazo) throw err;
      console.error('correcciones de fichajes: no se pudo calcular el impacto', err);
      throw new Rechazo(500, 'No se pudo calcular el impacto de la corrección, así que no se puede confirmar.', 'SIN_IMPACTO');
    }

    const otros = cambios.filter((c) => c.legajo !== fic.legajo);
    const cierres = await situacionDeCierres(tenantId, periodos, cambios.length > 0);
    if (cierres.bloqueo) bloqueos.push(cierres.bloqueo);
    const resultado = {
      fichaje: { id: fic.id, hora: fic.time, reloj: fic.machineIp, numeroEnReloj: fic.userid, legajo: fic.legajo, nombre: fic.nombre || (cambios.find((c) => c.legajo === fic.legajo) || {}).nombre || null },
      propuesta: prop.tipo === 'crear'
        ? { tipo: 'crear', accion: prop.accion, marcadorUserId: prop.accion === 'CAMBIAR_MARCADOR' ? Number(prop.marcadorUserId) : null }
        : { tipo: 'deshacer', correccionId: Number(prop.correccionId), accion: existente.accion },
      periodos,
      cambios,
      detallePorDia: detalle,
      afectaAOtros: otros.length > 0,
      otrosAfectados: otros.map((c) => ({ legajo: c.legajo, nombre: c.nombre })),
      cierres,
      bloqueos,
    };
    return resultado;
  }

  const comprobanteDe = (req, tenantId, r) => (r.bloqueos.length ? null : firmar({
    t: tenantId, u: req.appUser ? req.appUser.id : null, p: r.propuesta, f: r.fichaje.id,
    h: huella({ cambios: r.cambios, detalle: r.detallePorDia, cierres: r.cierres }), exp: Date.now() + VIGENCIA_COMPROBANTE_MS,
  }));

  // Vuelve a calcular y exige que coincida con lo que se vio.
  async function verificarConfirmacion(req, tenantId, prop, body) {
    const comp = leerComprobante(body.comprobante);
    if (!comp || comp.exp < Date.now() || comp.t !== tenantId || comp.u !== (req.appUser ? req.appUser.id : null)) {
      throw new Rechazo(409, 'Falta la vista previa o ya venció (dura 15 minutos). Mirala de nuevo antes de confirmar.', 'SIN_VISTA_PREVIA');
    }
    const r = await analizar(req, tenantId, prop);
    if (JSON.stringify(comp.p) !== JSON.stringify(r.propuesta) || comp.f !== r.fichaje.id) {
      throw new Rechazo(409, 'La vista previa era de otra corrección. Mirala de nuevo.', 'SIN_VISTA_PREVIA');
    }
    if (r.bloqueos.length) throw Object.assign(new Rechazo(409, r.bloqueos[0], 'BLOQUEADA'), { analisis: r });
    if (comp.h !== huella({ cambios: r.cambios, detalle: r.detallePorDia, cierres: r.cierres })) {
      throw Object.assign(new Rechazo(409, 'El resultado cambió desde la vista previa (llegaron fichajes o hubo otra corrección). Mirala de nuevo.', 'CAMBIO'), { analisis: r });
    }
    if (r.afectaAOtros && body.confirmoOtros !== true) {
      throw Object.assign(new Rechazo(409, 'Esta corrección cambia el resultado de otras personas: hace falta confirmarlo explícitamente.', 'CONFIRMAR_OTROS'), { analisis: r });
    }
    return r;
  }
  const resumenImpacto = (r) => JSON.stringify({ periodos: r.periodos, cambios: r.cambios, otros: r.otrosAfectados, cierres: r.cierres });
  const motivoDe = (body) => {
    const m = String((body && body.motivo) || '').trim();
    if (m.length < 5) throw new Rechazo(400, 'El motivo es obligatorio (al menos 5 letras).');
    if (m.length > 500) throw new Rechazo(400, 'El motivo puede tener hasta 500 letras.');
    return m;
  };
  const responderError = (res, err, que) => {
    if (err instanceof Rechazo) return res.status(err.status).json({ error: err.message, codigo: err.codigo, ...(err.analisis ? { vistaPrevia: err.analisis } : {}) });
    if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese fichaje ya tiene una corrección activa.', codigo: 'YA_CORREGIDO' });
    console.error(`ERROR correcciones de fichajes (${que}):`, err);
    return res.status(500).json({ error: 'Error en correcciones de fichajes' });
  };
  const fila = (r) => ({
    id: r.id, checkinId: r.checkin_id, hora: String(r.checkin_time), reloj: r.checkin_machine_ip, numeroEnReloj: r.checkin_userid,
    legajo: r.employee_id != null ? String(r.employee_id) : null, nombre: r.nombre ?? null,
    accion: r.accion, marcadorUserId: r.marcador_user_id, motivo: r.motivo, afectaAOtros: !!r.afecta_a_otros,
    por: r.creado_por ?? null, en: r.created_at != null ? String(r.created_at) : null,
    deshecha: r.deshecha_at != null, deshechaPor: r.deshecha_por_email ?? null,
    deshechaEn: r.deshecha_at != null ? String(r.deshecha_at) : null, motivoDeshacer: r.motivo_deshacer ?? null,
    huerfana: r.c_id == null || Number(r.c_userid) !== Number(r.checkin_userid) || String(r.c_time) !== String(r.checkin_time) || (r.c_ip ?? null) !== (r.checkin_machine_ip ?? null),
  });
  const SELECT_FILAS = `
    SELECT fc.*, e.nombre, cu.email AS creado_por, du.email AS deshecha_por_email,
           c.id AS c_id, c.USERID AS c_userid, c.CHECKTIME AS c_time, c.MACHINE_IP AS c_ip
      FROM fichajes_correcciones fc
      LEFT JOIN employees e ON e.tenant_id = fc.tenant_id AND e.employee_id = fc.employee_id
      LEFT JOIN app_users cu ON cu.id = fc.created_by
      LEFT JOIN app_users du ON du.id = fc.deshecha_por
      LEFT JOIN Checkins c ON c.id = fc.checkin_id AND c.tenant_id = fc.tenant_id`;

  // ---------------------------------------------------------------------
  router.get('/', requirePermission('fichajes', 'read'), exigirTabla, async (req, res) => {
    try {
      const tenantId = empresa(req);
      const where = ['fc.tenant_id = ?'];
      const params = [tenantId];
      const FECHA = /^\d{4}-\d{2}-\d{2}$/;
      if (req.query.desde) { if (!FECHA.test(req.query.desde)) throw new Rechazo(400, 'desde: AAAA-MM-DD'); where.push('fc.checkin_time >= ?'); params.push(req.query.desde); }
      if (req.query.hasta) { if (!FECHA.test(req.query.hasta)) throw new Rechazo(400, 'hasta: AAAA-MM-DD'); where.push('fc.checkin_time < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(req.query.hasta); }
      if (req.query.legajo) { where.push('fc.employee_id = ?'); params.push(String(req.query.legajo)); }
      if (req.query.accion) { if (!correcciones.ACCIONES.includes(req.query.accion)) throw new Rechazo(400, 'accion inválida'); where.push('fc.accion = ?'); params.push(req.query.accion); }
      const estado = req.query.estado || 'activas';
      if (estado === 'activas') where.push('fc.deshecha_at IS NULL');
      else if (estado === 'deshechas') where.push('fc.deshecha_at IS NOT NULL');
      else if (estado !== 'todas') throw new Rechazo(400, 'estado: activas, deshechas o todas');
      const porPagina = Math.min(Math.max(Number(req.query.porPagina) || 50, 1), 200);
      const pagina = Math.max(Number(req.query.pagina) || 1, 1);
      const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM fichajes_correcciones fc WHERE ${where.join(' AND ')}`, params);
      const [filas] = await db.query(`${SELECT_FILAS} WHERE ${where.join(' AND ')} ORDER BY fc.checkin_time DESC, fc.id DESC LIMIT ? OFFSET ?`,
        [...params, porPagina, (pagina - 1) * porPagina]);
      res.json({ total: Number(total), pagina, porPagina, filas: filas.map(fila) });
    } catch (err) { responderError(res, err, 'listar'); }
  });

  router.get('/fichaje/:checkinId', requirePermission('fichajes', 'read'), exigirTabla, async (req, res) => {
    try {
      const tenantId = empresa(req);
      const [filas] = await db.query(`${SELECT_FILAS} WHERE fc.tenant_id = ? AND fc.checkin_id = ? ORDER BY fc.id`, [tenantId, Number(req.params.checkinId)]);
      res.json({ checkinId: Number(req.params.checkinId), historial: filas.map(fila) });
    } catch (err) { responderError(res, err, 'historial'); }
  });

  router.get('/vista-previa', requirePermission('fichajes', 'read'), exigirTabla, async (req, res) => {
    try {
      const tenantId = empresa(req);
      const prop = { tipo: 'crear', checkinId: Number(req.query.checkinId), accion: String(req.query.accion || ''), marcadorUserId: req.query.marcadorUserId };
      if (!Number.isInteger(prop.checkinId)) throw new Rechazo(400, 'checkinId es requerido');
      const r = await analizar(req, tenantId, prop);
      res.json({ ...r, comprobante: comprobanteDe(req, tenantId, r) });
    } catch (err) { responderError(res, err, 'vista previa'); }
  });

  router.post('/', requirePermission('fichajes', 'update'), exigirTabla, async (req, res) => {
    try {
      const tenantId = empresa(req);
      const motivo = motivoDe(req.body);
      const prop = { tipo: 'crear', checkinId: Number(req.body.checkinId), accion: String(req.body.accion || ''), marcadorUserId: req.body.marcadorUserId };
      if (!Number.isInteger(prop.checkinId)) throw new Rechazo(400, 'checkinId es requerido');
      const r = await verificarConfirmacion(req, tenantId, prop, req.body);
      const [ins] = await db.query(
        `INSERT INTO fichajes_correcciones
           (tenant_id, checkin_id, checkin_userid, checkin_time, checkin_machine_ip, employee_id, accion, marcador_user_id, motivo, impacto, afecta_a_otros, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, r.fichaje.id, r.fichaje.numeroEnReloj, r.fichaje.hora, r.fichaje.reloj, r.fichaje.legajo,
          prop.accion, r.propuesta.marcadorUserId, motivo, resumenImpacto(r), r.afectaAOtros ? 1 : 0, auditLog.actorId(req)]);
      res.status(201).json({ id: ins.insertId, vistaPrevia: r });
    } catch (err) { responderError(res, err, 'crear'); }
  });

  router.get('/:id/deshacer/vista-previa', requirePermission('fichajes', 'read'), exigirTabla, async (req, res) => {
    try {
      const tenantId = empresa(req);
      const r = await analizar(req, tenantId, { tipo: 'deshacer', correccionId: Number(req.params.id) });
      res.json({ ...r, comprobante: comprobanteDe(req, tenantId, r) });
    } catch (err) { responderError(res, err, 'vista previa deshacer'); }
  });

  router.post('/:id/deshacer', requirePermission('fichajes', 'update'), exigirTabla, async (req, res) => {
    try {
      const tenantId = empresa(req);
      const motivo = motivoDe(req.body);
      const r = await verificarConfirmacion(req, tenantId, { tipo: 'deshacer', correccionId: Number(req.params.id) }, req.body);
      const [up] = await db.query(
        `UPDATE fichajes_correcciones SET deshecha_por = ?, deshecha_at = NOW(), motivo_deshacer = ?, impacto_deshacer = ?
          WHERE id = ? AND tenant_id = ? AND deshecha_at IS NULL`,
        [auditLog.actorId(req), motivo, resumenImpacto(r), Number(req.params.id), tenantId]);
      if (!up.affectedRows) throw new Rechazo(409, 'Esa corrección ya está deshecha.', 'YA_DESHECHA');
      res.json({ id: Number(req.params.id), deshecha: true, vistaPrevia: r });
    } catch (err) { responderError(res, err, 'deshacer'); }
  });

  return router;
};
