// ============================================================================
// "Días a revisar" de horas extra (etapa 2, 2026-10-16)
// ============================================================================
//
// POR QUE
// -------
// Las horas extra ESTIMADAS (sin marcador de inicio) se cuentan solas y solo
// se notaban si alguien abría el detalle de esa persona en ese día: "la
// anomalía no me entero a menos que me reclamen" (el dueño). Medido en
// septiembre de AVP (AUDITORIA_FICHAJES_REPETIDOS.md, anexo 2): una lista
// cruda serían 853 días por mes, inmanejable. Por eso esta lista trae SOLO:
//
//   C. "Regreso contado como horas extra": el último fichaje del día es un
//      regreso oficial, particular o de campaña, y el estimado lo tomó como
//      fin de horas extra (ej. 1496 el 30/09: salió de comisión a las 08:42,
//      volvió a las 18:01 y se le contaron 3 h). Pocos casos, muchas horas.
//   D. "Horas extra estimadas": no marcó el inicio y se tomaron desde el
//      corte, con más de UMBRAL minutos. Las de pocos minutos son casi
//      siempre "se fue un rato después del corte" (lo resolverá el mínimo de
//      horas extra, R4), y llenarían la lista.
//
// No cambia ningún número: solo muestra. Un día queda "revisado" si:
//   - se marcó "Está bien" (tabla horas_extra_revisiones, migración 20261022)
//     y sus horas extra no cambiaron desde entonces;
//   - se omitió ("No corresponde", ManualEntries 'omit');
//   - tiene una carga de horas extra manual (se corrigió a mano).
// Todo queda registrado con quién y cuándo (la revisión en su tabla, el
// resto en ManualEntries y su auditoría, y todo en el registro de actividad).
//
// La información sale del MISMO cálculo que Presentismo (calcularAsistencia)
// y de los MISMOS tipos de fichaje que muestra Presentismo
// (calcularFichajesDelDia): no hay una segunda fórmula.
const express = require('express');
const { requirePermission, resolveTenantId, requireHorasExtra } = require('../appUserMiddleware');

const UMBRAL_MINUTOS_ESTIMADAS = 30;
const MAX_DIAS = 62;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const NOMBRE_REGRESO = { OFICIAL: 'regreso oficial', PARTICULAR: 'regreso de salida particular', CAMPANA: 'regreso de campaña' };
const horas = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

/**
 * Clasifica un día con horas extra estimadas. Pura (test/horas-extra-revisar.test.js).
 * @param {{minutos:number, aRevisar:boolean, desde:string|null, hasta:string|null}} dia
 * @param {{hora:string, base:string, tipos:{categoria:string, rol:string}[]}[]} fichajes  los de esa persona ese día
 * @returns {{tipo:string, explicacion:string}|null}
 */
function clasificar(dia, fichajes) {
  const reales = (fichajes || []).filter((f) => f.base !== 'Repetido');
  const ultimo = reales[reales.length - 1];
  const regreso = ultimo && ultimo.tipos.find((t) => t.rol === 'regreso' && t.categoria !== 'HE');
  if (regreso) {
    return {
      tipo: 'regreso_contado',
      explicacion: `Su último fichaje (${ultimo.hora}) es un ${NOMBRE_REGRESO[regreso.categoria] || 'regreso'} y se contó como fin de horas extra (${horas(dia.minutos)}). ¿Corresponde?`,
    };
  }
  // Terminó con el marcador de fin de horas extra (10) sin haber marcado el
  // inicio: en AVP es la costumbre de 61 personas (294 días en septiembre).
  // No es una anomalía para revisar uno por uno: lo resuelve la regla "fin
  // sin inicio" (etapa 3, configurable por empresa). Fuera de esta lista.
  if (ultimo && ultimo.tipos.some((t) => t.categoria === 'HE' && t.rol === 'regreso')) return null;
  if (dia.aRevisar && dia.minutos > UMBRAL_MINUTOS_ESTIMADAS) {
    // "Lo que supera el horario" con un fichaje de menos: no se sabe qué
    // tramo es cuál, se midió hasta el último.
    if (dia.fuente === 'schedule' && dia.fueraDeHorario) {
      return {
        tipo: 'fuera_de_horario',
        explicacion: `Trabajó todo el día fuera de su horario (${dia.desde || '—'} a ${dia.hasta || '—'}) y se contó todo como horas extra (${horas(dia.minutos)}). ¿Tiene asignado el horario correcto?`,
      };
    }
    if (dia.fuente === 'schedule') {
      return {
        tipo: 'estimada',
        explicacion: `Le falta un fichaje: se contó desde ${dia.desde || 'el fin del horario'} hasta su último fichaje (${dia.hasta || '—'}, ${horas(dia.minutos)}).`,
      };
    }
    return {
      tipo: 'estimada',
      explicacion: `No marcó el inicio de horas extra: se tomaron desde ${dia.desde || 'el corte'} hasta ${dia.hasta || 'su último fichaje'} (${horas(dia.minutos)}).`,
    };
  }
  return null;
}

module.exports = function (db, { calcularAsistencia, calcularFichajesDelDia }) {
  const router = express.Router();

  router.get('/', requirePermission('attendance', 'read'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: 'Elegí una empresa' });
    const { from, to } = req.query;
    if (!FECHA.test(String(from || '')) || !FECHA.test(String(to || '')) || from > to) {
      return res.status(400).json({ error: 'from y to (AAAA-MM-DD) son requeridos' });
    }
    if ((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / 86400000 > MAX_DIAS) {
      return res.status(400).json({ error: `Elegí un período de hasta ${MAX_DIAS} días` });
    }
    try {
      const cuerpo = await calcularAsistencia(req, from, to, tenantId, { diasARevisar: '1' });
      const nombres = new Map((cuerpo.data || []).map((r) => [String(r.employeeId), r.name]));
      const candidatos = cuerpo.diasARevisar || [];
      // Los tipos de fichaje, una vez por fecha (no por persona).
      const fechas = [...new Set(candidatos.map((c) => c.fecha))];
      const fichajesPorFecha = new Map();
      for (const f of fechas) fichajesPorFecha.set(f, await calcularFichajesDelDia(tenantId, f));
      // "Está bien" ya marcados (sin la migración: ninguno).
      const revisiones = new Map();
      try {
        const [filas] = await db.query(
          `SELECT legajo, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, decision, minutos_al_revisar, revisado_por_email,
                  DATE_FORMAT(revisado_en, '%Y-%m-%d %H:%i') AS revisado_en
             FROM horas_extra_revisiones WHERE tenant_id = ? AND fecha BETWEEN ? AND ?`, [tenantId, from, to]);
        for (const f of filas) revisiones.set(`${f.legajo}|${f.fecha}`, f);
      } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
      }
      const dias = [];
      for (const c of candidatos) {
        const fich = (fichajesPorFecha.get(c.fecha) || {})[c.employeeId] || [];
        const cl = clasificar(c, fich);
        if (!cl) continue;
        const rev = revisiones.get(`${c.employeeId}|${c.fecha}`);
        // Aceptado con otros minutos (llegaron fichajes nuevos): vuelve a revisarse.
        const aceptadoVigente = rev && rev.decision === 'aceptado' && Number(rev.minutos_al_revisar) === c.minutos;
        const revision = c.omitido ? { decision: 'omitido' }
          : c.conCargaManual ? { decision: 'manual' }
          : aceptadoVigente ? { decision: 'aceptado', por: rev.revisado_por_email, en: rev.revisado_en }
          : null;
        dias.push({
          legajo: c.employeeId, nombre: nombres.get(c.employeeId) || '', fecha: c.fecha,
          minutos: c.minutos, tipo: cl.tipo, explicacion: cl.explicacion,
          fichajes: fich.filter((x) => x.base !== 'Repetido').map((x) => x.hora),
          revisado: !!revision, revision,
          cambioDesdeRevision: rev && rev.decision === 'aceptado' && !aceptadoVigente ? Number(rev.minutos_al_revisar) : null,
          userId: c.userId, omitEntryId: c.omitEntryId || null,
        });
      }
      // Lo que más horas pone en juego, primero.
      dias.sort((a, b) => Number(a.revisado) - Number(b.revisado) || b.minutos - a.minutos || a.fecha.localeCompare(b.fecha));
      const pendientes = dias.filter((d) => !d.revisado);
      res.json({
        from, to, umbralMinutos: UMBRAL_MINUTOS_ESTIMADAS,
        pendientes: pendientes.length,
        minutosPendientes: pendientes.reduce((a, d) => a + d.minutos, 0),
        dias,
      });
    } catch (err) {
      console.error('ERROR dias a revisar:', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Error armando la lista de días a revisar' });
    }
  });

  // "Está bien": deja constancia de que alguien revisó el día y las horas
  // extra estimadas son correctas. No cambia ningún número.
  // "Horas extra: Editar" (2026-10-26; antes, permisos de Presentismo). Ver permisos.js.
  router.post('/aceptar', requireHorasExtra('create'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: 'Elegí una empresa' });
    const { legajo, fecha, minutos, nota } = req.body || {};
    if (!legajo || !FECHA.test(String(fecha || '')) || !Number.isInteger(Number(minutos))) {
      return res.status(400).json({ error: 'legajo, fecha y minutos son requeridos' });
    }
    try {
      const [[emp]] = await db.query('SELECT id FROM employees WHERE tenant_id = ? AND employee_id = ?', [tenantId, legajo]);
      if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
      await db.query(
        `INSERT INTO horas_extra_revisiones (tenant_id, legajo, fecha, decision, minutos_al_revisar, nota, revisado_por, revisado_por_email)
         VALUES (?, ?, ?, 'aceptado', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE decision = 'aceptado', minutos_al_revisar = VALUES(minutos_al_revisar), nota = VALUES(nota),
           revisado_por = VALUES(revisado_por), revisado_por_email = VALUES(revisado_por_email), revisado_en = CURRENT_TIMESTAMP`,
        [tenantId, String(legajo), fecha, Number(minutos), nota ? String(nota).slice(0, 255) : null,
          req.appUser ? req.appUser.id : null, req.appUser ? req.appUser.email : null]);
      res.json({ ok: true });
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Falta correr la migración 20261022_revisiones_horas_extra.sql para poder marcar "Está bien".' });
      console.error('ERROR aceptar dia a revisar:', err);
      res.status(500).json({ error: 'No se pudo guardar la revisión' });
    }
  });

  // Deshacer un "Está bien" (el día vuelve a la lista de pendientes).
  // "Horas extra: Editar" (2026-10-26; antes, permisos de Presentismo). Ver permisos.js.
  router.delete('/aceptar', requireHorasExtra('delete'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: 'Elegí una empresa' });
    const { legajo, fecha } = req.query;
    if (!legajo || !FECHA.test(String(fecha || ''))) return res.status(400).json({ error: 'legajo y fecha son requeridos' });
    try {
      await db.query('DELETE FROM horas_extra_revisiones WHERE tenant_id = ? AND legajo = ? AND fecha = ?', [tenantId, String(legajo), fecha]);
      res.json({ ok: true });
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ ok: true });
      console.error('ERROR deshacer revision:', err);
      res.status(500).json({ error: 'No se pudo deshacer' });
    }
  });

  return router;
};

module.exports.clasificar = clasificar;
module.exports.UMBRAL_MINUTOS_ESTIMADAS = UMBRAL_MINUTOS_ESTIMADAS;
