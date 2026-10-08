// Guía de puesta en marcha (página de Inicio): cuánto le falta a la empresa
// para tener el sistema andando, calculado con SUS datos. Solo lee, salvo
// los tildes manuales (pasos que no se pueden detectar solos, como "revisé
// los feriados"), que se guardan en app_settings de la empresa.
//
// Cada conteo va por separado y tolerante: si una tabla todavía no existe
// (migración pendiente) o una consulta falla, ese paso vuelve sin dato
// (null) y el resto de la guía sigue funcionando.
const express = require('express');
const { requirePermission, resolveTenantId } = require('../appUserMiddleware');
const { setAppSetting } = require('../motor-laboral/repositories/appSettingsRepository');
const { buscarQuienFichaSinFigurar } = require('./matching.routes');

// Pasos que se marcan a mano. Lista cerrada: no se guarda cualquier cosa.
const PASOS_MANUALES = ['feriados', 'motivos', 'marcadores', 'convenios'];
const SETTING = 'puestaEnMarchaManual';
const DIAS_FICHAJES_RECIENTES = 30;

async function seguro(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(err.code)) console.error('Puesta en marcha:', err.message);
    return null;
  }
}

async function leerManuales(db, tenantId) {
  // Directo por tenant_id: getAppSetting cae al valor global, y una marca
  // de otra empresa (o global) no puede contar como hecha para esta.
  const [rows] = await db.query('SELECT value FROM app_settings WHERE name = ? AND tenant_id = ? LIMIT 1', [SETTING, tenantId]);
  try {
    const v = rows[0] ? JSON.parse(rows[0].value) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Personas que ficharon en los últimos días y cuyos fichajes no llegan a
// ningún informe (sin vincular, dadas de baja, ocultas, o un número que no
// es de nadie). Es EL MISMO cálculo que el aviso de la pantalla Matching
// (routes/matching.routes.js): Inicio y Matching tienen que decir siempre
// el mismo número.
async function sinVincular(tenantId) {
  const r = await buscarQuienFichaSinFigurar(tenantId, DIAS_FICHAJES_RECIENTES);
  return { pendientes: r.count };
}

async function calcular(db, tenantId) {
  const uno = async (sql, params) => (await db.query(sql, params))[0][0];
  const manual = (await seguro(() => leerManuales(db, tenantId))) || {};
  const anio = new Date().getFullYear();

  const [relojes, hayFichajes, empleados, vincular, feriados, motivos, plantillas, sinHorario, marcadores, convenios, usuarios] = await Promise.all([
    seguro(() => uno('SELECT COUNT(*) AS n, MAX(last_synced_at) AS ultima FROM agent_sync_status WHERE tenant_id = ?', [tenantId])),
    seguro(async () => !!(await uno('SELECT 1 AS si FROM Checkins WHERE tenant_id = ? LIMIT 1', [tenantId]))),
    seguro(() => uno('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND COALESCE(activo, 1) = 1', [tenantId])),
    seguro(() => sinVincular(tenantId)),
    seguro(() => uno('SELECT COUNT(*) AS n FROM holidays WHERE (tenant_id = ? OR tenant_id IS NULL) AND YEAR(date) = ?', [tenantId, anio])),
    seguro(() => uno('SELECT COUNT(*) AS n FROM event_types WHERE (tenant_id = ? OR tenant_id IS NULL) AND COALESCE(active, 1) = 1', [tenantId])),
    seguro(() => uno('SELECT COUNT(*) AS n, MAX(COALESCE(is_default, 0)) AS porDefecto FROM work_schedule_templates WHERE tenant_id = ? AND COALESCE(active, 1) = 1', [tenantId])),
    seguro(() => uno(
      `SELECT COUNT(*) AS n FROM employees e
        WHERE e.tenant_id = ? AND COALESCE(e.activo, 1) = 1 AND COALESCE(e.exclude_from_report, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM employee_work_calendars c
                           WHERE c.employee_id = e.id AND c.valid_from <= CURDATE()
                             AND (c.valid_to IS NULL OR c.valid_to >= CURDATE()))`, [tenantId])),
    seguro(() => uno('SELECT COUNT(*) AS n FROM specialusers WHERE tenant_id = ? AND COALESCE(isActive, 1) = 1', [tenantId])),
    seguro(() => uno('SELECT COUNT(*) AS n FROM employee_convention_assignments WHERE tenant_id = ?', [tenantId])),
    seguro(() => uno('SELECT COUNT(*) AS n FROM app_users WHERE tenant_id = ? AND is_active = 1 AND employee_id IS NULL', [tenantId])),
  ]);

  const n = (r) => (r == null ? null : Number(r.n));
  const nEmpleados = n(empleados);
  const nPlantillas = n(plantillas);
  const nSinHorario = n(sinHorario);
  const hayPorDefecto = !!(plantillas && Number(plantillas.porDefecto));
  return {
    empresa: true,
    pasos: {
      relojes: {
        hecho: !!(relojes && Number(relojes.n) > 0) || hayFichajes === true,
        relojes: relojes ? Number(relojes.n) : null,
        ultimaSincronizacion: relojes ? relojes.ultima : null,
        hayFichajes,
      },
      empleados: { hecho: nEmpleados > 0, activos: nEmpleados },
      vincular: {
        hecho: hayFichajes === true && nEmpleados > 0 && vincular != null && vincular.pendientes === 0,
        pendientes: vincular ? vincular.pendientes : null,
        dias: DIAS_FICHAJES_RECIENTES,
      },
      feriados: { hecho: !!manual.feriados, cantidad: n(feriados), anio, manual: true },
      motivos: { hecho: !!manual.motivos, cantidad: n(motivos), manual: true },
      plantillas: { hecho: nPlantillas > 0, cantidad: nPlantillas },
      horarios: {
        hecho: nEmpleados > 0 && nPlantillas > 0 && (nSinHorario === 0 || hayPorDefecto),
        sinHorario: nSinHorario,
        hayPorDefecto,
      },
      marcadores: { hecho: n(marcadores) > 0 || !!manual.marcadores, cantidad: n(marcadores), manual: true, opcional: true },
      convenios: { hecho: n(convenios) > 0 || !!manual.convenios, asignaciones: n(convenios), manual: true, opcional: true },
      usuarios: { hecho: n(usuarios) > 1, cantidad: n(usuarios), opcional: true },
    },
  };
}

module.exports = function (db) {
  const router = express.Router();

  // Cualquiera que haya iniciado sesión en el panel (las cuentas de
  // empleado no llegan acá: appUserMiddleware las deja solo en el portal).
  router.get('/', async (req, res) => {
    const tenantId = resolveTenantId(req);
    // Superadmin sin elegir empresa: no hay "su" empresa que medir.
    if (tenantId == null) return res.json({ empresa: false, pasos: null });
    try {
      res.json(await calcular(db, tenantId));
    } catch (err) {
      console.error('Puesta en marcha:', err);
      res.status(500).json({ error: 'No se pudo calcular el avance de la puesta en marcha.' });
    }
  });

  // Tilde manual de un paso ("ya revisé los feriados", "no uso marcadores").
  router.put('/manual', requirePermission('settings', 'update'), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (tenantId == null) return res.status(400).json({ error: 'Elegí la empresa.' });
    const { paso, hecho } = req.body || {};
    if (!PASOS_MANUALES.includes(paso)) return res.status(400).json({ error: 'Paso desconocido.' });
    try {
      const actual = await leerManuales(db, tenantId);
      if (hecho) actual[paso] = true;
      else delete actual[paso];
      await setAppSetting(SETTING, tenantId, JSON.stringify(actual), db);
      res.json({ ok: true, manual: actual });
    } catch (err) {
      console.error('Puesta en marcha (manual):', err);
      res.status(500).json({ error: 'No se pudo guardar.' });
    }
  });

  return router;
};

module.exports.calcular = calcular;
module.exports.PASOS_MANUALES = PASOS_MANUALES;
