function getLocalDayOfWeek(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return new Date(dateString).getDay();
  return new Date(year, month - 1, day).getDay();
}

async function buildTemplateSchedule(template, date, db) {
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
    blocks,
    blockCount: blocks.length
  };
}

async function findAssignedScheduleMapForDate(date, employeeIds, db) {
  if (!employeeIds || !employeeIds.length) return {};

  const [rows] = await db.query(
    `SELECT e.employee_id AS employeeId, t.*
     FROM employee_work_calendars c
     JOIN employees e ON e.id = c.employee_id
     JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE e.employee_id IN (?)
       AND c.valid_from <= ?
       AND (c.valid_to IS NULL OR c.valid_to >= ?)
       AND t.active = 1
     ORDER BY e.employee_id ASC, c.valid_from DESC`,
    [employeeIds, date, date]
  );

  const map = {};
  for (const row of rows) {
    if (!map[row.employeeId]) {
      map[row.employeeId] = await buildTemplateSchedule(row, date, db);
    }
  }
  return map;
}

// Trae de una sola vez TODAS las asignaciones (employee_work_calendars) que
// se solapan con el rango [fromDate, toDate], en vez de una consulta por día.
// Devuelve las filas crudas (con valid_from/valid_to) agrupadas por employeeId,
// para que el llamador resuelva día por día en memoria cuál aplica.
async function findAssignedCalendarRowsForRange(fromDate, toDate, employeeIds, db) {
  if (!employeeIds || !employeeIds.length) return {};

  const [rows] = await db.query(
    `SELECT e.employee_id AS employeeId, c.valid_from, c.valid_to, t.*
     FROM employee_work_calendars c
     JOIN employees e ON e.id = c.employee_id
     JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE e.employee_id IN (?)
       AND c.valid_from <= ?
       AND (c.valid_to IS NULL OR c.valid_to >= ?)
       AND t.active = 1
     ORDER BY e.employee_id ASC, c.valid_from DESC`,
    [employeeIds, toDate, fromDate]
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
  // Prefer tenant-specific default templates when present, then tenant-specific active templates,
  // then global defaults, then global active templates.
  const templateQuery = hasTenantId
    ? `SELECT * FROM work_schedule_templates
         WHERE (tenant_id = ? OR tenant_id = 0) AND active = 1
         ORDER BY tenant_id DESC, is_default DESC, id DESC LIMIT 1`
    : `SELECT * FROM work_schedule_templates WHERE tenant_id = 0 AND active = 1 ORDER BY is_default DESC, id DESC LIMIT 1`;
  const templateParams = hasTenantId ? [tenantId] : [];

  const [templates] = await db.query(templateQuery, templateParams);
  return templates[0] || null;
}

async function findByDate(date, tenantId, db) {
  const template = await findTenantTemplate(date, tenantId, db);
  if (template) {
    return [await buildTemplateSchedule(template, date, db)];
  }

  const [rows] = await db.query(`SELECT * FROM companyschedule WHERE scheduleDate = ?`, [date]);
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
