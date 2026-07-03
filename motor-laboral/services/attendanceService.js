function normalizeDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function buildLegacySchedule({ date, tenantSchedule }) {
  if (!tenantSchedule) {
    return {
      date,
      timeEntrance: '07:00:00',
      timeExit: '13:40:00',
      isWorkDay: true,
      source: 'legacy'
    };
  }

  return {
    date,
    timeEntrance: tenantSchedule.timeEntrance,
    timeExit: tenantSchedule.timeExit,
    isWorkDay: tenantSchedule.isWorkDay === 1,
    source: tenantSchedule.source || 'legacy'
  };
}

function buildMotorSchedule({ date, tenantSchedule }) {
  return {
    date,
    timeEntrance: tenantSchedule.timeEntrance || '07:00:00',
    timeExit: tenantSchedule.timeExit || '13:40:00',
    isWorkDay: tenantSchedule.isWorkDay === 1,
    source: tenantSchedule.source || 'motor',
    templateId: tenantSchedule.templateId || null,
    tenantId: tenantSchedule.tenantId || null,
    template_type: tenantSchedule.template_type || null,
    blocks: tenantSchedule.blocks || [],
    blockCount: tenantSchedule.blockCount || 0
  };
}

function getScheduleEntry(schedule, assignedScheduleMap, employeeId) {
  if (assignedScheduleMap && assignedScheduleMap[employeeId]) {
    return assignedScheduleMap[employeeId];
  }
  return schedule;
}

function getEntranceReference(schedule) {
  if (schedule.source === 'motor' && schedule.blocks && schedule.blocks.length > 0) {
    const workBlocks = schedule.blocks.filter(b => b.block_type === 'WORK');
    if (workBlocks.length > 0) {
      return workBlocks[0].start_time;
    }
  }
  return schedule.timeEntrance;
}

function buildAttendance(usersMap, checkins, exclusions, schedule, assignedScheduleMap, isHoliday) {
  checkins.forEach(c => {
    const entry = usersMap.get(String(c.employeeId));
    if (entry) {
      entry.checkins.push(c.CHECKTIME);
    }
  });

  return Array.from(usersMap.values()).map(u => {
    const exclusion = exclusions.find(e => e.userId === u.userId);
    const checkinsSorted = u.checkins.slice().sort();
    const firstCheckin = checkinsSorted[0] || null;
    const lastCheckin = checkinsSorted[checkinsSorted.length - 1] || null;

    const userSchedule = getScheduleEntry(schedule, assignedScheduleMap, u.employeeId);
    const entranceRef = getEntranceReference(userSchedule);
    const entranceMinutes = Number(entranceRef.split(':')[0]) * 60 + Number(entranceRef.split(':')[1]);
    let toleranceMin = 10;
    if (userSchedule.source === 'motor' && userSchedule.template_type === 'FLEXIBLE') {
      toleranceMin = 60;
    }

    let status = 'Absent';
    if (exclusion) {
      status = 'Excused';
    } else if (checkinsSorted.length > 0) {
      const firstTime = firstCheckin.split(' ')[1].substring(0, 5);
      const [h, m] = firstTime.split(':').map(Number);
      const firstMinutes = h * 60 + m;

      if (firstMinutes <= entranceMinutes + toleranceMin) {
        status = 'OnTime';
      } else {
        status = 'Late';
      }
      if (isHoliday) {
        status = 'WorkedHoliday';
      }
    }

    return {
      employeeId: u.employeeId,
      userId: u.userId,
      badgeNumber: u.badgeNumber,
      name: u.name,
      status,
      firstCheckin,
      lastCheckin,
      totalCheckins: checkinsSorted.length,
      checkins: checkinsSorted,
      exclusion: exclusion || null,
      schedule: {
        source: userSchedule.source,
        templateType: userSchedule.template_type || null,
        timeEntrance: userSchedule.timeEntrance,
        timeExit: userSchedule.timeExit,
        blockCount: userSchedule.blockCount,
        blocks: userSchedule.blocks || []
      }
    };
  });
}

function buildSummary(attendance) {
  return {
    onTime: attendance.filter(a => a.status === 'OnTime').length,
    late: attendance.filter(a => a.status === 'Late').length,
    absent: attendance.filter(a => a.status === 'Absent').length,
    excused: attendance.filter(a => a.status === 'Excused').length,
    total: attendance.length
  };
}

async function calculateDailyAttendance({ date, tenantId, repositories }) {
  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    throw new Error('Fecha inválida');
  }

  const tenantScheduleRows = await repositories.schedule.findByDate(normalizedDate, tenantId);
  const tenantSchedule = Array.isArray(tenantScheduleRows) ? tenantScheduleRows[0] : tenantScheduleRows;

  const schedule = tenantSchedule && (tenantSchedule.source === 'new' || tenantSchedule.source === 'motor')
    ? buildMotorSchedule({ date: normalizedDate, tenantSchedule })
    : buildLegacySchedule({ date: normalizedDate, tenantSchedule });

  const holidayRows = await repositories.holiday.findByDate(normalizedDate, tenantId);
  const isHoliday = Array.isArray(holidayRows) ? holidayRows.some(h => h.isWorkDay === 0) : false;

  if (isHoliday) {
    schedule.isWorkDay = false;
  }

  const rawUsers = await repositories.user.findAll({ tenantId });
  const checkins = await repositories.checkin.findByDate(normalizedDate, tenantId);
  const exclusions = await repositories.exclusion.findByDate(normalizedDate, tenantId);

  const usersMap = new Map();
  rawUsers.forEach(u => {
    usersMap.set(String(u.employeeId), {
      employeeId: u.employeeId,
      userId: u.USERID || null,
      badgeNumber: u.Badgenumber || null,
      name: u.Name,
      checkins: []
    });
  });

  const employeeIds = Array.from(usersMap.keys()).map(id => Number(id));
  const assignedScheduleMap = await repositories.schedule.findAssignedScheduleMapForDate(normalizedDate, employeeIds);

  const attendance = buildAttendance(usersMap, checkins, exclusions, schedule, assignedScheduleMap, isHoliday);
  const summary = buildSummary(attendance);
  const anyMotorSchedule = attendance.some(a => a.schedule.source === 'motor');
  const usedMotorSchedule = schedule.source === 'motor' || anyMotorSchedule;

  return {
    date: normalizedDate,
    schedule,
    diagnosis: {
      usedMotorSchedule,
      source: schedule.source,
      templateId: schedule.templateId || null,
      tenantId: schedule.tenantId || null,
      shiftBlocksCount: schedule.blockCount || 0,
      individualMotorAssignments: anyMotorSchedule
    },
    holidays: holidayRows,
    summary,
    attendance,
    legacyMode: !usedMotorSchedule,
    note: usedMotorSchedule
      ? 'Resultado del Motor Laboral usando tablas nuevas cuando están disponibles.'
      : 'Resultado inicial del Motor Laboral. Se mantiene la lógica legacy para compatibilidad.'
  };
}

async function calculateLegacyAttendance({ date, db }) {
  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    throw new Error('Fecha inválida');
  }

  const [dayConfig] = await db.query(
    `SELECT * FROM companyschedule WHERE scheduleDate = ?`,
    [normalizedDate]
  );

  const config = dayConfig[0] || {
    timeEntrance: '07:00:00',
    timeExit: '13:40:00',
    isWorkDay: true
  };

  const [holidayRows] = await db.query(
    `SELECT * FROM holidays
     WHERE date = ?
        OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') = DATE_FORMAT(?, '%m-%d'))`,
    [normalizedDate, normalizedDate]
  );

  if (holidayRows.length > 0) {
    const holidayNotWork = holidayRows.some(h => h.isWorkDay == 0);
    if (holidayNotWork) {
      config.isWorkDay = false;
    }
  }

  if (!config.isWorkDay) {
    return {
      date: normalizedDate,
      schedule: config,
      holidays: holidayRows,
      summary: {
        onTime: 0,
        late: 0,
        absent: 0,
        excused: 0,
        total: 0
      },
      attendance: [],
      legacyMode: true,
      note: 'Resultado legacy para día no laborable.'
    };
  }

  const [exclusions] = await db.query(
    `SELECT * FROM userexclusions WHERE excDate = ?`,
    [normalizedDate]
  );

  const [rows] = await db.query(
    `
      SELECT 
        e.employee_id,
        e.nombre,
        u.USERID,
        u.Badgenumber,
        u.Name,
        c.CHECKTIME
      FROM employees e

      LEFT JOIN user_employee_map ue 
        ON ue.employee_id = e.id

      LEFT JOIN users u 
        ON u.USERID = ue.USERID

      LEFT JOIN Checkins c 
        ON c.USERID = u.USERID
        AND DATE(c.CHECKTIME) = ?

      WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)

      ORDER BY e.nombre, c.CHECKTIME
    `,
    [normalizedDate]
  );

  const map = {};
  rows.forEach(r => {
    if (!map[r.employee_id]) {
      map[r.employee_id] = {
        userId: r.USERID,
        badgeNumber: r.Badgenumber,
        name: r.nombre,
        checkins: []
      };
    }

    if (r.CHECKTIME) {
      map[r.employee_id].checkins.push(r.CHECKTIME);
    }
  });

  const attendance = Object.values(map).map(u => {
    const exclusion = exclusions.find(e => e.userId === u.userId);
    const checkins = u.checkins || [];

    let status = 'Absent';
    let firstCheckin = null;
    let lastCheckin = null;

    if (exclusion) {
      status = 'Excused';
    } else if (checkins.length > 0) {
      firstCheckin = checkins[0];
      lastCheckin = checkins[checkins.length - 1];

      const firstTime = firstCheckin.split(' ')[1].substring(0, 5);
      const [h, m] = firstTime.split(':').map(Number);
      const firstMinutes = h * 60 + m;
      const entranceMinutes = Number(config.timeEntrance.split(':')[0]) * 60 + Number(config.timeEntrance.split(':')[1]);
      const toleranceMin = 10;
      status = firstMinutes <= entranceMinutes + toleranceMin ? 'OnTime' : 'Late';
    }

    return {
      userId: u.userId,
      badgeNumber: u.badgeNumber,
      name: u.name,
      status,
      firstCheckin,
      lastCheckin,
      totalCheckins: checkins.length,
      checkins,
      exclusion: exclusion || null
    };
  });

  const summary = buildSummary(attendance);

  return {
    date: normalizedDate,
    schedule: config,
    holidays: holidayRows,
    summary,
    attendance,
    legacyMode: true,
    note: 'Resultado legacy para comparación.'
  };
}

module.exports = {
  calculateDailyAttendance,
  calculateLegacyAttendance
};
