// /api/liquidacion-horas-extra -- informe para liquidacion y cierre de mes
// (bloque B5). Tablas: migracion 20261008. Diseño: HORAS_EXTRA_REGIMENES.md.
//
//   GET  /?periodo=AAAA-MM[&comparar=1]  informe del mes: si esta cerrado, la
//                                        foto del cierre; si no, el calculo en
//                                        vivo. comparar=1 en un mes cerrado
//                                        dice cuantas personas cambiarian hoy.
//   GET  /cierres?anio=AAAA               historial de cierres y reaperturas
//   POST /cierres        { periodo }             cierra el mes (guarda la foto)
//   POST /cierres/reabrir { periodo, motivo }    lo reabre (motivo obligatorio)
//
// AJUSTES DE MESES ANTERIORES (migracion 20261009): un mes cerrado se puede
// seguir corrigiendo y la diferencia se paga (o descuenta) al mes siguiente.
// El informe de un mes abierto revisa los MESES_AJUSTE meses anteriores que
// esten cerrados: lo que da hoy cada uno MENOS lo ya pagado por el (foto +
// ajustes ya pagados) = "ajuste". Al cerrar, esos ajustes quedan PAGADOS.
// "Comparar" usa exactamente la misma cuenta, asi nunca se contradicen.
//
// LA REGLA DE ORO: el informe sale del MISMO calculo que Presentismo
// (`calcularAsistencia`, que corre /attendance-range dentro del proceso).
// No hay una segunda formula que pueda dar distinto.
//
// Por que el cierre va en orden dentro del año: el tope ANUAL de cada mes
// depende de lo computado en los meses anteriores. Si se pudiera cerrar
// marzo con febrero abierto, o reabrir febrero con marzo cerrado, la foto de
// marzo quedaria calculada con un acumulado que ya no es el real.
const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');
const { hoyDeEmpresa } = require('../motor-laboral/services/hoyEmpresa');

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;
// Cuantos meses para atras se buscan correcciones. Medido en la copia de
// produccion (479 personas): ~0,6 s por mes, asi que 3 meses suman ~2 s.
const MESES_AJUSTE = 3;

// Los `n` meses anteriores a `periodo`, del mas cercano al mas lejano,
// cruzando de año si hace falta (en enero se revisa diciembre).
function mesesAntes(periodo, n) {
  let [a, m] = periodo.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m === 0) { m = 12; a -= 1; }
    out.push(`${a}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

const jsonDe = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));

function mesAnterior(periodo) {
  const [a, m] = periodo.split('-').map(Number);
  return m === 1 ? null : `${a}-${String(m - 1).padStart(2, '0')}`; // null: enero, no hay anterior en el año
}

function ultimoDia(periodo) {
  const [a, m] = periodo.split('-').map(Number);
  return `${periodo}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;
}

// Fila del informe a partir de una fila de /attendance-range. Todo en
// minutos enteros. "aLiquidar" es exactamente lo que muestra Presentismo
// como horas extra (overtimeHours), asi coinciden al minuto.
function filaDeLiquidacion(row, encuadre) {
  const r = row.regimenHorasExtra || null;
  const aLiquidar = Math.round(Number(row.overtimeHours || 0) * 60);
  return {
    legajo: Number(row.employeeId),
    nombre: row.name,
    convenio: encuadre ? encuadre.convenio : null,
    regimen: encuadre ? encuadre.regimen : null,
    conRegimen: !!r,
    reales: r ? Math.round(r.reales) : 0,
    computables: r ? Math.round(r.computables) : 0,
    manuales: r ? Math.round(r.manuales) : 0,
    aLiquidar,
    excedente: r ? Math.round(r.excedente) : 0,
    pendiente: r ? Math.round(r.pendiente) : 0,
    registradas: r ? Math.round(r.registradas) : 0,
    noComputadas: r ? Math.round(r.noComputadas) : 0,
    porRecargo: r ? Object.fromEntries(Object.entries(r.porRecargo || {}).map(([k, v]) => [k, Math.round(v)])) : {},
  };
}

const tieneAlgo = (f) => f.aLiquidar || f.reales || f.registradas || f.noComputadas || f.excedente || f.pendiente;

function totales(filas) {
  const t = { personas: filas.length, aLiquidar: 0, ajuste: 0, aPagar: 0, computables: 0, manuales: 0, excedente: 0, pendiente: 0, registradas: 0, porRecargo: {} };
  for (const f of filas) {
    for (const k of ['aLiquidar', 'ajuste', 'aPagar', 'computables', 'manuales', 'excedente', 'pendiente', 'registradas']) t[k] += f[k] || 0;
    for (const [k, v] of Object.entries(f.porRecargo)) t.porRecargo[k] = (t.porRecargo[k] || 0) + v;
  }
  return t;
}

/**
 * @param {import('mysql2/promise').Pool} db
 * @param {{calcularAsistencia:(req:object, from:string, to:string, tenantId:number)=>Promise<{data:object[]}>}} deps
 */
module.exports = function (db, { calcularAsistencia }) {
  const router = express.Router();
  const autor = (req) => (req.appUser ? req.appUser.id : null);

  function tenantONada(req, res) {
    const t = resolveTenantId(req);
    if (t == null) { res.status(400).json({ error: 'Elegí una empresa' }); return null; }
    return t;
  }

  // Ultima accion de cada mes pedido: { 'AAAA-MM': {id, accion, ...} }.
  async function estados(tenantId, periodos, conn = db) {
    if (!periodos.length) return {};
    const [rows] = await conn.query(
      `SELECT c.*, au.email AS created_by_email FROM overtime_period_closings c
       LEFT JOIN app_users au ON au.id = c.created_by
       WHERE c.id IN (SELECT MAX(id) FROM overtime_period_closings WHERE tenant_id = ? AND periodo IN (?) GROUP BY periodo)`,
      [tenantId, periodos]).catch((err) => {
      // Backend publicado antes que la migracion 20261008: ningun mes cerrado.
      if (err.code === 'ER_NO_SUCH_TABLE') return [[]];
      throw err;
    });
    return Object.fromEntries(rows.map((r) => [r.periodo, r]));
  }
  const estaCerrado = (e) => !!e && e.accion === 'CERRAR';

  // Meses del mismo año DESPUES de `periodo` que hoy estan cerrados.
  async function cerradosPosteriores(tenantId, periodo, conn = db) {
    const [rows] = await conn.query(
      `SELECT DISTINCT periodo FROM overtime_period_closings WHERE tenant_id = ? AND LEFT(periodo, 4) = ? AND periodo > ?`,
      [tenantId, periodo.slice(0, 4), periodo]);
    const e = await estados(tenantId, rows.map((r) => r.periodo), conn);
    return rows.map((r) => r.periodo).filter((p) => estaCerrado(e[p])).sort();
  }

  // Convenio y regimen vigentes el ultimo dia del mes, por legajo.
  async function encuadres(tenantId, periodo) {
    const dia = ultimoDia(periodo);
    const [rows] = await db.query(
      `SELECT e.employee_id AS legajo, c.name AS convenio, rg.name AS regimen
       FROM employee_convention_assignments a
       JOIN employees e ON e.id = a.employee_id AND e.tenant_id = ?
       JOIN labor_conventions c ON c.id = a.convention_id
       LEFT JOIN labor_convention_regimes rg ON rg.id = a.regime_id
       WHERE a.tenant_id = ? AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to >= ?)
       ORDER BY a.valid_from`, [tenantId, tenantId, dia, dia]).catch((err) => {
      // Antes de la migracion 20261007 no hay regimenes: solo el convenio.
      if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE') return [[]];
      throw err;
    });
    return new Map(rows.map((r) => [Number(r.legajo), r])); // la ultima vigente gana
  }

  async function calcularEnVivo(req, tenantId, periodo) {
    const cuerpo = await calcularAsistencia(req, `${periodo}-01`, ultimoDia(periodo), tenantId);
    const enc = await encuadres(tenantId, periodo);
    return (cuerpo.data || []).map((row) => filaDeLiquidacion(row, enc.get(Number(row.employeeId)))).filter(tieneAlgo);
  }

  async function foto(closingId) {
    const [rows] = await db.query('SELECT * FROM overtime_period_results WHERE closing_id = ? ORDER BY nombre', [closingId]);
    return rows.map((r) => ({
      legajo: r.legajo, nombre: r.nombre, convenio: r.convenio, regimen: r.regimen, conRegimen: !!r.con_regimen,
      reales: r.reales, computables: r.computables, manuales: r.manuales, aLiquidar: r.a_liquidar,
      excedente: r.excedente, pendiente: r.pendiente, registradas: r.registradas, noComputadas: r.no_computadas,
      porRecargo: typeof r.por_recargo === 'string' ? JSON.parse(r.por_recargo) : (r.por_recargo || {}),
    }));
  }

  // Ajustes ya PAGADOS por un mes de origen, que siguen valiendo: el mes en
  // que se pagaron sigue cerrado (si se reabrio, dejan de contar).
  async function ajustesPagadosDe(tenantId, origen, conn = db) {
    const [rows] = await conn.query(
      `SELECT a.* FROM overtime_period_adjustments a
       JOIN (SELECT periodo, MAX(id) AS ultimo FROM overtime_period_closings WHERE tenant_id = ? GROUP BY periodo) u ON u.ultimo = a.closing_id
       JOIN overtime_period_closings c ON c.id = u.ultimo AND c.accion = 'CERRAR'
       WHERE a.tenant_id = ? AND a.periodo_origen = ?`, [tenantId, tenantId, origen]).catch((err) => {
      if (err.code === 'ER_NO_SUCH_TABLE') return [[]]; // migracion 20261009 pendiente
      throw err;
    });
    return rows;
  }

  // Diferencia de un mes CERRADO: lo que da hoy menos lo ya pagado por el.
  // Solo las personas que cambian. `minutos` puede ser negativo (descuento).
  async function diferenciasDe(req, tenantId, periodo, cierre) {
    const pagado = new Map();
    const sumar = (legajo, nombre, minutos, computables, porRecargo) => {
      const p = pagado.get(legajo) || { nombre, minutos: 0, computables: 0, porRecargo: {} };
      p.minutos += minutos; p.computables += computables;
      for (const [k, v] of Object.entries(porRecargo || {})) p.porRecargo[k] = (p.porRecargo[k] || 0) + v;
      pagado.set(legajo, p);
    };
    for (const f of await foto(cierre.id)) sumar(f.legajo, f.nombre, f.aLiquidar, f.computables, f.porRecargo);
    for (const a of await ajustesPagadosDe(tenantId, periodo)) sumar(Number(a.legajo), a.nombre, a.minutos, a.computables, jsonDe(a.por_recargo));

    const cero = { minutos: 0, computables: 0, porRecargo: {} };
    const hoy = new Map((await calcularEnVivo(req, tenantId, periodo)).map((f) => [f.legajo, f]));
    const out = [];
    for (const legajo of new Set([...hoy.keys(), ...pagado.keys()])) {
      const v = hoy.get(legajo);
      const p = pagado.get(legajo) || cero;
      const ahora = v ? { minutos: v.aLiquidar, computables: v.computables, porRecargo: v.porRecargo } : cero;
      const porRecargo = {};
      for (const k of new Set([...Object.keys(ahora.porRecargo), ...Object.keys(p.porRecargo)])) {
        const d = (ahora.porRecargo[k] || 0) - (p.porRecargo[k] || 0);
        if (d) porRecargo[k] = d;
      }
      const minutos = ahora.minutos - p.minutos;
      const computables = ahora.computables - p.computables;
      if (minutos || computables) {
        out.push({ legajo, nombre: v ? v.nombre : p.nombre, periodoOrigen: periodo, pagado: p.minutos, hoy: ahora.minutos, minutos, computables, porRecargo });
      }
    }
    return out;
  }

  // Ajustes a pagar en `periodo`: las diferencias de los meses anteriores
  // que estan cerrados.
  async function ajustesParaMes(req, tenantId, periodo) {
    const origenes = mesesAntes(periodo, MESES_AJUSTE);
    const e = await estados(tenantId, origenes);
    const out = [];
    for (const p of origenes) if (estaCerrado(e[p])) out.push(...await diferenciasDe(req, tenantId, p, e[p]));
    return out;
  }

  // Suma a cada fila su ajuste (y agrega a quien solo tiene ajuste).
  function aplicarAjustes(filas, ajustes) {
    const porLegajo = new Map(filas.map((f) => [f.legajo, f]));
    for (const f of filas) { f.ajuste = 0; f.ajustes = []; }
    for (const a of ajustes) {
      let f = porLegajo.get(a.legajo);
      if (!f) {
        f = { legajo: a.legajo, nombre: a.nombre, convenio: null, regimen: null, conRegimen: false, reales: 0, computables: 0, manuales: 0, aLiquidar: 0,
          excedente: 0, pendiente: 0, registradas: 0, noComputadas: 0, porRecargo: {}, ajuste: 0, ajustes: [] };
        porLegajo.set(a.legajo, f);
        filas.push(f);
      }
      f.ajuste += a.minutos;
      f.ajustes.push({ periodo: a.periodoOrigen, minutos: a.minutos });
    }
    for (const f of filas) f.aPagar = f.aLiquidar + f.ajuste;
    return filas;
  }

  const ordenar = (filas) => filas.sort((a, b) => b.aPagar - a.aPagar || String(a.nombre).localeCompare(String(b.nombre)));

  router.get('/', requirePermission('attendance', 'read'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    const periodo = String(req.query.periodo || '');
    if (!PERIODO.test(periodo)) return res.status(400).json({ error: 'periodo (AAAA-MM) es requerido' });
    try {
      const estado = (await estados(tenantId, [periodo]))[periodo] || null;
      if (estaCerrado(estado)) {
        const [pagados] = await db.query('SELECT * FROM overtime_period_adjustments WHERE closing_id = ?', [estado.id])
          .catch((err) => (err.code === 'ER_NO_SUCH_TABLE' ? [[]] : Promise.reject(err)));
        const filas = ordenar(aplicarAjustes(await foto(estado.id),
          pagados.map((a) => ({ legajo: Number(a.legajo), nombre: a.nombre, periodoOrigen: a.periodo_origen, minutos: a.minutos }))));
        const respuesta = {
          periodo, estado: 'CERRADO',
          cierre: { id: estado.id, fecha: estado.created_at, por: estado.created_by_email },
          filas, totales: totales(filas),
        };
        if (req.query.comparar === '1') {
          // "cerrado" = lo ya pagado por este mes (foto + ajustes ya pagados
          // en meses siguientes); lo que falte se paga el mes que viene.
          respuesta.diferencias = (await diferenciasDe(req, tenantId, periodo, estado))
            .filter((d) => d.minutos)
            .map((d) => ({ legajo: d.legajo, nombre: d.nombre, cerrado: d.pagado, hoy: d.hoy }));
        }
        return res.json(respuesta);
      }
      const filas = ordenar(aplicarAjustes(await calcularEnVivo(req, tenantId, periodo), await ajustesParaMes(req, tenantId, periodo)));
      res.json({ periodo, estado: estado ? 'REABIERTO' : 'ABIERTO', mesesAjuste: MESES_AJUSTE, filas, totales: totales(filas) });
    } catch (err) {
      console.error('ERROR liquidacion horas extra:', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Error armando el informe' });
    }
  });

  router.get('/cierres', requirePermission('attendance', 'read'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    const anio = /^\d{4}$/.test(String(req.query.anio || '')) ? String(req.query.anio) : null;
    try {
      const [rows] = await db.query(
        `SELECT c.id, c.periodo, c.accion, c.motivo, c.created_at, au.email AS created_by_email
         FROM overtime_period_closings c LEFT JOIN app_users au ON au.id = c.created_by
         WHERE c.tenant_id = ? ${anio ? 'AND LEFT(c.periodo, 4) = ?' : ''} ORDER BY c.id DESC`,
        anio ? [tenantId, anio] : [tenantId]);
      res.json({ cierres: rows });
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ cierres: [] });
      console.error('ERROR liquidacion cierres:', err);
      res.status(500).json({ error: 'Error leyendo los cierres' });
    }
  });

  router.post('/cierres', requirePermission('attendance', 'update'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    const periodo = String((req.body || {}).periodo || '');
    if (!PERIODO.test(periodo)) return res.status(400).json({ error: 'periodo (AAAA-MM) es requerido' });
    try {
      const hoy = await hoyDeEmpresa(db, tenantId);
      if (periodo >= hoy.slice(0, 7)) return res.status(400).json({ error: 'Ese mes todavía no terminó: se cierra a partir del 1° del mes siguiente.' });

      // Validaciones de orden ANTES del calculo (que es lo lento).
      const validarOrden = async (conn) => {
        const e = await estados(tenantId, [periodo, mesAnterior(periodo)].filter(Boolean), conn);
        if (estaCerrado(e[periodo])) return { status: 409, error: 'Ese mes ya está cerrado.' };
        const posteriores = await cerradosPosteriores(tenantId, periodo, conn);
        if (posteriores.length) return { status: 409, error: `Primero reabrí ${posteriores[posteriores.length - 1]}: los meses se cierran en orden dentro del año.` };
        const anterior = mesAnterior(periodo);
        if (anterior && !estaCerrado(e[anterior])) {
          // Solo se exige si la empresa ya venia cerrando meses ese año (la
          // que empieza a usar el sistema a mitad de año arranca de cero).
          const [[previo]] = await conn.query(
            `SELECT COUNT(*) AS n FROM overtime_period_closings WHERE tenant_id = ? AND LEFT(periodo, 4) = ? AND periodo < ?`,
            [tenantId, periodo.slice(0, 4), periodo]);
          if (Number(previo.n) > 0) return { status: 409, error: `Primero cerrá ${anterior}: los meses se cierran en orden dentro del año.` };
        }
        return null;
      };
      const antes = await validarOrden(db);
      if (antes) return res.status(antes.status).json({ error: antes.error });

      const filas = await calcularEnVivo(req, tenantId, periodo);
      const ajustes = await ajustesParaMes(req, tenantId, periodo);
      aplicarAjustes(filas, ajustes);
      const [emps] = await db.query('SELECT id, employee_id FROM employees WHERE tenant_id = ?', [tenantId]);
      const idDe = new Map(emps.map((e) => [Number(e.employee_id), e.id]));

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        // Un cierre a la vez por empresa: dos administradores cerrando el
        // mismo mes al mismo tiempo no pueden dejar dos fotos.
        await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
        const ahora = await validarOrden(conn);
        if (ahora) { await conn.rollback(); return res.status(ahora.status).json({ error: ahora.error }); }
        const [c] = await conn.query(
          `INSERT INTO overtime_period_closings (tenant_id, periodo, accion, created_by) VALUES (?, ?, 'CERRAR', ?)`,
          [tenantId, periodo, autor(req)]);
        // Solo la parte propia del mes (quien solo tiene ajuste no va a la foto).
        const valores = filas.filter((f) => idDe.has(f.legajo) && tieneAlgo(f)).map((f) => [
          c.insertId, tenantId, periodo, idDe.get(f.legajo), f.legajo, f.nombre, f.convenio, f.regimen, f.conRegimen ? 1 : 0,
          f.reales, f.computables, f.manuales, f.aLiquidar, f.excedente, f.pendiente, f.registradas, f.noComputadas, JSON.stringify(f.porRecargo),
        ]);
        if (valores.length) {
          await conn.query(
            `INSERT INTO overtime_period_results
               (closing_id, tenant_id, periodo, employee_id, legajo, nombre, convenio, regimen, con_regimen,
                reales, computables, manuales, a_liquidar, excedente, pendiente, registradas, no_computadas, por_recargo)
             VALUES ?`, [valores]);
        }
        const valoresAjuste = ajustes.filter((a) => idDe.has(a.legajo)).map((a) => [
          c.insertId, tenantId, periodo, a.periodoOrigen, idDe.get(a.legajo), a.legajo, a.nombre, a.minutos, a.computables, JSON.stringify(a.porRecargo),
        ]);
        if (valoresAjuste.length) {
          await conn.query(
            `INSERT INTO overtime_period_adjustments
               (closing_id, tenant_id, periodo, periodo_origen, employee_id, legajo, nombre, minutos, computables, por_recargo)
             VALUES ?`, [valoresAjuste]);
        }
        await conn.commit();
        res.status(201).json({ ok: true, id: c.insertId, personas: valores.length, ajustes: valoresAjuste.length, totales: totales(filas) });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Falta correr la migración 20261008 (cierre de mes).' });
      console.error('ERROR liquidacion cerrar:', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Error cerrando el mes' });
    }
  });

  router.post('/cierres/reabrir', requirePermission('attendance', 'update'), async (req, res) => {
    const tenantId = tenantONada(req, res); if (tenantId == null) return;
    const b = req.body || {};
    const periodo = String(b.periodo || '');
    const motivo = String(b.motivo || '').trim();
    if (!PERIODO.test(periodo)) return res.status(400).json({ error: 'periodo (AAAA-MM) es requerido' });
    if (!motivo) return res.status(400).json({ error: 'El motivo es obligatorio: queda en el historial del cierre.' });
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
      const e = await estados(tenantId, [periodo], conn);
      if (!estaCerrado(e[periodo])) { await conn.rollback(); return res.status(409).json({ error: 'Ese mes no está cerrado.' }); }
      const posteriores = await cerradosPosteriores(tenantId, periodo, conn);
      if (posteriores.length) {
        await conn.rollback();
        return res.status(409).json({ error: `Primero reabrí ${posteriores[posteriores.length - 1]}: su tope anual depende de este mes.` });
      }
      // Si en otro mes cerrado ya se pago un ajuste de este, reabrirlo
      // dejaria ese pago sin su origen (y al recerrar se pagaria dos veces).
      const pagados = await ajustesPagadosDe(tenantId, periodo, conn);
      if (pagados.length) {
        await conn.rollback();
        return res.status(409).json({ error: `Primero reabrí ${pagados[0].periodo}: ahí se pagó un ajuste de este mes.` });
      }
      const [r] = await conn.query(
        `INSERT INTO overtime_period_closings (tenant_id, periodo, accion, motivo, created_by) VALUES (?, ?, 'REABRIR', ?, ?)`,
        [tenantId, periodo, motivo.slice(0, 255), autor(req)]);
      await conn.commit();
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      await conn.rollback();
      console.error('ERROR liquidacion reabrir:', err);
      res.status(500).json({ error: 'Error reabriendo el mes' });
    } finally {
      conn.release();
    }
  });

  return router;
};

module.exports.filaDeLiquidacion = filaDeLiquidacion;
module.exports.mesAnterior = mesAnterior;
module.exports.mesesAntes = mesesAntes;
module.exports.ultimoDia = ultimoDia;
