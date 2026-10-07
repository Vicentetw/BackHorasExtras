const express = require('express');
const { resolveTenantId, requireSuperadmin, requirePermission } = require('../../appUserMiddleware');
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');
const { darKitInicial } = require('../services/kitInicialEmpresa');
const { consultarConRegimeId } = require('../repositories/regimeIdOpcional');
const { parseList } = require('../services/countryFirewallService');
const {
  invalidateCache: invalidateFirewallCache,
  SETTING_COUNTRIES,
  SETTING_IPS
} = require('../middleware/countryFirewallMiddleware');
const { timeToMinutes } = require('../services/attendanceCalculations');
const { resolveScheduleSegments } = require('../services/scheduleResolver');
const { resolveToleranceConfig } = require('../services/toleranceResolver');
const { computeAttendanceResult } = require('../services/timeClassifier');
const { DAY_TYPES } = require('../services/dayTypeRuleResolver');
const templateConfigHistoryRepository = require('../repositories/templateConfigHistoryRepository');
const { MODULOS, modulosDe, setModulo } = require('../services/modulos');
const turnosRepository = require('../repositories/turnosRepository');
const { cruzaMedianoche } = require('../services/cicloDeTurnos');

// Mismo motivo que ya documenta /attendance-range en horasdedica.js:
// toISOString() usa UTC, y en un servidor con huso horario negativo
// (Argentina UTC-3) eso puede correr "hoy" un dia para atras cerca de la
// medianoche. Se arma la fecha por componentes locales.
function todayLocalDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
// IP exacta (v4 o v6) o CIDR v4 (ver countryFirewallService.matchesCidr) --
// validacion floja a proposito, solo para avisar de un typo obvio antes de
// guardar, no una verificacion exhaustiva de formato IP.
const IP_OR_CIDR_RE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

// Etapa 6/10 del plan "Motor de reglas de asistencia configurable" --
// mismos 4 valores que la migracion 20260921_template_tolerances.sql y
// motor-laboral/services/toleranceResolver.js (VALID_POLICIES). Se
// valida aca (capa HTTP) para devolver un 400 claro en vez de que MySQL
// rechace un valor invalido de ENUM con un error crudo.
const VALID_TOLERANCE_POLICIES = ['NO_COMPUTAR', 'TIEMPO_TRABAJADO', 'EXTRA_SI_AUTORIZADO', 'REGISTRAR_SIN_EXTRA'];
function isValidPolicyOrNull(value) {
  return value === undefined || value === null || value === '' || VALID_TOLERANCE_POLICIES.includes(value);
}

// Etapa 14 (hallazgo #5 de la auditoria): antes de esto, rules_engine_mode
// no se podia cambiar por API en absoluto (solo por SQL directo, como se
// hacia en los tests). 'legacy' es el default para toda plantilla nueva
// -- cero cambio de comportamiento salvo que se elija explicitamente.
const VALID_RULES_ENGINE_MODES = ['legacy', 'shadow', 'active'];
function isValidRulesEngineModeOrNull(value) {
  return value === undefined || value === null || value === '' || VALID_RULES_ENGINE_MODES.includes(value);
}

function createMotorLaboralAdminRoutes(db) {
  const router = express.Router();

  router.get('/tenants', requireSuperadmin, async (req, res) => {
    try {
      const { code, name } = req.query;
      if (code) {
        const [rows] = await db.query(
          `SELECT id, name, code, timezone FROM tenants WHERE code = ? LIMIT 1`,
          [code]
        );
        return res.json(rows);
      }
      if (name) {
        const [rows] = await db.query(
          `SELECT id, name, code, timezone FROM tenants WHERE name = ? LIMIT 1`,
          [name]
        );
        return res.json(rows);
      }

      const [rows] = await db.query(`SELECT * FROM tenants ORDER BY id ASC`);
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin tenants error:', err);
      res.status(500).json({ error: 'Error al leer tenants' });
    }
  });

  router.post('/tenants', requireSuperadmin, async (req, res) => {
    try {
      const rawName = req.body.name;
      const rawCode = req.body.code;
      const timezone = req.body.timezone;

      if (!rawName || !rawCode) {
        return res.status(400).json({ error: 'name y code son requeridos' });
      }

      const name = String(rawName).trim();
      const code = String(rawCode).trim();
      if (!name || !code) {
        return res.status(400).json({ error: 'name y code no pueden estar vacíos' });
      }

      const [existing] = await db.query(
        `SELECT id FROM tenants WHERE code = ? OR name = ? LIMIT 1`,
        [code, name]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Código o nombre de empresa ya existe', code, name });
      }

      const [result] = await db.query(
        `INSERT INTO tenants (name, code, timezone) VALUES (?, ?, ?)`,
        [name, code, timezone || 'America/Argentina/Buenos_Aires']
      );

      // Sus propios valores desde el primer dia (ver kitInicialEmpresa.js).
      await darKitInicial(db, result.insertId);

      res.status(201).json({ ok: true, id: result.insertId, name, code, timezone: timezone || 'America/Argentina/Buenos_Aires' });
    } catch (err) {
      console.error('Motor Laboral admin create tenant error:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Código de empresa ya existe' });
      }
      res.status(500).json({ error: 'Error al crear empresa' });
    }
  });

  router.put('/tenants/:id', requireSuperadmin, async (req, res) => {
    try {
      const { id } = req.params;
      const rawName = req.body.name;
      const rawCode = req.body.code;
      const timezone = req.body.timezone;

      if (!rawName || !rawCode) {
        return res.status(400).json({ error: 'name y code son requeridos' });
      }

      const name = String(rawName).trim();
      const code = String(rawCode).trim();
      if (!name || !code) {
        return res.status(400).json({ error: 'name y code no pueden estar vacíos' });
      }

      const [existing] = await db.query(
        `SELECT id FROM tenants WHERE (code = ? OR name = ?) AND id != ? LIMIT 1`,
        [code, name, id]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Código o nombre de empresa ya existe' });
      }

      const [result] = await db.query(
        `UPDATE tenants SET name = ?, code = ?, timezone = ? WHERE id = ?`,
        [name, code, timezone || 'America/Argentina/Buenos_Aires', id]
      );

      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update tenant error:', err);
      res.status(500).json({ error: 'Error al actualizar empresa' });
    }
  });

  // --- Modulos por empresa (motor-laboral/services/modulos.js) ---
  // Solo el superadmin los prende o apaga, segun lo que contrato cada empresa.
  router.get('/tenants/:id/modulos', requireSuperadmin, async (req, res) => {
    try {
      res.json({ modulos: await modulosDe(db, Number(req.params.id)) });
    } catch (err) {
      console.error('Motor Laboral admin modulos error:', err);
      res.status(500).json({ error: 'Error al leer los módulos' });
    }
  });

  router.put('/tenants/:id/modulos', requireSuperadmin, async (req, res) => {
    try {
      const tenantId = Number(req.params.id);
      const [[t]] = await db.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
      if (!t) return res.status(404).json({ error: 'Empresa no encontrada' });
      const pedido = req.body || {};
      const desconocido = Object.keys(pedido).find((k) => !MODULOS[k]);
      if (desconocido) return res.status(400).json({ error: `Módulo desconocido: ${desconocido}` });
      for (const [m, v] of Object.entries(pedido)) await setModulo(db, tenantId, m, !!v);
      res.json({ ok: true, modulos: await modulosDe(db, tenantId) });
    } catch (err) {
      console.error('Motor Laboral admin set modulos error:', err);
      res.status(500).json({ error: 'Error al guardar los módulos' });
    }
  });

  // --- Titular de la empresa (migracion 20261011) ---
  // Quien paga y el UNICO de la empresa que puede pedir la baja. Lo designa
  // SOLO el superadmin (no el formulario publico, que no es confiable),
  // eligiendo un usuario que ya existe en la empresa. Si todavia no existe,
  // se crea como siempre en Usuarios y Roles (una sola forma de crear
  // usuarios, no dos).

  router.get('/tenants/:id/usuarios', requireSuperadmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT u.id, u.email, u.is_active, r.name AS rol
         FROM app_users u LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.tenant_id = ? AND u.is_superadmin = 0
         ORDER BY u.email`, [req.params.id]);
      res.json({ usuarios: rows.map((u) => ({ id: u.id, email: u.email, activo: !!u.is_active, rol: u.rol })) });
    } catch (err) {
      console.error('Motor Laboral admin tenant users error:', err);
      res.status(500).json({ error: 'Error al leer los usuarios de la empresa' });
    }
  });

  router.post('/tenants/:id/titular', requireSuperadmin, async (req, res) => {
    const tenantId = Number(req.params.id);
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'El mail no parece válido' });
    try {
      const [[t]] = await db.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
      if (!t) return res.status(404).json({ error: 'Empresa no encontrada' });

      const [[u]] = await db.query('SELECT id, tenant_id, is_active, is_superadmin FROM app_users WHERE LOWER(email) = ?', [email]);
      if (!u) return res.status(404).json({ error: 'Ese mail no es un usuario del sistema: crealo primero en Usuarios y Roles.' });
      if (u.is_superadmin || u.tenant_id !== tenantId) {
        return res.status(409).json({ error: 'Ese mail es un usuario de otra empresa (o del superadmin).' });
      }
      if (!u.is_active) return res.status(409).json({ error: 'Ese usuario está desactivado: reactivalo antes de nombrarlo titular.' });
      await db.query('UPDATE tenants SET titular_email = ? WHERE id = ?', [email, tenantId]);
      res.json({ ok: true, titular: email });
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: 'Falta correr la migración 20261011 (titular de la empresa).' });
      console.error('Motor Laboral admin set titular error:', err);
      res.status(500).json({ error: 'Error al guardar el titular' });
    }
  });

  router.delete('/tenants/:id/titular', requireSuperadmin, async (req, res) => {
    try {
      await db.query('UPDATE tenants SET titular_email = NULL WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: 'Falta correr la migración 20261011 (titular de la empresa).' });
      console.error('Motor Laboral admin clear titular error:', err);
      res.status(500).json({ error: 'Error al quitar el titular' });
    }
  });

  router.delete('/tenants/:id', requireSuperadmin, async (req, res) => {
    try {
      const { id } = req.params;
      // Antes: DELETE directo, sin chequear nada -- dejaba empleados,
      // plantillas y asignaciones huerfanas apuntando a un tenant_id
      // inexistente (sin FK que lo evite en varias de esas tablas).
      const [[employeeCount]] = await db.query(`SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ?`, [id]);
      const [[templateCount]] = await db.query(`SELECT COUNT(*) AS c FROM work_schedule_templates WHERE tenant_id = ?`, [id]);
      if (employeeCount.c > 0 || templateCount.c > 0) {
        return res.status(409).json({
          error: `No se puede eliminar: tiene ${employeeCount.c} empleado(s) y ${templateCount.c} plantilla(s) asociadas. Reasignalos primero.`
        });
      }
      // El kit inicial (kitInicialEmpresa.js) es de la empresa: se va con ella.
      // vacation_scale tiene FK a tenants; sin esto el borrado fallaria.
      await db.query('DELETE FROM vacation_scale WHERE tenant_id = ?', [id]);
      await db.query('DELETE FROM payroll_regime_settings WHERE tenant_id = ?', [id]);
      const [result] = await db.query(`DELETE FROM tenants WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete tenant error:', err);
      res.status(500).json({ error: 'Error al eliminar empresa' });
    }
  });

  router.get('/templates', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      const [rows] = effectiveTenantId !== null
        ? await db.query(`SELECT * FROM work_schedule_templates WHERE tenant_id = ? ORDER BY id ASC`, [effectiveTenantId])
        : await db.query(`SELECT * FROM work_schedule_templates ORDER BY tenant_id ASC, id ASC`);
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin templates error:', err);
      res.status(500).json({ error: 'Error al leer plantillas' });
    }
  });

  router.post('/templates', requirePermission('schedules', 'create'), async (req, res) => {
    try {
      const bodyTenantId = req.body.tenant_id ?? req.body.tenantId;
      // Un usuario normal solo puede crear plantillas para su propia
      // empresa; solo el superadmin puede elegir el tenant_id a mano.
      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : bodyTenantId;
      const {
        name, description, type, active, is_default, overtime_cutoff_time, overtime_cap_minutes,
        tolerancia_entrada_minutos, tolerancia_salida_anticipada_minutos,
        politica_llegada_anticipada, politica_salida_posterior, rules_engine_mode
      } = req.body;
      if (tenantId === undefined || tenantId === null || !name || !type) {
        return res.status(400).json({ error: 'tenantId/tenant_id, name y type son requeridos' });
      }
      if (!isValidPolicyOrNull(politica_llegada_anticipada) || !isValidPolicyOrNull(politica_salida_posterior)) {
        return res.status(400).json({ error: `politica_llegada_anticipada/politica_salida_posterior deben ser uno de: ${VALID_TOLERANCE_POLICIES.join(', ')}` });
      }
      if (!isValidRulesEngineModeOrNull(rules_engine_mode)) {
        return res.status(400).json({ error: `rules_engine_mode debe ser uno de: ${VALID_RULES_ENGINE_MODES.join(', ')}` });
      }
      // If marking this template as default, unset other defaults for the tenant
      if (is_default) {
        try {
          await db.query(`UPDATE work_schedule_templates SET is_default = 0 WHERE tenant_id = ?`, [tenantId]);
        } catch (err2) {
          console.error('Error unsetting other defaults for tenant', tenantId, err2);
        }
      }
      const [result] = await db.query(
        `INSERT INTO work_schedule_templates
           (tenant_id, name, description, type, active, is_default, overtime_cutoff_time, overtime_cap_minutes,
            tolerancia_entrada_minutos, tolerancia_salida_anticipada_minutos, politica_llegada_anticipada, politica_salida_posterior,
            rules_engine_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId, name, description || null, type, active ? 1 : 0, is_default ? 1 : 0, overtime_cutoff_time || null, overtime_cap_minutes ?? null,
          tolerancia_entrada_minutos ?? null, tolerancia_salida_anticipada_minutos ?? null,
          politica_llegada_anticipada || null, politica_salida_posterior || null,
          rules_engine_mode || 'legacy'
        ]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create template error:', err);
      res.status(500).json({ error: 'Error al crear plantilla' });
    }
  });

  router.put('/templates/:id', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      // Bug real ya corregido en routes/employees.js: para un superadmin, se
      // usaba directo el tenant_id que mandaba el body sin conservar el
      // valor existente si no lo mandaba -- ahi llegaba a escribir NULL en
      // silencio. Aca la validacion de abajo lo evitaba (devolvia 400 en vez
      // de corromper el dato), pero seguia siendo el mismo defecto
      // estructural: un frontend que dejara de mandar tenant_id rompia la
      // edicion en vez de conservar el valor actual. Se trae `existing`
      // SIEMPRE (antes solo se pedia cuando el caller ya estaba acotado a un
      // tenant) para poder usarlo como fallback.
      // Etapa 14 (hallazgo #3 de la auditoria): se trae la fila COMPLETA
      // (no solo tenant_id) para poder archivar la configuracion de
      // tolerancia ANTERIOR si cambia -- ver templateConfigHistoryRepository.
      const [[existing]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [id]);
      if (!existing) {
        return res.status(404).json({ error: 'Plantilla no encontrada' });
      }
      if (effectiveTenantId !== null && existing.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Plantilla no encontrada' });
      }
      const bodyTenantId = req.body.tenant_id ?? req.body.tenantId;
      const hasExplicitBodyTenantId = bodyTenantId !== undefined && bodyTenantId !== null && bodyTenantId !== '';
      const tenantId = req.appUser && !req.appUser.isSuperadmin
        ? req.appUser.tenantId
        : (hasExplicitBodyTenantId ? bodyTenantId : existing.tenant_id);
      const {
        name, description, type, active, is_default, overtime_cutoff_time, overtime_cap_minutes,
        tolerancia_entrada_minutos, tolerancia_salida_anticipada_minutos,
        politica_llegada_anticipada, politica_salida_posterior, rules_engine_mode
      } = req.body;
      if (tenantId === undefined || tenantId === null || !name || !type) {
        return res.status(400).json({ error: 'tenantId/tenant_id, name y type son requeridos' });
      }
      if (!isValidPolicyOrNull(politica_llegada_anticipada) || !isValidPolicyOrNull(politica_salida_posterior)) {
        return res.status(400).json({ error: `politica_llegada_anticipada/politica_salida_posterior deben ser uno de: ${VALID_TOLERANCE_POLICIES.join(', ')}` });
      }
      if (!isValidRulesEngineModeOrNull(rules_engine_mode)) {
        return res.status(400).json({ error: `rules_engine_mode debe ser uno de: ${VALID_RULES_ENGINE_MODES.join(', ')}` });
      }
      // rules_engine_mode es NOT NULL en la base (a diferencia de las
      // columnas de tolerancia) -- si no viene en el body, se preserva el
      // valor QUE YA TENIA la plantilla, nunca se resetea a 'legacy' en
      // silencio (mismo bug real que ya paso una vez con overtime_cutoff_time:
      // "la pongo y no se guarda" / aca seria peor, "la edito y se desactiva sola").
      const effectiveRulesEngineMode = rules_engine_mode || existing.rules_engine_mode;
      // If marking this template as default, unset other defaults for the tenant
      if (is_default) {
        try {
          await db.query(`UPDATE work_schedule_templates SET is_default = 0 WHERE tenant_id = ?`, [tenantId]);
        } catch (err2) {
          console.error('Error unsetting other defaults for tenant', tenantId, err2);
        }
      }
      // Etapa 14 (hallazgo #3 de la auditoria): si alguna de las 4
      // columnas de tolerancia cambia, archivar el estado ANTERIOR antes
      // de pisarlo -- sin esto, recalcular una fecha pasada usaria la
      // config NUEVA en vez de la que regia en su momento. No afecta a
      // ninguna plantilla que nunca cambia su configuracion (el caso de
      // todas hasta hoy).
      await templateConfigHistoryRepository.archiveCurrentConfigIfChanged(
        existing,
        {
          tolerancia_entrada_minutos: tolerancia_entrada_minutos ?? null,
          tolerancia_salida_anticipada_minutos: tolerancia_salida_anticipada_minutos ?? null,
          politica_llegada_anticipada: politica_llegada_anticipada || null,
          politica_salida_posterior: politica_salida_posterior || null
        },
        todayLocalDate(),
        db
      );

      // Bug real (reportado en vivo): el frontend ya mandaba
      // overtime_cutoff_time/overtime_cap_minutes en el body (corte y tope
      // de HE por plantilla), pero este UPDATE nunca los destructuraba ni
      // los incluia en el SET -- se guardaban en silencio, sin error, como
      // si nada. "La pongo y no se guarda". Ojo con el mismo bug para las
      // 4 columnas nuevas de tolerancia (Etapa 6/10) -- SI se incluyen.
      const [result] = await db.query(
        `UPDATE work_schedule_templates
         SET tenant_id = ?, name = ?, description = ?, type = ?, active = ?, is_default = ?,
             overtime_cutoff_time = ?, overtime_cap_minutes = ?,
             tolerancia_entrada_minutos = ?, tolerancia_salida_anticipada_minutos = ?,
             politica_llegada_anticipada = ?, politica_salida_posterior = ?,
             rules_engine_mode = ?
         WHERE id = ?`,
        [
          tenantId, name, description || null, type, active ? 1 : 0, is_default ? 1 : 0, overtime_cutoff_time || null, overtime_cap_minutes ?? null,
          tolerancia_entrada_minutos ?? null, tolerancia_salida_anticipada_minutos ?? null,
          politica_llegada_anticipada || null, politica_salida_posterior || null,
          effectiveRulesEngineMode,
          id
        ]
      );
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update template error:', err);
      res.status(500).json({ error: 'Error al actualizar plantilla' });
    }
  });

  router.delete('/templates/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[existing]] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [id]);
        if (!existing || existing.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Plantilla no encontrada' });
        }
      }
      // Antes borraba solo la plantilla y dejaba shift_blocks huerfanos con
      // un template_id que ya no existe -- pese a que el dialogo de
      // confirmacion del cliente decia "se eliminaran tambien los bloques".
      // Ahora sí borra los bloques primero, de verdad.
      await db.query(`DELETE FROM shift_blocks WHERE template_id = ?`, [id]);
      const [result] = await db.query(`DELETE FROM work_schedule_templates WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete template error:', err);
      res.status(500).json({ error: 'Error al eliminar plantilla' });
    }
  });

  // AISLAMIENTO (auditoria 2026-10-07, hallazgo A): los bloques no tienen
  // empresa propia, son de una plantilla. Antes estas 4 rutas no miraban de
  // quien era la plantilla, y un admin de cualquier empresa podia leer,
  // crear, cambiar o borrar los horarios de otra probando numeros
  // (comprobado en vivo). Ahora: plantilla de otra empresa = 404, igual que
  // si no existiera. El superadmin (sin empresa elegida) sigue viendo todo.
  async function plantillaPropia(req, templateId) {
    const effectiveTenantId = resolveTenantId(req);
    const [[t]] = await db.query('SELECT id, tenant_id FROM work_schedule_templates WHERE id = ?', [templateId]);
    if (!t) return null;
    if (effectiveTenantId !== null && t.tenant_id !== effectiveTenantId) return null;
    return t;
  }
  async function bloquePropio(req, blockId) {
    const [[b]] = await db.query('SELECT id, template_id FROM shift_blocks WHERE id = ?', [blockId]);
    if (!b) return null;
    return (await plantillaPropia(req, b.template_id)) ? b : null;
  }

  router.get('/templates/:id/blocks', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!(await plantillaPropia(req, id))) return res.status(404).json({ error: 'Plantilla no encontrada' });
      // Bug real reportado: "modifico un horario y no guarda los cambios" --
      // este endpoint devolvia las columnas crudas de la tabla
      // (block_name, block_type), pero el frontend (ShiftBlock en
      // motor-laboral.ts, igual que WorkScheduleTemplate) siempre esperó
      // "name"/"type" -- ni siquiera la LECTURA coincidia (la columna
      // "Nombre"/"Tipo" de la tabla de bloques quedaba vacia en pantalla),
      // y el guardado (POST/PUT, mas abajo) esperaba ademas un tercer
      // vocabulario distinto (dayOfWeek/startTime/blockType camelCase) que
      // el Angular nunca mando -- de ahi el 400 "dayOfWeek, startTime,
      // endTime y blockType son requeridos" con cualquier edicion real.
      const [rows] = await db.query(
        `SELECT id, template_id, day_of_week, block_name AS name, start_time, end_time,
                block_type AS type, crosses_midnight, active, created_at, updated_at
         FROM shift_blocks WHERE template_id = ? ORDER BY day_of_week ASC, start_time ASC`,
        [id]
      );
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin blocks error:', err);
      res.status(500).json({ error: 'Error al leer bloques' });
    }
  });

  router.post('/templates/:id/blocks', requirePermission('schedules', 'create'), async (req, res) => {
    try {
      const { id } = req.params;
      const {
        day_of_week,
        name,
        start_time,
        end_time,
        type,
        crosses_midnight,
        active
      } = req.body;

      if (day_of_week === undefined || !start_time || !end_time || !type) {
        return res.status(400).json({ error: 'day_of_week, start_time, end_time y type son requeridos' });
      }
      if (!(await plantillaPropia(req, id))) return res.status(404).json({ error: 'Plantilla no encontrada' });

      const [result] = await db.query(
        `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, day_of_week, name || null, start_time, end_time, type, crosses_midnight ? 1 : 0, active ? 1 : 0]
      );
      res.json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create block error:', err);
      res.status(500).json({ error: 'Error al crear bloque' });
    }
  });

  router.put('/blocks/:id', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const {
        day_of_week,
        name,
        start_time,
        end_time,
        type,
        crosses_midnight,
        active
      } = req.body;

      if (day_of_week === undefined || !start_time || !end_time || !type) {
        return res.status(400).json({ error: 'day_of_week, start_time, end_time y type son requeridos' });
      }
      if (!(await bloquePropio(req, id))) return res.status(404).json({ error: 'Bloque no encontrado' });

      const [result] = await db.query(
        `UPDATE shift_blocks SET day_of_week = ?, block_name = ?, start_time = ?, end_time = ?, block_type = ?, crosses_midnight = ?, active = ? WHERE id = ?`,
        [day_of_week, name || null, start_time, end_time, type, crosses_midnight ? 1 : 0, active ? 1 : 0, id]
      );
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin update block error:', err);
      res.status(500).json({ error: 'Error al actualizar bloque' });
    }
  });

  router.delete('/blocks/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!(await bloquePropio(req, id))) return res.status(404).json({ error: 'Bloque no encontrado' });
      const [result] = await db.query(`DELETE FROM shift_blocks WHERE id = ?`, [id]);
      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin delete block error:', err);
      res.status(500).json({ error: 'Error al eliminar bloque' });
    }
  });

  // ============ TURNOS Y PLANTILLAS ROTATIVAS (DISENO_HORARIOS_ROTATIVOS.md) ============
  //
  // Turno = horario con nombre, reutilizable, de UNA empresa: "Mañana 07-15",
  // "Noche 23-07", "Comercio 07-12 y 16-20" (varios tramos = turno partido).
  // Plantilla rotativa = ciclo de N dias; cada dia, un turno o "sin turno".
  // Todo aislado por empresa: un turno o una plantilla de otra empresa
  // responde como si no existiera (404).

  const FALTA_MIGRACION = 'Falta correr la migración 20261015 (horarios rotativos).';
  const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const responderSinMigracion = (res, err) => {
    if (turnosRepository.SIN_TABLA.has(err.code)) { res.status(503).json({ error: FALTA_MIGRACION }); return true; }
    return false;
  };
  // La empresa sobre la que se trabaja: la propia, o la que eligio el superadmin.
  const empresaONada = (req, res) => {
    const t = resolveTenantId(req) ?? (req.body && (req.body.tenant_id ?? req.body.tenantId) != null ? Number(req.body.tenant_id ?? req.body.tenantId) : null);
    if (t == null) { res.status(400).json({ error: 'Elegí una empresa' }); return null; }
    return t;
  };

  // Valida { nombre, color, tramos:[{inicio,fin}] }. Devuelve un mensaje de error o null.
  function validarTurno(body) {
    const nombre = String(body.nombre || '').trim();
    if (!nombre || nombre.length > 60) return 'El nombre es obligatorio (hasta 60 letras)';
    const tramos = Array.isArray(body.tramos) ? body.tramos : [];
    if (tramos.length < 1 || tramos.length > 4) return 'Un turno tiene entre 1 y 4 tramos';
    for (const t of tramos) {
      if (!HORA_RE.test(String(t.inicio || '')) || !HORA_RE.test(String(t.fin || ''))) return 'Cada tramo necesita hora de inicio y de fin (HH:MM)';
      if (t.inicio === t.fin) return 'Un tramo no puede empezar y terminar a la misma hora';
    }
    // Tramos en orden y sin superponerse (los que cruzan medianoche, al final).
    for (let i = 1; i < tramos.length; i++) {
      const ant = tramos[i - 1];
      if (cruzaMedianoche(ant.inicio, ant.fin)) return 'Solo el último tramo puede terminar al día siguiente';
      if (tramos[i].inicio < ant.fin) return 'Los tramos tienen que ir en orden y sin superponerse';
    }
    if (body.color != null && body.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(String(body.color))) return 'Color inválido';
    return null;
  }

  async function guardarTramos(conn, shiftId, tramos) {
    await conn.query('DELETE FROM shift_definition_tramos WHERE shift_id = ?', [shiftId]);
    let orden = 1;
    for (const t of tramos) {
      await conn.query(
        'INSERT INTO shift_definition_tramos (shift_id, orden, inicio, fin, cruza_medianoche) VALUES (?, ?, ?, ?, ?)',
        [shiftId, orden++, t.inicio, t.fin, cruzaMedianoche(t.inicio, t.fin) ? 1 : 0]);
    }
  }

  async function turnoPropio(tenantId, id) {
    const [[t]] = await db.query('SELECT id, tenant_id FROM shift_definitions WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return t || null;
  }

  router.get('/turnos', requirePermission('schedules', 'read'), async (req, res) => {
    const tenantId = empresaONada(req, res); if (tenantId == null) return;
    try {
      res.json(await turnosRepository.listarTurnos(db, tenantId));
    } catch (err) {
      if (responderSinMigracion(res, err)) return;
      console.error('ERROR listando turnos:', err);
      res.status(500).json({ error: 'Error al leer los turnos' });
    }
  });

  router.post('/turnos', requirePermission('schedules', 'create'), async (req, res) => {
    const tenantId = empresaONada(req, res); if (tenantId == null) return;
    const error = validarTurno(req.body || {});
    if (error) return res.status(400).json({ error });
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query('INSERT INTO shift_definitions (tenant_id, nombre, color, created_by) VALUES (?, ?, ?, ?)',
        [tenantId, String(req.body.nombre).trim(), req.body.color || null, req.appUser ? req.appUser.id : null]);
      await guardarTramos(conn, r.insertId, req.body.tramos);
      await conn.commit();
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (responderSinMigracion(res, err)) return;
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay un turno con ese nombre' });
      console.error('ERROR creando turno:', err);
      res.status(500).json({ error: 'Error al crear el turno' });
    } finally {
      conn.release();
    }
  });

  router.put('/turnos/:id', requirePermission('schedules', 'update'), async (req, res) => {
    const tenantId = empresaONada(req, res); if (tenantId == null) return;
    const error = validarTurno(req.body || {});
    if (error) return res.status(400).json({ error });
    const conn = await db.getConnection();
    try {
      if (!(await turnoPropio(tenantId, req.params.id))) return res.status(404).json({ error: 'Turno no encontrado' });
      await conn.beginTransaction();
      await conn.query('UPDATE shift_definitions SET nombre = ?, color = ?, activo = ? WHERE id = ?',
        [String(req.body.nombre).trim(), req.body.color || null, req.body.activo === false ? 0 : 1, req.params.id]);
      await guardarTramos(conn, Number(req.params.id), req.body.tramos);
      await conn.commit();
      res.json({ ok: true });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (responderSinMigracion(res, err)) return;
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay un turno con ese nombre' });
      console.error('ERROR editando turno:', err);
      res.status(500).json({ error: 'Error al editar el turno' });
    } finally {
      conn.release();
    }
  });

  router.delete('/turnos/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    const tenantId = empresaONada(req, res); if (tenantId == null) return;
    try {
      if (!(await turnoPropio(tenantId, req.params.id))) return res.status(404).json({ error: 'Turno no encontrado' });
      // Borrarlo cambiaria en silencio el horario de quien tenga una
      // rotativa que lo usa: primero hay que sacarlo de esos ciclos.
      const [usos] = await db.query(
        `SELECT DISTINCT w.name FROM template_cycle_days d JOIN work_schedule_templates w ON w.id = d.template_id WHERE d.shift_id = ?`,
        [req.params.id]);
      if (usos.length) {
        return res.status(409).json({ error: `No se puede eliminar: lo usa ${usos.map((u) => `"${u.name}"`).join(', ')}. Sacalo de esos ciclos primero.` });
      }
      await db.query('DELETE FROM shift_definitions WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      if (responderSinMigracion(res, err)) return;
      console.error('ERROR borrando turno:', err);
      res.status(500).json({ error: 'Error al eliminar el turno' });
    }
  });

  // El ciclo de una plantilla rotativa: { modo, largo, dias: [turnoId|null, ...] }
  router.get('/templates/:id/ciclo', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const t = await plantillaPropia(req, req.params.id);
      if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
      const [[fila]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [t.id]);
      const largo = fila.modo === 'ROTATIVO' ? Number(fila.cycle_length) || 0 : 0;
      const dias = new Array(largo).fill(null);
      if (largo) {
        const [filas] = await db.query('SELECT day_number, shift_id FROM template_cycle_days WHERE template_id = ?', [t.id]);
        filas.forEach((d) => { if (d.day_number >= 1 && d.day_number <= largo) dias[d.day_number - 1] = d.shift_id; });
      }
      res.json({ modo: fila.modo || 'SEMANAL', largo, dias });
    } catch (err) {
      if (responderSinMigracion(res, err)) return;
      console.error('ERROR leyendo ciclo:', err);
      res.status(500).json({ error: 'Error al leer el ciclo' });
    }
  });

  // Guardar el ciclo convierte la plantilla en rotativa. { largo, dias }
  router.put('/templates/:id/ciclo', requirePermission('schedules', 'update'), async (req, res) => {
    const conn = await db.getConnection();
    try {
      const t = await plantillaPropia(req, req.params.id);
      if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
      const largo = Number(req.body.largo);
      const dias = Array.isArray(req.body.dias) ? req.body.dias : [];
      if (!Number.isInteger(largo) || largo < 2 || largo > 60) return res.status(400).json({ error: 'El ciclo tiene entre 2 y 60 días' });
      if (dias.length !== largo) return res.status(400).json({ error: 'Falta definir qué pasa cada día del ciclo' });
      if (!dias.some((d) => d != null)) return res.status(400).json({ error: 'El ciclo necesita al menos un día con turno' });
      // Los turnos tienen que ser de la MISMA empresa que la plantilla.
      const usados = [...new Set(dias.filter((d) => d != null).map(Number))];
      const [propios] = await db.query('SELECT id FROM shift_definitions WHERE tenant_id = ? AND id IN (?)', [t.tenant_id, usados]);
      if (propios.length !== usados.length) return res.status(400).json({ error: 'Hay un turno que no existe en esta empresa' });

      await conn.beginTransaction();
      await conn.query("UPDATE work_schedule_templates SET modo = 'ROTATIVO', cycle_length = ? WHERE id = ?", [largo, t.id]);
      await conn.query('DELETE FROM template_cycle_days WHERE template_id = ?', [t.id]);
      for (let i = 0; i < largo; i++) {
        await conn.query('INSERT INTO template_cycle_days (template_id, day_number, shift_id) VALUES (?, ?, ?)',
          [t.id, i + 1, dias[i] == null ? null : Number(dias[i])]);
      }
      await conn.commit();
      res.json({ ok: true });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (responderSinMigracion(res, err)) return;
      console.error('ERROR guardando ciclo:', err);
      res.status(500).json({ error: 'Error al guardar el ciclo' });
    } finally {
      conn.release();
    }
  });

  // Volver a semanal (sus bloques por dia de la semana siguen ahi).
  router.delete('/templates/:id/ciclo', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const t = await plantillaPropia(req, req.params.id);
      if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
      await db.query("UPDATE work_schedule_templates SET modo = 'SEMANAL', cycle_length = NULL WHERE id = ?", [t.id]);
      await db.query('DELETE FROM template_cycle_days WHERE template_id = ?', [t.id]);
      res.json({ ok: true });
    } catch (err) {
      if (responderSinMigracion(res, err)) return;
      console.error('ERROR quitando ciclo:', err);
      res.status(500).json({ error: 'Error al quitar el ciclo' });
    }
  });

  router.get('/employees', requirePermission('employees', 'read'), async (req, res) => {
    try {
      const { categoryId } = req.query;
      const params = [];
      let where = 'WHERE (e.activo = 1 OR e.activo IS NULL)';
      // AISLAMIENTO (auditoria 2026-10-07, hallazgo B): antes devolvia los
      // empleados de TODAS las empresas a cualquiera con "ver empleados".
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        where += ' AND e.tenant_id = ?';
        params.push(effectiveTenantId);
      }
      if (categoryId) {
        where += ' AND e.category_id = ?';
        params.push(categoryId);
      }

      const [employees] = await db.query(`
        SELECT
          e.id AS employee_id,
          e.nombre AS name,
          e.employee_id AS badgeNumber,
          e.legajo_alt AS alternateBadgeNumber,
          e.tenant_id,
          e.category_id,
          ec.name AS categoryName,
          e.activo AS active
        FROM employees e
        LEFT JOIN employee_categories ec ON ec.id = e.category_id
        ${where}
        ORDER BY e.nombre
        LIMIT 1000
      `, params);
      res.json(employees);
    } catch (err) {
      console.error('Motor Laboral admin employees error:', err);
      res.status(500).json({ error: 'Error al leer empleados' });
    }
  });

  /**
   * POST /api/labor-engine/admin/employees/bulk-set-categoria
   * Setea la categoría de puesto (catálogo employee_categories) a varios
   * empleados de una, para después poder filtrarlos y asignarles horario en bloque.
   */
  router.post('/employees/bulk-set-categoria', requirePermission('employees', 'update'), async (req, res) => {
    try {
      const { employeeIds, categoryId } = req.body;

      if (!Array.isArray(employeeIds) || employeeIds.length === 0 || !categoryId) {
        return res.status(400).json({ error: 'employeeIds (array) y categoryId son requeridos' });
      }

      // AISLAMIENTO (auditoria 2026-10-07, hallazgo C): antes cambiaba la
      // categoria de cualquier empleado por numero, de cualquier empresa, y
      // aceptaba una categoria de otra empresa. Ahora solo empleados y
      // categorias de la empresa de quien llama.
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[cat]] = await db.query('SELECT id FROM employee_categories WHERE id = ? AND tenant_id = ?', [categoryId, effectiveTenantId]);
        if (!cat) return res.status(404).json({ error: 'Categoría no encontrada' });
      }
      const [result] = await db.query(
        `UPDATE employees SET category_id = ? WHERE id IN (?)${effectiveTenantId !== null ? ' AND tenant_id = ?' : ''}`,
        effectiveTenantId !== null ? [categoryId, employeeIds, effectiveTenantId] : [categoryId, employeeIds]
      );

      res.json({ ok: true, affectedRows: result.affectedRows });
    } catch (err) {
      console.error('Motor Laboral admin bulk-set-categoria error:', err);
      res.status(500).json({ error: 'Error al setear categoría en bloque' });
    }
  });

  // "Dia 1" del ciclo de una plantilla rotativa (cycle_start_date). Ausente o
  // vacio = null (se usa la fecha de inicio de la asignacion); invalido =
  // undefined (400).
  function diaUnoDelBody(body) {
    const v = body.cycle_start_date ?? body.cycleStartDate;
    if (v === undefined || v === null || v === '') return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined;
  }
  // Solo se nombra la columna nueva si hace falta: sin "dia 1", la consulta
  // es la de siempre y funciona aunque la migracion 20261015 no se haya corrido.
  async function insertarAsignacion({ employeeId, tenantId, templateId, validFrom, validTo, diaUno }) {
    const [result] = diaUno
      ? await db.query(
        `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to, cycle_start_date)
         VALUES (?, ?, ?, ?, ?, ?)`, [employeeId, tenantId, templateId, validFrom, validTo || null, diaUno])
      : await db.query(
        `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?)`, [employeeId, tenantId, templateId, validFrom, validTo || null]);
    return result;
  }

  // ============ ASIGNACIÓN MASIVA DE HORARIOS ============

  /**
   * POST /api/labor-engine/admin/employees/bulk-assign-calendar
   * Asigna una plantilla a varios empleados de una, cerrando cualquier
   * asignación previa abierta de cada uno (misma lógica que el alta individual,
   * pero para N empleados en un solo request).
   */
  router.post('/employees/bulk-assign-calendar', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { employeeIds, template_id, valid_from, valid_to } = req.body;

      if (!Array.isArray(employeeIds) || employeeIds.length === 0 || !template_id || !valid_from) {
        return res.status(400).json({ error: 'employeeIds (array), template_id y valid_from son requeridos' });
      }
      const diaUno = diaUnoDelBody(req.body);
      if (diaUno === undefined) return res.status(400).json({ error: 'El día 1 del ciclo tiene que ser una fecha (AAAA-MM-DD)' });

      const [templateRows] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [template_id]);
      if (templateRows.length === 0) {
        return res.status(404).json({ error: 'Plantilla no encontrada' });
      }
      const templateTenantId = templateRows[0].tenant_id;

      const results = { assigned: [], skipped: [] };
      const effectiveTenantId = resolveTenantId(req);

      for (const employeeId of employeeIds) {
        const [emp] = await db.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (emp.length === 0) {
          results.skipped.push({ employeeId, reason: 'Empleado no encontrado' });
          continue;
        }

        // Bug real de seguridad: sin este chequeo, un usuario podia colar en
        // el mismo lote el id de un empleado de OTRA empresa (mientras la
        // plantilla fuera compatible) y asignarle un horario -- se salta
        // ese id en vez de fallar el lote entero, mismo criterio que los
        // demas "skipped" de esta ruta.
        if (effectiveTenantId !== null && emp[0].tenant_id && emp[0].tenant_id !== effectiveTenantId) {
          results.skipped.push({ employeeId, reason: 'Empleado no encontrado' });
          continue;
        }

        const empTenantId = emp[0].tenant_id || templateTenantId;
        if (!empTenantId) {
          results.skipped.push({ employeeId, reason: 'Sin tenant_id disponible' });
          continue;
        }

        if (emp[0].tenant_id && templateTenantId && templateTenantId !== 0 && templateTenantId !== emp[0].tenant_id) {
          results.skipped.push({ employeeId, reason: 'La plantilla pertenece a otra empresa (tenant_id no coincide con el del empleado)' });
          continue;
        }

        if (!emp[0].tenant_id && templateTenantId) {
          await db.query('UPDATE employees SET tenant_id = ? WHERE id = ?', [templateTenantId, employeeId]);
        }

        // Cerrar cualquier asignación abierta anterior (valid_to IS NULL) justo
        // antes de que empiece la nueva, para no dejar rangos superpuestos.
        await db.query(
          `UPDATE employee_work_calendars
           SET valid_to = DATE_SUB(?, INTERVAL 1 DAY)
           WHERE employee_id = ? AND valid_to IS NULL AND valid_from < ?`,
          [valid_from, employeeId, valid_from]
        );

        const result = await insertarAsignacion({ employeeId, tenantId: empTenantId, templateId: template_id, validFrom: valid_from, validTo: valid_to, diaUno });

        results.assigned.push({ employeeId, calendarId: result.insertId });
      }

      res.status(201).json(results);
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: FALTA_MIGRACION });
      console.error('Motor Laboral admin bulk-assign-calendar error:', err);
      res.status(500).json({ error: 'Error al asignar horarios en bloque' });
    }
  });

  router.get('/employees/:employeeId/calendar', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const { employeeId } = req.params;
      // Bug real de seguridad: esta ruta no chequeaba NADA de tenant -- un
      // usuario de una empresa podia leer el calendario de un empleado de
      // OTRA empresa con solo adivinar/conocer su employeeId (secuencial,
      // facil de barrer). El test existente (calendar-tenant-guard.test.js)
      // solo cubria plantilla-vs-empleado, nunca llamador-vs-empleado.
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[emp]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (!emp || emp.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Empleado no encontrado' });
        }
      }
      const [calendars] = await db.query(`
        SELECT *
        FROM employee_work_calendars
        WHERE employee_id = ?
        ORDER BY valid_from DESC, created_at DESC
      `, [employeeId]);
      res.json(calendars);
    } catch (err) {
      console.error('Motor Laboral admin employee calendar error:', err);
      res.status(500).json({ error: 'Error al leer calendario del empleado' });
    }
  });

  router.post('/employees/:employeeId/calendar', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { template_id, valid_from, valid_to, tenant_id } = req.body;

      if (!template_id || !valid_from) {
        return res.status(400).json({ error: 'template_id y valid_from requeridos' });
      }
      const diaUno = diaUnoDelBody(req.body);
      if (diaUno === undefined) return res.status(400).json({ error: 'El día 1 del ciclo tiene que ser una fecha (AAAA-MM-DD)' });

      const [emp] = await db.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
      if (emp.length === 0) {
        return res.status(404).json({ error: 'Empleado no encontrado' });
      }

      // Bug real de seguridad: no habia NINGUN chequeo de que el empleado
      // fuera de la MISMA empresa que quien hace el pedido -- un usuario
      // podia asignarle un horario a un empleado de otra empresa con solo
      // adivinar su employeeId. El chequeo de abajo (plantilla vs empleado)
      // no alcanza para esto: ambos podrian pertenecer a otro tenant distinto
      // al del que llama, y coincidir entre si sin problema.
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && emp[0].tenant_id && emp[0].tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Empleado no encontrado' });
      }

      const [templateRows] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [template_id]);
      const templateTenantId = templateRows.length > 0 ? templateRows[0].tenant_id : null;
      const empTenantId = tenant_id || emp[0].tenant_id || templateTenantId;

      if (!empTenantId) {
        return res.status(400).json({ error: 'No hay tenant_id disponible para esta asignación' });
      }

      // La plantilla tiene que ser de la misma empresa que el empleado (o
      // global, tenant_id = 0) -- si no, un empleado terminaba leyendo en
      // silencio el horario de otra empresa.
      if (emp[0].tenant_id && templateTenantId && templateTenantId !== 0 && templateTenantId !== emp[0].tenant_id) {
        return res.status(400).json({ error: 'La plantilla pertenece a otra empresa (tenant_id no coincide con el del empleado)' });
      }

      if (!emp[0].tenant_id && templateTenantId) {
        await db.query('UPDATE employees SET tenant_id = ? WHERE id = ?', [templateTenantId, employeeId]);
      }

      // Mismo criterio que bulk-assign-calendar (antes solo lo hacia esa
      // ruta, no esta -- inconsistencia real: asignar de a uno dejaba dos
      // asignaciones "abiertas" (valid_to NULL) superpuestas).
      await db.query(
        `UPDATE employee_work_calendars
         SET valid_to = DATE_SUB(?, INTERVAL 1 DAY)
         WHERE employee_id = ? AND valid_to IS NULL AND valid_from < ?`,
        [valid_from, employeeId, valid_from]
      );

      const result = await insertarAsignacion({ employeeId, tenantId: empTenantId, templateId: template_id, validFrom: valid_from, validTo: valid_to, diaUno });

      res.status(201).json({
        id: result.insertId,
        employee_id: employeeId,
        tenant_id: empTenantId,
        template_id,
        valid_from,
        valid_to: valid_to || null
      });
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ error: FALTA_MIGRACION });
      console.error('Motor Laboral admin save employee calendar error:', err);
      res.status(500).json({ error: 'Error al guardar calendario del empleado' });
    }
  });

  router.delete('/employees/:employeeId/calendar/:calendarId', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { employeeId, calendarId } = req.params;
      // Bug real de seguridad: sin NINGUN chequeo de tenant, cualquier
      // usuario con permiso de borrado podia eliminar la asignacion de
      // horario de un empleado de OTRA empresa con solo adivinar
      // employeeId/calendarId (ambos ids secuenciales, faciles de barrer).
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[emp]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (!emp || emp.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Asignación no encontrada' });
        }
      }

      const [result] = await db.query(
        'DELETE FROM employee_work_calendars WHERE employee_id = ? AND id = ?',
        [employeeId, calendarId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Asignación no encontrada' });
      }

      res.json({ id: calendarId, deleted: true });
    } catch (err) {
      console.error('Motor Laboral admin delete employee calendar error:', err);
      res.status(500).json({ error: 'Error al eliminar calendario del empleado' });
    }
  });

  // ============ Etapa 14 (hallazgo #4 de la auditoria) ============
  // Hasta ahora, day_type_overtime_rules/labor_conventions/
  // employee_convention_assignments solo se podian cargar por SQL
  // directo -- nada de lo construido en las Etapas 8/9 era operable
  // desde la app. Mismo patron de aislamiento de tenant que el resto de
  // este archivo (resolveTenantId + 404, nunca 403, para no filtrar
  // existencia de datos de otra empresa -- hallazgo #7 de la auditoria).

  // --- Convenios (labor_conventions) ---

  router.get('/conventions', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      const [rows] = effectiveTenantId !== null
        ? await db.query('SELECT * FROM labor_conventions WHERE tenant_id = ? ORDER BY name ASC', [effectiveTenantId])
        : await db.query('SELECT * FROM labor_conventions ORDER BY tenant_id ASC, name ASC');
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin conventions error:', err);
      res.status(500).json({ error: 'Error al leer convenios' });
    }
  });

  router.post('/conventions', requirePermission('schedules', 'create'), async (req, res) => {
    try {
      const bodyTenantId = req.body.tenant_id ?? req.body.tenantId;
      const tenantId = req.appUser && !req.appUser.isSuperadmin ? req.appUser.tenantId : bodyTenantId;
      const { name, description, active } = req.body;
      if (tenantId === undefined || tenantId === null || !name) {
        return res.status(400).json({ error: 'tenantId/tenant_id y name son requeridos' });
      }
      const [result] = await db.query(
        'INSERT INTO labor_conventions (tenant_id, name, description, active) VALUES (?, ?, ?, ?)',
        [tenantId, name, description || null, active === undefined || active ? 1 : 0]
      );
      res.status(201).json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create convention error:', err);
      res.status(500).json({ error: 'Error al crear convenio' });
    }
  });

  router.put('/conventions/:id', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      const [[existing]] = await db.query('SELECT * FROM labor_conventions WHERE id = ?', [id]);
      if (!existing || (effectiveTenantId !== null && existing.tenant_id !== effectiveTenantId)) {
        return res.status(404).json({ error: 'Convenio no encontrado' });
      }
      const { name, description, active } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name es requerido' });
      }
      await db.query(
        'UPDATE labor_conventions SET name = ?, description = ?, active = ? WHERE id = ?',
        [name, description || null, active === undefined || active ? 1 : 0, id]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('Motor Laboral admin update convention error:', err);
      res.status(500).json({ error: 'Error al actualizar convenio' });
    }
  });

  router.delete('/conventions/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      const [[existing]] = await db.query('SELECT tenant_id FROM labor_conventions WHERE id = ?', [id]);
      if (!existing || (effectiveTenantId !== null && existing.tenant_id !== effectiveTenantId)) {
        return res.status(404).json({ error: 'Convenio no encontrado' });
      }
      await db.query('DELETE FROM labor_conventions WHERE id = ?', [id]);
      res.json({ ok: true });
    } catch (err) {
      // FK real hacia day_type_overtime_rules/employee_convention_assignments
      // -- mensaje claro en vez de un 500 crudo de MySQL si esta en uso.
      if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
        return res.status(409).json({ error: 'No se puede eliminar: hay reglas de horas extra o encuadramientos de empleados que usan este convenio' });
      }
      console.error('Motor Laboral admin delete convention error:', err);
      res.status(500).json({ error: 'Error al eliminar convenio' });
    }
  });

  // --- Regimenes dentro de un convenio (labor_convention_regimes) ---
  // Migracion 20261007. Un convenio (ej. camioneros) puede tener variantes
  // ("con horas extra", "solo se registra"...). Cada regimen hereda todo del
  // convenio y cambia solo lo que se cargue a su nivel.

  async function convenioPropio(req, conventionId) {
    const effectiveTenantId = resolveTenantId(req);
    const [[c]] = await db.query('SELECT id, tenant_id FROM labor_conventions WHERE id = ?', [conventionId]);
    if (!c || (effectiveTenantId !== null && c.tenant_id !== effectiveTenantId)) return null;
    return c;
  }

  // Valida que el regimen pertenezca a ESE convenio. null = ok.
  async function regimenDelConvenio(regimeId, conventionId) {
    if (regimeId == null) return null;
    if (conventionId == null) return 'Un régimen siempre va dentro de un convenio';
    const [[r]] = await db.query('SELECT id FROM labor_convention_regimes WHERE id = ? AND convention_id = ?', [regimeId, conventionId]);
    return r ? null : 'El régimen no pertenece a ese convenio';
  }

  router.get('/conventions/:id/regimes', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const c = await convenioPropio(req, req.params.id);
      if (!c) return res.status(404).json({ error: 'Convenio no encontrado' });
      const [rows] = await db.query(
        `SELECT r.*, (SELECT COUNT(DISTINCT a.employee_id) FROM employee_convention_assignments a
                      WHERE a.regime_id = r.id AND (a.valid_to IS NULL OR a.valid_to >= CURDATE())) AS personas
         FROM labor_convention_regimes r WHERE r.convention_id = ? ORDER BY r.name`, [c.id]);
      res.json(rows);
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
      console.error('Motor Laboral admin regimes error:', err);
      res.status(500).json({ error: 'Error al leer regímenes' });
    }
  });

  router.post('/conventions/:id/regimes', requirePermission('schedules', 'create'), async (req, res) => {
    try {
      const c = await convenioPropio(req, req.params.id);
      if (!c) return res.status(404).json({ error: 'Convenio no encontrado' });
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      const [r] = await db.query(
        'INSERT INTO labor_convention_regimes (tenant_id, convention_id, name, description, active) VALUES (?, ?, ?, ?, ?)',
        [c.tenant_id, c.id, name, req.body.description || null, req.body.active === undefined || req.body.active ? 1 : 0]);
      res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay un régimen con ese nombre en este convenio' });
      console.error('Motor Laboral admin create regime error:', err);
      res.status(500).json({ error: 'Error al crear régimen' });
    }
  });

  router.put('/regimes/:id', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const [[r]] = await db.query('SELECT * FROM labor_convention_regimes WHERE id = ?', [req.params.id]);
      if (!r || !(await convenioPropio(req, r.convention_id))) return res.status(404).json({ error: 'Régimen no encontrado' });
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name es requerido' });
      await db.query('UPDATE labor_convention_regimes SET name = ?, description = ?, active = ? WHERE id = ?',
        [name, req.body.description || null, req.body.active === undefined || req.body.active ? 1 : 0, r.id]);
      res.json({ ok: true });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya hay un régimen con ese nombre en este convenio' });
      console.error('Motor Laboral admin update regime error:', err);
      res.status(500).json({ error: 'Error al actualizar régimen' });
    }
  });

  // Solo si nadie lo usa: borrarlo cambiaria en silencio como se liquida a
  // las personas encuadradas (y el historial dejaria de explicar el calculo).
  router.delete('/regimes/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const [[r]] = await db.query('SELECT * FROM labor_convention_regimes WHERE id = ?', [req.params.id]);
      if (!r || !(await convenioPropio(req, r.convention_id))) return res.status(404).json({ error: 'Régimen no encontrado' });
      const [[uso]] = await db.query(
        `SELECT (SELECT COUNT(*) FROM employee_convention_assignments WHERE regime_id = ?)
              + (SELECT COUNT(*) FROM day_type_overtime_rules WHERE regime_id = ?)
              + (SELECT COUNT(*) FROM overtime_regime_policies WHERE regime_id = ?) AS n`, [r.id, r.id, r.id]);
      if (Number(uso.n) > 0) {
        return res.status(409).json({ error: 'No se puede eliminar: tiene personas, reglas o topes. Desactivalo en su lugar.' });
      }
      await db.query('DELETE FROM labor_convention_regimes WHERE id = ?', [r.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('Motor Laboral admin delete regime error:', err);
      res.status(500).json({ error: 'Error al eliminar régimen' });
    }
  });

  // --- Reglas de horas extra por tipo de dia (day_type_overtime_rules) ---

  router.get('/day-type-rules', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId === null) {
        const [rows] = await db.query('SELECT * FROM day_type_overtime_rules ORDER BY tenant_id ASC, day_type ASC');
        return res.json(rows);
      }
      // Un usuario normal ve las reglas de SU tenant, mas las de SUS
      // propias plantillas/convenios -- nunca las de otra empresa ni las
      // globales (esas son responsabilidad del superadmin).
      const [rows] = await db.query(
        `SELECT r.* FROM day_type_overtime_rules r
         WHERE r.tenant_id = ?
            OR r.template_id IN (SELECT id FROM work_schedule_templates WHERE tenant_id = ?)
            OR r.convention_id IN (SELECT id FROM labor_conventions WHERE tenant_id = ?)
         ORDER BY r.day_type ASC`,
        [effectiveTenantId, effectiveTenantId, effectiveTenantId]
      );
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin day-type-rules error:', err);
      res.status(500).json({ error: 'Error al leer reglas de horas extra' });
    }
  });

  // Valida que (si vienen) template_id/convention_id pertenezcan al
  // tenant efectivo -- para un superadmin (effectiveTenantId null) no
  // hay restriccion (puede crear reglas cross-empresa a proposito, ej.
  // una global). Devuelve un mensaje de error o null si esta todo bien.
  async function validateDayTypeRuleScope({ effectiveTenantId, tenantId, templateId, conventionId }, db) {
    if (effectiveTenantId === null) return null;
    if (tenantId != null && Number(tenantId) !== effectiveTenantId) {
      return 'tenant_id no coincide con tu empresa';
    }
    if (templateId != null) {
      const [[tpl]] = await db.query('SELECT tenant_id FROM work_schedule_templates WHERE id = ?', [templateId]);
      if (!tpl || tpl.tenant_id !== effectiveTenantId) return 'template_id no pertenece a tu empresa';
    }
    if (conventionId != null) {
      const [[conv]] = await db.query('SELECT tenant_id FROM labor_conventions WHERE id = ?', [conventionId]);
      if (!conv || conv.tenant_id !== effectiveTenantId) return 'convention_id no pertenece a tu empresa';
    }
    return null;
  }

  router.post('/day-type-rules', requirePermission('schedules', 'create'), async (req, res) => {
    try {
      const effectiveTenantId = resolveTenantId(req);
      const { day_type, trigger_type, classification_type, rate, requires_authorization, active } = req.body;
      let { tenant_id, template_id, convention_id } = req.body;
      const regime_id = req.body.regime_id ?? null;
      if (!DAY_TYPES.includes(day_type) || !['BEFORE_SCHEDULE', 'AFTER_SCHEDULE', 'ALL_DAY'].includes(trigger_type)) {
        return res.status(400).json({ error: `day_type/trigger_type invalidos` });
      }
      const regimeError = await regimenDelConvenio(regime_id, convention_id ?? null);
      if (regimeError) return res.status(400).json({ error: regimeError });
      // Un usuario normal siempre crea a nivel de SU tenant salvo que
      // apunte a una plantilla/convenio propios -- nunca una regla global.
      if (effectiveTenantId !== null && tenant_id == null && template_id == null && convention_id == null) {
        tenant_id = effectiveTenantId;
      }
      const scopeError = await validateDayTypeRuleScope({ effectiveTenantId, tenantId: tenant_id, templateId: template_id, conventionId: convention_id }, db);
      if (scopeError) return res.status(400).json({ error: scopeError });

      const [result] = await db.query(
        // Sin regimen no se nombra la columna (migracion 20261007 pendiente).
        `INSERT INTO day_type_overtime_rules
           (tenant_id, convention_id, template_id, day_type, trigger_type, classification_type, rate, requires_authorization, active${regime_id == null ? '' : ', regime_id'})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${regime_id == null ? '' : ', ?'})`,
        [
          tenant_id ?? null, convention_id ?? null, template_id ?? null, day_type, trigger_type,
          classification_type || 'OVERTIME', rate ?? null,
          requires_authorization === undefined || requires_authorization ? 1 : 0,
          active === undefined || active ? 1 : 0,
          ...(regime_id == null ? [] : [regime_id])
        ]
      );
      res.status(201).json({ ok: true, id: result.insertId });
    } catch (err) {
      console.error('Motor Laboral admin create day-type-rule error:', err);
      res.status(500).json({ error: 'Error al crear regla de horas extra' });
    }
  });

  router.put('/day-type-rules/:id', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      const [[existing]] = await db.query('SELECT * FROM day_type_overtime_rules WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'Regla no encontrada' });
      if (effectiveTenantId !== null) {
        const notFoundError = await validateDayTypeRuleScope(
          { effectiveTenantId, tenantId: existing.tenant_id, templateId: existing.template_id, conventionId: existing.convention_id }, db
        );
        if (notFoundError) return res.status(404).json({ error: 'Regla no encontrada' });
      }
      const { day_type, trigger_type, classification_type, rate, requires_authorization, active } = req.body;
      if (!DAY_TYPES.includes(day_type) || !['BEFORE_SCHEDULE', 'AFTER_SCHEDULE', 'ALL_DAY'].includes(trigger_type)) {
        return res.status(400).json({ error: 'day_type/trigger_type invalidos' });
      }
      await db.query(
        `UPDATE day_type_overtime_rules
         SET day_type = ?, trigger_type = ?, classification_type = ?, rate = ?, requires_authorization = ?, active = ?
         WHERE id = ?`,
        [
          day_type, trigger_type, classification_type || 'OVERTIME', rate ?? null,
          requires_authorization === undefined || requires_authorization ? 1 : 0,
          active === undefined || active ? 1 : 0,
          id
        ]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('Motor Laboral admin update day-type-rule error:', err);
      res.status(500).json({ error: 'Error al actualizar regla de horas extra' });
    }
  });

  router.delete('/day-type-rules/:id', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { id } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      const [[existing]] = await db.query('SELECT * FROM day_type_overtime_rules WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: 'Regla no encontrada' });
      if (effectiveTenantId !== null) {
        const notFoundError = await validateDayTypeRuleScope(
          { effectiveTenantId, tenantId: existing.tenant_id, templateId: existing.template_id, conventionId: existing.convention_id }, db
        );
        if (notFoundError) return res.status(404).json({ error: 'Regla no encontrada' });
      }
      await db.query('DELETE FROM day_type_overtime_rules WHERE id = ?', [id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('Motor Laboral admin delete day-type-rule error:', err);
      res.status(500).json({ error: 'Error al eliminar regla de horas extra' });
    }
  });

  // --- Encuadramiento de empleado a convenio (employee_convention_assignments) ---

  router.get('/employees/:employeeId/convention-assignments', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const { employeeId } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[emp]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (!emp || emp.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Empleado no encontrado' });
        }
      }
      const [rows] = await consultarConRegimeId(db,
        `SELECT id, employee_id, tenant_id, convention_id, regime_id, category_id, valid_from, valid_to, created_at
         FROM employee_convention_assignments WHERE employee_id = ? ORDER BY valid_from DESC`,
        [employeeId]
      );
      res.json(rows);
    } catch (err) {
      console.error('Motor Laboral admin employee convention-assignments error:', err);
      res.status(500).json({ error: 'Error al leer encuadramiento del empleado' });
    }
  });

  router.post('/employees/:employeeId/convention-assignments', requirePermission('schedules', 'update'), async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { convention_id, category_id, valid_from, valid_to } = req.body;
      const regime_id = req.body.regime_id || null;
      if (!convention_id || !valid_from) {
        return res.status(400).json({ error: 'convention_id y valid_from son requeridos' });
      }
      const [[emp]] = await db.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
      if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null && emp.tenant_id !== effectiveTenantId) {
        return res.status(404).json({ error: 'Empleado no encontrado' });
      }
      const [[convention]] = await db.query('SELECT tenant_id FROM labor_conventions WHERE id = ?', [convention_id]);
      if (!convention || convention.tenant_id !== emp.tenant_id) {
        return res.status(400).json({ error: 'El convenio no pertenece a la misma empresa que el empleado' });
      }
      const regimeError = await regimenDelConvenio(regime_id, convention_id);
      if (regimeError) return res.status(400).json({ error: regimeError });

      // Mismo criterio que employee_work_calendars: cerrar cualquier
      // encuadramiento abierto anterior antes de que empiece el nuevo.
      await db.query(
        `UPDATE employee_convention_assignments
         SET valid_to = DATE_SUB(?, INTERVAL 1 DAY)
         WHERE employee_id = ? AND valid_to IS NULL AND valid_from < ?`,
        [valid_from, employeeId, valid_from]
      );

      const [result] = await db.query(
        // Sin regimen no se nombra la columna: funciona antes y despues de la migracion 20261007.
        regime_id == null
          ? `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, category_id, valid_from, valid_to)
             VALUES (?, ?, ?, ?, ?, ?)`
          : `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, category_id, valid_from, valid_to, regime_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, emp.tenant_id, convention_id, category_id ?? null, valid_from, valid_to || null, ...(regime_id == null ? [] : [regime_id])]
      );
      res.status(201).json({ id: result.insertId, employee_id: employeeId, convention_id, regime_id, category_id: category_id ?? null, valid_from, valid_to: valid_to || null });
    } catch (err) {
      console.error('Motor Laboral admin save convention-assignment error:', err);
      res.status(500).json({ error: 'Error al guardar encuadramiento del empleado' });
    }
  });

  router.delete('/employees/:employeeId/convention-assignments/:assignmentId', requirePermission('schedules', 'delete'), async (req, res) => {
    try {
      const { employeeId, assignmentId } = req.params;
      const effectiveTenantId = resolveTenantId(req);
      if (effectiveTenantId !== null) {
        const [[emp]] = await db.query('SELECT tenant_id FROM employees WHERE id = ?', [employeeId]);
        if (!emp || emp.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Encuadramiento no encontrado' });
        }
      }
      const [result] = await db.query(
        'DELETE FROM employee_convention_assignments WHERE employee_id = ? AND id = ?',
        [employeeId, assignmentId]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Encuadramiento no encontrado' });
      }
      res.json({ id: assignmentId, deleted: true });
    } catch (err) {
      console.error('Motor Laboral admin delete convention-assignment error:', err);
      res.status(500).json({ error: 'Error al eliminar encuadramiento del empleado' });
    }
  });

  // Fase 19: firewall por pais/IP de /api/public -- ver
  // countryFirewallMiddleware.js. Guardado en app_settings (global,
  // tenant_id NULL: esto corre ANTES de que exista ningun tenant, no
  // tiene sentido scopearlo por empresa) en vez de una tabla nueva --
  // mismo patron ya usado para corte de HE, tope de campana, etc.
  router.get('/system/firewall-settings', requireSuperadmin, async (req, res) => {
    try {
      const [countriesCsv, ipsCsv] = await Promise.all([
        getAppSetting(SETTING_COUNTRIES, null, db),
        getAppSetting(SETTING_IPS, null, db)
      ]);
      res.json({
        allowedCountries: parseList(countriesCsv),
        allowedIps: parseList(ipsCsv),
        enabled: parseList(countriesCsv).length > 0
      });
    } catch (err) {
      console.error('Motor Laboral admin get firewall-settings error:', err);
      res.status(500).json({ error: 'Error al leer la configuración del firewall' });
    }
  });

  router.put('/system/firewall-settings', requireSuperadmin, async (req, res) => {
    try {
      const allowedCountries = Array.isArray(req.body.allowedCountries) ? req.body.allowedCountries : [];
      const allowedIps = Array.isArray(req.body.allowedIps) ? req.body.allowedIps : [];

      const countries = allowedCountries.map((c) => String(c).trim().toUpperCase());
      const badCountry = countries.find((c) => !COUNTRY_CODE_RE.test(c));
      if (badCountry) {
        return res.status(400).json({ error: `Código de país inválido: "${badCountry}" (debe ser un código ISO de 2 letras, ej. AR)` });
      }

      const ips = allowedIps.map((ip) => String(ip).trim());
      const badIp = ips.find((ip) => !IP_OR_CIDR_RE.test(ip));
      if (badIp) {
        return res.status(400).json({ error: `IP o rango inválido: "${badIp}"` });
      }

      await setAppSetting(SETTING_COUNTRIES, null, countries.join(','), db);
      await setAppSetting(SETTING_IPS, null, ips.join(','), db);
      invalidateFirewallCache();

      res.json({ allowedCountries: countries, allowedIps: ips, enabled: countries.length > 0 });
    } catch (err) {
      console.error('Motor Laboral admin put firewall-settings error:', err);
      res.status(500).json({ error: 'Error al guardar la configuración del firewall' });
    }
  });

  // Monitor liviano de conexiones/rendimiento -- pensado para un vistazo
  // rapido desde la propia app (no reemplaza los dashboards de Render/
  // Clever Cloud, los complementa). Los contadores del pool son API
  // interna de mysql2 (con "_" adelante, no documentada oficialmente) --
  // envuelto en try/catch para que un cambio de version de la libreria
  // nunca tumbe esta ruta, en el peor caso devuelve null en poolStats.
  router.get('/system/status', requireSuperadmin, async (req, res) => {
    let poolStats = null;
    try {
      const raw = db.pool;
      poolStats = {
        limit: raw.config.connectionLimit,
        total: raw._allConnections.length,
        free: raw._freeConnections.length,
        busy: raw._allConnections.length - raw._freeConnections.length,
        queued: raw._connectionQueue.length
      };
    } catch (err) {
      console.warn('No se pudieron leer las estadisticas del pool (API interna de mysql2 cambio):', err.message);
    }

    const mem = process.memoryUsage();
    res.json({
      poolStats,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
      },
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  // Etapa 11 del plan "Motor de reglas de asistencia configurable" --
  // simulador de solo lectura: NUNCA escribe nada en la base. Corre el
  // motor nuevo (scheduleResolver + toleranceResolver + timeClassifier +
  // dayTypeRuleResolver) sobre datos hipotéticos, para que un admin pueda
  // cambiar una configuración y ver de inmediato como cambiaría el
  // resultado -- sin tocar ningún empleado, plantilla ni fichaje real.
  // Mismo permiso de LECTURA que el resto del admin de plantillas
  // (a proposito no exige 'update': simular no modifica nada).
  router.post('/simulate', requirePermission('schedules', 'read'), async (req, res) => {
    try {
      const {
        templateId,
        blocks,
        toleranceOverrides,
        checkins,
        dayType,
        isOvertimeAuthorized,
        dayTypeRules
      } = req.body;

      if (!Array.isArray(checkins) || checkins.length === 0) {
        return res.status(400).json({ error: 'checkins (array de horas "HH:mm") es requerido' });
      }
      const effectiveDayType = dayType || 'WORKDAY';
      if (!DAY_TYPES.includes(effectiveDayType)) {
        return res.status(400).json({ error: `dayType debe ser uno de: ${DAY_TYPES.join(', ')}` });
      }

      // Bloques: o se cargan de una plantilla REAL (solo lectura, para
      // simular "que pasaria si cambio la tolerancia de ESTA plantilla"),
      // o se reciben hipoteticos directo en el body (para probar un
      // horario que ni siquiera existe todavia).
      let sourceBlocks = blocks;
      let template = null;
      if (templateId) {
        const [[tpl]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [templateId]);
        if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada' });
        const effectiveTenantId = resolveTenantId(req);
        if (effectiveTenantId !== null && tpl.tenant_id !== effectiveTenantId) {
          return res.status(404).json({ error: 'Plantilla no encontrada' });
        }
        template = tpl;
        if (!sourceBlocks) {
          const dow = new Date(`${req.body.date || '2026-01-05'}T00:00:00`).getDay(); // lunes por defecto si no se manda fecha
          const [rows] = await db.query('SELECT * FROM shift_blocks WHERE template_id = ? AND day_of_week = ?', [templateId, dow]);
          sourceBlocks = rows;
        }
      }
      if (!Array.isArray(sourceBlocks) || sourceBlocks.length === 0) {
        return res.status(400).json({ error: 'blocks o templateId (con bloques cargados ese día) es requerido' });
      }

      const segments = resolveScheduleSegments(sourceBlocks);
      const toleranceConfig = resolveToleranceConfig(
        { ...(template || {}), ...(toleranceOverrides || {}) },
        10 // fallback legacy neutro para la simulacion -- no depende de un empleado real
      );
      const checkinMinutes = checkins.map((c) => timeToMinutes(c));

      const result = computeAttendanceResult({
        segments,
        checkins: checkinMinutes,
        toleranceConfig,
        isOvertimeAuthorized: !!isOvertimeAuthorized,
        dayType: effectiveDayType,
        dayTypeRules: Array.isArray(dayTypeRules) ? dayTypeRules : []
      });

      // minutesToTime: para que el frontend arme la linea de tiempo sin
      // tener que reimplementar la conversion.
      const minutesToTime = (mins) => {
        const normalized = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
        const h = Math.floor(normalized / 60);
        const m = normalized % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      };

      res.json({
        ...result,
        segments: segments.map((s) => ({ ...s, startTimeLabel: minutesToTime(s.startMinutes), endTimeLabel: minutesToTime(s.endMinutes) })),
        classifiedSegments: result.classifiedSegments.map((s) => ({
          ...s,
          startTimeLabel: minutesToTime(s.startMinutes),
          endTimeLabel: minutesToTime(s.endMinutes)
        })),
        toleranceConfig
      });
    } catch (err) {
      console.error('Motor Laboral admin simulate error:', err);
      res.status(500).json({ error: 'Error al simular' });
    }
  });

  return router;
}

module.exports = createMotorLaboralAdminRoutes;
