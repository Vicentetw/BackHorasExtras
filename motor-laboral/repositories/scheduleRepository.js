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

module.exports = {
  findByDate,
  findAssignedScheduleMapForDate,
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
