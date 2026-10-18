// ============================================================================
// Pantalla "Horas extra": cómo se cuentan, por empresa y por plantilla
// (2026-10-17). Ver motor-laboral/services/configHorasExtra.js y
// DISENO_HORAS_EXTRA_CENTRALIZADO.md.
// ============================================================================
//
// Todo lo que decide "qué es hora extra" en un solo lugar, a cargo del
// administrador de cada empresa (no del superadmin). Lo que ya existía en otro
// lado (autorización, mínimo de la empresa, corte y tope de cada plantilla,
// marcadores) se lee de donde está para mostrarlo junto: no se duplica.
const express = require('express');
const { requirePermission, requireAnyPermission, resolveTenantId } = require('../appUserMiddleware');
const { getAppSetting } = require('../motor-laboral/repositories/appSettingsRepository');
const configHE = require('../motor-laboral/services/configHorasExtra');
const minimoHorasExtra = require('../motor-laboral/services/minimoHorasExtra');
const { compararDias, resumen } = require('../motor-laboral/services/compararHorasExtra');

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ELEGIR = 'Elegí la empresa: cada empresa tiene su propia configuración.';

module.exports = function configHorasExtraRoutes(db, { calcularAsistencia }) {
  const router = express.Router();

  router.get('/', requireAnyPermission([['schedules', 'read'], ['attendance', 'read']]), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: ELEGIR });
    try {
      const [empresa, excepciones, autorizacion, minimoEmpresa] = await Promise.all([
        configHE.leerEmpresa(db, tenantId),
        configHE.leerPlantillas(db, tenantId),
        getAppSetting('overtimeAuthorizationMode', tenantId, db),
        minimoHorasExtra.leer(db, tenantId),
      ]);
      let plantillas = [];
      try {
        const [rows] = await db.query(
          `SELECT id, name, active, overtime_cutoff_time, overtime_cap_minutes, archived_at
             FROM work_schedule_templates WHERE tenant_id = ? ORDER BY name`, [tenantId]);
        plantillas = rows;
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        const [rows] = await db.query(
          `SELECT id, name, active, overtime_cutoff_time, overtime_cap_minutes FROM work_schedule_templates WHERE tenant_id = ? ORDER BY name`, [tenantId]);
        plantillas = rows;
      }
      const [[marc]] = await db.query(
        `SELECT COUNT(*) n FROM specialusers WHERE tenant_id = ? AND category = 'HE' AND isActive = TRUE AND direction IS NOT NULL`, [tenantId]);
      res.json({
        empresa,
        autorizacion: autorizacion === 'custom' ? 'custom' : 'all',
        minimoEmpresa,
        marcadoresHE: Number(marc.n) || 0,
        tablaExcepciones: excepciones.tablaExiste,
        plantillas: plantillas.map((p) => ({
          id: p.id,
          nombre: p.name,
          activa: !!Number(p.active) && !p.archived_at,
          corte: p.overtime_cutoff_time ? String(p.overtime_cutoff_time).slice(0, 5) : null,
          tope: p.overtime_cap_minutes ?? null,
          excepcion: excepciones.mapa.get(Number(p.id)) || null,
        })),
      });
    } catch (err) {
      console.error('ERROR leyendo config de horas extra:', err);
      res.status(500).json({ error: 'Error leyendo la configuración de horas extra' });
    }
  });

  // Lo de toda la empresa: método, llegar antes y quién puede hacer horas extra.
  router.post('/empresa', requirePermission('schedules', 'update'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: ELEGIR });
    const { metodo, contarLlegadaAnticipada, autorizacion } = req.body || {};
    if (!configHE.metodoValido(metodo)) return res.status(400).json({ error: `metodo debe ser uno de: ${configHE.METODOS.join(', ')}` });
    if (autorizacion !== undefined && autorizacion !== 'all' && autorizacion !== 'custom') {
      return res.status(400).json({ error: "autorizacion debe ser 'all' o 'custom'" });
    }
    try {
      await configHE.guardarEmpresa(db, tenantId, { metodo, contarLlegadaAnticipada: !!contarLlegadaAnticipada });
      if (autorizacion !== undefined) {
        const { setAppSetting } = require('../motor-laboral/repositories/appSettingsRepository');
        await setAppSetting('overtimeAuthorizationMode', tenantId, autorizacion, db);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('ERROR guardando config de horas extra:', err);
      res.status(500).json({ error: 'Error guardando la configuración de horas extra' });
    }
  });

  // Excepción de una plantilla (todo vacío = se quita la excepción).
  router.put('/plantillas/:id', requirePermission('schedules', 'update'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: ELEGIR });
    const templateId = Number(req.params.id);
    const { metodo, contarLlegadaAnticipada, minimo } = req.body || {};
    if (metodo && !configHE.metodoValido(metodo)) return res.status(400).json({ error: `metodo debe ser uno de: ${configHE.METODOS.join(', ')}` });
    if (configHE.minimoValido(minimo) === undefined) return res.status(400).json({ error: `El mínimo tiene que ser un número entero de minutos entre 1 y ${configHE.MAXIMO_MINIMO} (o vacío).` });
    try {
      const [[pl]] = await db.query('SELECT id FROM work_schedule_templates WHERE id = ? AND tenant_id = ?', [templateId, tenantId]);
      if (!pl) return res.status(404).json({ error: 'Plantilla no encontrada' });
      const excepcion = await configHE.guardarPlantilla(db, tenantId, templateId, { metodo, contarLlegadaAnticipada, minimo },
        req.appUser ? req.appUser.email : null);
      res.json({ ok: true, excepcion });
    } catch (err) {
      if (configHE.faltaTabla(err)) {
        return res.status(503).json({ error: 'Falta correr la migración 20261023_horas_extra_por_plantilla.sql para poder guardar excepciones por plantilla.' });
      }
      console.error('ERROR guardando excepcion de plantilla HE:', err);
      res.status(500).json({ error: 'Error guardando la excepción de la plantilla' });
    }
  });

  // "Ver qué cambiaría": el mismo cálculo de Presentismo con la otra
  // configuración, comparado día por día. No guarda nada.
  router.get('/impacto', requirePermission('attendance', 'read'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: ELEGIR });
    const { metodo, llegada, minimo, plantillaId, from, to } = req.query;
    if (!configHE.metodoValido(metodo) || !FECHA.test(String(from || '')) || !FECHA.test(String(to || ''))) {
      return res.status(400).json({ error: 'metodo, from y to son requeridos' });
    }
    try {
      // El cálculo completo dos veces (como está y con lo nuevo), comparado
      // día por día: exactamente lo que pasaría al guardar (compararHorasExtra.js).
      const [hoy, con] = await Promise.all([
        calcularAsistencia(req, from, to, tenantId, { heDias: '1' }),
        calcularAsistencia(req, from, to, tenantId, {
          heDias: '1',
          simularMetodoHE: metodo,
          simularLlegadaHE: llegada === '1' ? '1' : '',
          ...(minimo ? { simularMinimoHE: String(minimo) } : {}),
          ...(plantillaId ? { simularPlantillaHE: String(plantillaId) } : {}),
        }),
      ]);
      const filas = compararDias(hoy.heDias || [], con.heDias || []);
      // Las 10 personas con más diferencia (en `ejemplos`), para poder mirar casos reales.
      res.json({ from, to, ...resumen(filas) });
    } catch (err) {
      console.error('ERROR impacto config HE:', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Error calculando el impacto' });
    }
  });

  return router;
};
