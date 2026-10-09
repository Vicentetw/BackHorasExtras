const { esRotativa, bloquesDelCiclo } = require('../services/cicloDeTurnos');
const turnosRepository = require('./turnosRepository');

function getLocalDayOfWeek(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return new Date(dateString).getDay();
  return new Date(year, month - 1, day).getDay();
}

// Plantilla ROTATIVA (DISENO_HORARIOS_ROTATIVOS.md): los bloques salen del
// turno que cae ese dia del ciclo, con el mismo formato que los de una
// semanal. `datosCiclos` = turnosRepository.cargarCiclos(...) ya traido.
function scheduleRotativo(template, date, datosCiclos) {
  const { bloques, dia, turno } = bloquesDelCiclo(template, date, datosCiclos);
  const schedule = buildScheduleFromBlocks(template, bloques, date);
  schedule.cicloDia = dia;
  schedule.turnoNombre = turno ? turno.nombre : null;
  return schedule;
}

async function buildTemplateSchedule(template, date, db, datosCiclos = null) {
  if (esRotativa(template)) {
    const datos = datosCiclos || await turnosRepository.cargarCiclos(db, [template.id]);
    return scheduleRotativo(template, date, datos);
  }
  const dayOfWeek = getLocalDayOfWeek(date);
  const [blocks] = await db.query(
    `SELECT * FROM shift_blocks WHERE template_id = ? AND day_of_week = ? AND active = 1 ORDER BY start_time ASC`,
    [template.id, dayOfWeek]
  );

  return buildScheduleFromBlocks(template, blocks, date);
}

// Versión sin consulta a DB: arma el mismo objeto que buildTemplateSchedule
// pero a partir de bloques ya traídos en memoria (para poder cachearlos y no
// re-consultar shift_blocks una vez por día en un rango de fechas largo).
function buildScheduleFromBlocks(template, blocks, date) {
  const workBlocks = blocks.filter((block) => block.block_type === 'WORK');
  const startTime = workBlocks.length > 0 ? workBlocks[0].start_time : blocks[0]?.start_time || '07:00:00';
  const endTime = workBlocks.length > 0
    ? workBlocks[workBlocks.length - 1].end_time
    : blocks[blocks.length - 1]?.end_time || '13:40:00';

  return {
    date,
    timeEntrance: startTime,
    timeExit: endTime,
    isWorkDay: workBlocks.length > 0 ? 1 : 0,
    source: 'motor',
    templateId: template.id,
    tenantId: template.tenant_id,
    template_type: template.type || null,
    // Corte de HE propio de esta plantilla (columna nullable en
    // work_schedule_templates) -- ver overtimeCalculations.resolveOvertimeCutoffMinutes,
    // que usa esto en vez del corte único global cuando está cargado.
    overtimeCutoffTime: template.overtime_cutoff_time || null,
    overtimeCapMinutes: template.overtime_cap_minutes ?? null,
    blocks,
    blockCount: blocks.length,
    // Etapa 12 del plan "Motor de reglas de asistencia configurable" --
    // 'legacy' (default de la plantilla) = /attendance-range no cambia en
    // nada. 'template' completo (no solo los 4 campos de tolerancia) para
    // que el llamador pueda resolver tolerancias/reglas sin volver a
    // consultar la DB por dia -- ver resolveToleranceConfig, que ya acepta
    // cualquier objeto con esas columnas.
    rulesEngineMode: template.rules_engine_mode || 'legacy',
    template
  };
}

async function findAssignedScheduleMapForDate(date, employeeIds, db, tenantId) {
  // Defensa extra ademas del filtro que ya hace el caller (attendanceService.js):
  // un solo NaN colado en la lista (empleado con employee_id nulo/vacio) hace
  // que MySQL tire "Unknown column 'NaN'" al armar el IN (?) y tumba el motor
  // diario ENTERO para todos los empleados, no solo para el que tiene el dato malo.
  const safeIds = (employeeIds || []).filter((id) => typeof id === 'number' && !Number.isNaN(id));
  if (!safeIds.length) return {};

  // Fase 20: el legajo (e.employee_id) ya no es unico global -- si no se
  // filtra por tenant, un legajo compartido entre dos empresas puede traer
  // el calendario de la empresa EQUIVOCADA (el map se keyea por legajo).
  // tenantId null (superadmin, calculo cross-empresa) queda como antes.
  const tenantClause = tenantId != null ? 'AND e.tenant_id = ?' : '';
  const params = tenantId != null ? [safeIds, tenantId, date, date] : [safeIds, date, date];
  // c.* trae la fecha de inicio y el "dia 1" del ciclo (cycle_start_date, si
  // ya se corrio la migracion 20261015); t.* va despues y pisa id/tenant_id
  // con los de la PLANTILLA, que es lo que el resto del codigo espera.
  const [rows] = await db.query(
    `SELECT e.employee_id AS employeeId, c.*, t.*
     FROM employee_work_calendars c
     JOIN employees e ON e.id = c.employee_id
     JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE e.employee_id IN (?)
       ${tenantClause}
       AND c.valid_from <= ?
       AND (c.valid_to IS NULL OR c.valid_to >= ?)
       AND t.active = 1
       -- Aislamiento (2026-10-09): una plantilla de OTRA empresa nunca se usa,
       -- aunque una asignación vieja apuntara a ella (hoy no hay ninguna).
       AND (t.tenant_id = e.tenant_id OR t.tenant_id = 0 OR t.tenant_id IS NULL)
     ORDER BY e.employee_id ASC, c.valid_from DESC`,
    params
  );

  const datosCiclos = await turnosRepository.cargarCiclos(db, rows.filter(esRotativa).map((r) => r.id));
  const map = {};
  for (const row of rows) {
    if (!map[row.employeeId]) {
      map[row.employeeId] = await buildTemplateSchedule(row, date, db, datosCiclos);
    }
  }
  return map;
}

// Trae de una sola vez TODAS las asignaciones (employee_work_calendars) que
// se solapan con el rango [fromDate, toDate], en vez de una consulta por día.
// Devuelve las filas crudas (con valid_from/valid_to) agrupadas por employeeId,
// para que el llamador resuelva día por día en memoria cuál aplica.
async function findAssignedCalendarRowsForRange(fromDate, toDate, employeeIds, db, tenantId) {
  if (!employeeIds || !employeeIds.length) return {};

  // Fase 20: mismo motivo que findAssignedScheduleMapForDate -- legajo ya
  // no es unico global, se filtra por tenant salvo en el caso superadmin.
  const tenantClause = tenantId != null ? 'AND e.tenant_id = ?' : '';
  const params = tenantId != null ? [employeeIds, tenantId, toDate, fromDate] : [employeeIds, toDate, fromDate];
  const [rows] = await db.query(
    `SELECT e.employee_id AS employeeId, c.*, t.*
     FROM employee_work_calendars c
     JOIN employees e ON e.id = c.employee_id
     JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE e.employee_id IN (?)
       ${tenantClause}
       AND c.valid_from <= ?
       AND (c.valid_to IS NULL OR c.valid_to >= ?)
       AND t.active = 1
       -- Aislamiento (2026-10-09): una plantilla de OTRA empresa nunca se usa,
       -- aunque una asignación vieja apuntara a ella (hoy no hay ninguna).
       AND (t.tenant_id = e.tenant_id OR t.tenant_id = 0 OR t.tenant_id IS NULL)
     ORDER BY e.employee_id ASC, c.valid_from DESC`,
    params
  );

  const byEmployee = {};
  rows.forEach(row => {
    if (!byEmployee[row.employeeId]) byEmployee[row.employeeId] = [];
    byEmployee[row.employeeId].push(row);
  });
  return byEmployee;
}

async function findTenantTemplate(date, tenantId, db) {
  const hasTenantId = tenantId !== undefined && tenantId !== null;
  // La plantilla por defecto de la empresa (o, si no marco ninguna, la
  // ultima activa). Ya no cae en una plantilla "global" (tenant_id 0): una
  // empresa sin plantillas no hereda el horario de otra
  // (AISLAMIENTO_POR_EMPRESA.md, C).
  // Una plantilla ROTATIVA nunca es la "por defecto": sin una asignacion no
  // hay "dia 1" desde donde contar el ciclo. Se filtra aca (y no en SQL)
  // para funcionar igual sin la migracion 20261015.
  const templateQuery = hasTenantId
    ? `SELECT * FROM work_schedule_templates
         WHERE tenant_id = ? AND active = 1
         ORDER BY is_default DESC, id DESC`
    : `SELECT * FROM work_schedule_templates WHERE tenant_id = 0 AND active = 1 ORDER BY is_default DESC, id DESC`;
  const templateParams = hasTenantId ? [tenantId] : [];

  const [templates] = await db.query(templateQuery, templateParams);
  return templates.find((t) => !esRotativa(t)) || null;
}

async function findByDate(date, tenantId, db) {
  const template = await findTenantTemplate(date, tenantId, db);
  if (template) {
    return [await buildTemplateSchedule(template, date, db)];
  }

  // Solo el horario de la empresa (antes no filtraba: leia el de cualquiera).
  // AISLAMIENTO_POR_EMPRESA.md, C.
  const [rows] = tenantId !== undefined && tenantId !== null
    ? await db.query(`SELECT * FROM companyschedule WHERE scheduleDate = ? AND tenant_id = ?`, [date, tenantId])
    : await db.query(`SELECT * FROM companyschedule WHERE scheduleDate = ?`, [date]);
  return rows;
}

// Trae todos los shift_blocks activos de un conjunto de plantillas de una sola
// vez, agrupados por (templateId, day_of_week), para evitar re-consultar por
// cada día de un rango largo (mensual/anual).
async function getShiftBlocksByTemplate(templateIds, db) {
  const uniqueIds = [...new Set(templateIds)].filter(id => id !== undefined && id !== null);
  const blocksByTemplate = {};
  if (uniqueIds.length === 0) return blocksByTemplate;

  const [rows] = await db.query(
    `SELECT * FROM shift_blocks WHERE template_id IN (?) AND active = 1 ORDER BY template_id, day_of_week, start_time ASC`,
    [uniqueIds]
  );

  rows.forEach(block => {
    if (!blocksByTemplate[block.template_id]) blocksByTemplate[block.template_id] = {};
    if (!blocksByTemplate[block.template_id][block.day_of_week]) blocksByTemplate[block.template_id][block.day_of_week] = [];
    blocksByTemplate[block.template_id][block.day_of_week].push(block);
  });

  return blocksByTemplate;
}

module.exports = {
  findByDate,
  findAssignedScheduleMapForDate,
  findAssignedCalendarRowsForRange,
  findTenantTemplate,
  getShiftBlocksByTemplate,
  buildScheduleFromBlocks,
  scheduleRotativo,
  getLocalDayOfWeek
};

async function findByTemplateId(date, templateId, db) {
  if (!templateId) return [];
  const [rows] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ? AND active = 1', [templateId]);
  const template = rows[0];
  if (!template) return [];
  const schedule = await buildTemplateSchedule(template, date, db);
  return [schedule];
}

// attach as named export
module.exports.findByTemplateId = findByTemplateId;
