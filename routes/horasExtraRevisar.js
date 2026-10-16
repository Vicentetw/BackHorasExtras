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
// No cambia ningún número: solo muestra. Un día ya revisado a mano (con una
// carga de horas extra manual o "Omitir") figura como revisado.
//
// La información sale del MISMO cálculo que Presentismo (calcularAsistencia)
// y de los MISMOS tipos de fichaje que muestra Presentismo
// (calcularFichajesDelDia): no hay una segunda fórmula.
const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');

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
      const dias = [];
      for (const c of candidatos) {
        const fich = (fichajesPorFecha.get(c.fecha) || {})[c.employeeId] || [];
        const cl = clasificar(c, fich);
        if (!cl) continue;
        dias.push({
          legajo: c.employeeId, nombre: nombres.get(c.employeeId) || '', fecha: c.fecha,
          minutos: c.minutos, tipo: cl.tipo, explicacion: cl.explicacion,
          fichajes: fich.filter((x) => x.base !== 'Repetido').map((x) => x.hora),
          revisado: !!(c.omitido || c.conCargaManual),
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

  return router;
};

module.exports.clasificar = clasificar;
module.exports.UMBRAL_MINUTOS_ESTIMADAS = UMBRAL_MINUTOS_ESTIMADAS;
