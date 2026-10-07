const { getLocalDayOfWeek } = require('../repositories/scheduleRepository');
const {
  getEntranceReference,
  resolveToleranceMinutes,
  resolveLateJustification,
  resolverAvisoLicencia,
  timeToMinutes,
  evaluateMultiVisitDay,
  stripOvernightCarryover
} = require('./attendanceCalculations');
const { holidayAppliesToEmployee, isNonWorkHoliday } = require('./holidayScope');
const { evaluarFueraDeHorario } = require('./fueraDeHorario');

function isDefaultWorkday(dateString) {
  const dayOfWeek = getLocalDayOfWeek(dateString);
  return dayOfWeek !== 0 && dayOfWeek !== 6;
}

function normalizeDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function nextDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function previousDayStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
}

function buildLegacySchedule({ date, tenantSchedule }) {
  if (!tenantSchedule) {
    return {
      date,
      timeEntrance: '07:00:00',
      timeExit: '13:40:00',
      isWorkDay: isDefaultWorkday(date),
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

function getScheduleEntry(schedule, assignedScheduleMap, tenantScheduleMap, employeeId, employeeTenantId) {
  if (assignedScheduleMap && assignedScheduleMap[employeeId]) {
    return assignedScheduleMap[employeeId];
  }
  if (tenantScheduleMap && employeeTenantId != null && tenantScheduleMap[employeeTenantId]) {
    return tenantScheduleMap[employeeTenantId];
  }
  return schedule;
}

// Variante sin fallback al schedule "general" del dia -- se usa SOLO para
// resolver el schedule de AYER (ver mas abajo, turnos que cruzan
// medianoche): si el empleado no tiene una asignacion explicita ni un
// schedule de tenant para ayer, se prefiere null (no filtrar nada, mismo
// comportamiento que antes de este fix) en vez de asumir el default
// general -- evita falsos positivos de "cruza medianoche" sobre un
// fallback generico que no necesariamente aplica.
function getScheduleEntryOrNull(assignedScheduleMap, tenantScheduleMap, employeeId, employeeTenantId) {
  if (assignedScheduleMap && assignedScheduleMap[employeeId]) {
    return assignedScheduleMap[employeeId];
  }
  if (tenantScheduleMap && employeeTenantId != null && tenantScheduleMap[employeeTenantId]) {
    return tenantScheduleMap[employeeTenantId];
  }
  return null;
}

// Turnos que cruzan medianoche ("sereno", 22:00-06:00, etc.): una marca de
// madrugada de HOY puede en realidad ser la SALIDA del turno de AYER, si
// ayer cruzaba medianoche -- sin esto, se toma como si fuera la entrada de
// hoy, y una entrada de madrugada nunca puede llegar tarde respecto de un
// turno que arranca de noche (bug real, prueba de estres pre-venta, ver el
// mismo fix en /attendance-range de horasdedica2.js). assignedScheduleMapYesterday/
// tenantScheduleMapYesterday: mismo shape que sus pares de "hoy", pero
// resueltos para el dia anterior -- ver calculateDailyAttendance.
// campana: { modo: 'trabajado'|'excusado', empleados: Set<legajo>, regresos: Set<legajo> }
// -- quienes estan adentro de una campaña ese dia, y quienes vuelven ese dia
// despues de la hora de corte (campanaService.empleadosEnCampanaElDia).
// null = la empresa no interpreta campañas (modo 'ignorar'): nada cambia.
// opciones.umbralFueraDeHorario: minutos del aviso "Fuera de su horario"
// (ver fueraDeHorario.js); null/undefined = no se evalua.
function buildAttendance(usersMap, checkins, exclusions, schedule, assignedScheduleMap, tenantScheduleMap, holidayRows, leaveEvents = [], assignedScheduleMapYesterday = null, tenantScheduleMapYesterday = null, campana = null, opciones = {}) {
  checkins.forEach(c => {
    const entry = usersMap.get(String(c.employeeId));
    if (entry) {
      entry.checkins.push(c.CHECKTIME);
    }
  });

  return Array.from(usersMap.values()).map(u => {
    const exclusion = exclusions.find(e => e.userId === u.userId);
    const leaveEvent = leaveEvents.find(ev => String(ev.legajo) === String(u.employeeId));
    const yesterdaySchedule = getScheduleEntryOrNull(assignedScheduleMapYesterday, tenantScheduleMapYesterday, u.employeeId, u.tenantId);
    const { checks: checksSinCarryover } = stripOvernightCarryover(u.checkins, yesterdaySchedule);
    const checkinsSorted = checksSinCarryover.slice().sort();
    const firstCheckin = checkinsSorted[0] || null;
    const lastCheckin = checkinsSorted[checkinsSorted.length - 1] || null;

    const userSchedule = getScheduleEntry(schedule, assignedScheduleMap, tenantScheduleMap, u.employeeId, u.tenantId);
    const entranceRef = getEntranceReference(userSchedule);
    const entranceMinutes = Number(entranceRef.split(':')[0]) * 60 + Number(entranceRef.split(':')[1]);
    const toleranceMin = resolveToleranceMinutes(userSchedule);
    // Turno partido / visitas multiples (profesor, medico que va varias
    // veces por dia): solo cuando la plantilla tiene MAS de un bloque WORK
    // para este dia -- el caso de un solo bloque sigue exactamente igual que
    // siempre (ver evaluateMultiVisitDay en attendanceCalculations.js).
    const workBlocks = (userSchedule.blocks || []).filter(b => b.block_type === 'WORK');

    // Feriado por ciudad (Fase 21): un feriado sin ciudad_id aplica a todo
    // el mundo (comportamiento historico); uno con ciudad_id solo pesa para
    // los empleados de ESA ciudad -- un sereno de otra ciudad ese mismo dia
    // tiene un dia normal, ni WorkedHoliday ni HolidayAbsent.
    const isHoliday = (holidayRows || []).some(h => isNonWorkHoliday(h) && holidayAppliesToEmployee(h, u.ciudadId));

    let status = 'Absent';
    let multiVisit = null;
    // Pedido real: un empleado inactivo (baja no cargada formalmente, ya no
    // trabaja acá) fichando SI es una señal real a revisar -- se mantiene el
    // status normal (a horario/tarde/etc.) pero se marca con un aviso en vez
    // de agregar un status nuevo que oculte la info real de esa marcación.
    let inactiveWarning = false;
    // Para el aviso de licencia/excepcion (resolverAvisoLicencia): si llego
    // tarde, lo calcula la rama de un solo bloque de mas abajo.
    let llegoTarde = false;
    // Dia de regreso de campaña habiendo vuelto a la hora de corte o despues
    // (ver campanaService.diasDeCampana): su fichaje es el regreso del campo,
    // no una entrada a la jornada -- no se evalua tardanza. Solo en un dia
    // habil y no feriado: esos siguen su propia regla de siempre.
    const esRegresoDeCampana = checkinsSorted.length > 0 && !isHoliday && !!userSchedule.isWorkDay
      && !!campana && campana.regresos.has(String(u.employeeId));
    if (esRegresoDeCampana) {
      status = 'Campaign';
    } else if (checkinsSorted.length > 0) {
      if (workBlocks.length > 1) {
        multiVisit = evaluateMultiVisitDay({
          workBlocks,
          checkinsSorted,
          toleranceMinutes: toleranceMin,
          exclusion
        });
        status = multiVisit.isPartial
          ? 'PartialAbsence'
          : (!multiVisit.isLate ? 'OnTime' : (multiVisit.justified ? 'LateJustified' : 'Late'));
      } else {
        const firstTime = firstCheckin.split(' ')[1].substring(0, 5);
        const [h, m] = firstTime.split(':').map(Number);
        const firstMinutes = h * 60 + m;

        const { isLate, justified } = resolveLateJustification({
          firstMinutes,
          entranceMinutes,
          toleranceMinutes: toleranceMin,
          exclusion
        });
        status = !isLate ? 'OnTime' : (justified ? 'LateJustified' : 'Late');
        llegoTarde = isLate;
      }
      if (isHoliday) {
        status = 'WorkedHoliday';
      }
      if (!u.active) {
        inactiveWarning = true;
      }
    } else if (isHoliday) {
      // Bug real reportado: sin esta rama, un feriado sin fichajes caia
      // directo al 'Absent' inicial de la linea 131 -- isHoliday recien se
      // consultaba DENTRO del bloque "hubo fichajes" (para marcar
      // 'WorkedHoliday'), nunca en el caso "no hubo fichajes". Mismo
      // criterio de prioridad que ya usan /attendance-range y el motor
      // legacy de un solo dia (feriado antes que exclusion/licencia/
      // inactivo): un feriado de toda la empresa pesa mas que cualquier
      // otro motivo individual.
      status = 'HolidayAbsent';
    } else if (!userSchedule.isWorkDay) {
      // Bug real reportado (sabado 26/09/2026: "habia muchos ausentes que en
      // realidad no estaban ausentes"): sin esta rama, un dia que segun la
      // plantilla del empleado NO es laborable caia en el 'Absent' inicial.
      //
      // Ausente tiene que significar una sola cosa: tenia que venir y no
      // vino. Un sabado para alguien que trabaja de lunes a viernes no es
      // una ausencia, es un dia que no le tocaba -- contarlo como falta
      // ensucia el numero justo cuando mas se lo mira, y obliga a quien lee
      // el informe a descartar a mano los que no correspondian.
      //
      // Mismo criterio y mismo orden que /attendance-range (ver
      // horasdedica.js: `if (!isWorkDay && !holidayNonWorkApplies)`), que ya
      // lo resolvia bien -- por eso el calendario mensual y el PDF salian
      // correctos y solo fallaba esta pantalla. El feriado se evalua ANTES,
      // a proposito: un feriado pesa mas que el dia de la semana.
      //
      // El motivo de una licencia que caiga en este dia no se pierde: viaja
      // aparte en el campo `leave` del return, mas abajo.
      status = 'NonWorkDay';
    } else if (exclusion || leaveEvent) {
      status = 'Excused';
    } else if (campana && campana.empleados.has(String(u.employeeId))) {
      // Dia habil sin fichaje, adentro de una campaña (bug real: OLGUIN,
      // 23/09/2026, "Ausente" en la vista diaria estando en el campo). Mismo
      // lugar en la cadena que en /attendance-range: despues de la licencia
      // (una carga humana gana sobre la deteccion automatica) y antes de
      // inactivo. Como cuenta lo decide la empresa -- ver buildSummary.
      status = 'Campaign';
    } else if (!u.active) {
      // Inactivo y SIN fichaje -- no corresponde contarlo como ausente (ya
      // no trabaja acá, no es una ausencia real). buildSummary no cuenta
      // este status en ningún bucket -- queda afuera de "absent" sin tener
      // que filtrar la fila entera (sigue visible, solo que no cuenta).
      status = 'Inactive';
    }

    return {
      employeeId: u.employeeId,
      userId: u.userId,
      badgeNumber: u.badgeNumber,
      leave: leaveEvent ? {
        eventTypeCode: leaveEvent.eventTypeCode || null,
        eventTypeDescripcion: leaveEvent.eventTypeDescripcion || null,
        observaciones: leaveEvent.observaciones || null
      } : null,
      name: u.name,
      status,
      campaignCountsAs: status === 'Campaign' ? campana.modo : undefined,
      campaignMoment: esRegresoDeCampana ? 'regreso' : undefined,
      inactiveWarning,
      // Pedido real: alguien con una licencia cargada (vacaciones, enfermedad,
      // comision...) que igual ficho. El fichaje es un hecho y manda: el dia
      // sigue siendo presente/tarde como siempre. Pero una de las dos cosas
      // esta mal -- la licencia o el fichaje -- y alguien tiene que
      // corregirla: se avisa, no se decide solo. Mismo criterio que
      // inactiveWarning. Solo licencias (employee_events): una excepcion
      // (userexclusions) con fichaje es normal, se usa para justificar una
      // tardanza.
      //
      // Desde el 2026-09-28 tambien una EXCEPCION (userexclusions) que no
      // justifico nada: ver resolverAvisoLicencia en attendanceCalculations.js.
      leaveConflict: resolverAvisoLicencia({
        leaveEvent,
        // El dia de regreso de campaña no se evalua como jornada: una
        // excepcion ahi no se puede juzgar con la regla de horario.
        exclusion: status === 'Campaign' ? null : exclusion,
        totalCheckins: checkinsSorted.length,
        isLate: llegoTarde,
        isPartial: status === 'PartialAbsence',
        multiVisit: !!multiVisit,
        lastMinutes: lastCheckin ? timeToMinutes(lastCheckin.split(' ')[1].substring(0, 5)) : null,
        exitMinutes: userSchedule.timeExit ? timeToMinutes(String(userSchedule.timeExit).substring(0, 5)) : null,
        toleranceMinutes: toleranceMin,
      }),
      // Aviso, no cambia el estado: los fichajes no coinciden con su
      // plantilla (rotativo mal cargado, salida al campo de madrugada...).
      // No aplica al regreso de campaña ni a un inactivo (ese ya tiene su
      // propio aviso).
      fueraDeHorario: (status === 'Campaign' || !u.active) ? null : evaluarFueraDeHorario({
        fichajes: checkinsSorted,
        esDiaDeTrabajo: !!Number(userSchedule.isWorkDay),
        esFeriado: isHoliday,
        entrada: userSchedule.timeEntrance,
        salida: userSchedule.timeExit,
        cruzaMedianoche: (userSchedule.blocks || []).some((b) => Number(b.crosses_midnight) === 1),
        plantilla: userSchedule.template ? userSchedule.template.name : null,
        umbralMinutos: opciones.umbralFueraDeHorario ?? null,
      }),
      firstCheckin,
      lastCheckin,
      totalCheckins: checkinsSorted.length,
      checkins: checkinsSorted,
      visits: multiVisit ? multiVisit.visits : null,
      exclusion: exclusion || null,
      assigned: !!(assignedScheduleMap && assignedScheduleMap[u.employeeId]),
      schedule: {
        source: userSchedule.source,
        templateId: userSchedule.templateId || null,
        tenantId: userSchedule.tenantId || null,
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
    lateJustified: attendance.filter(a => a.status === 'LateJustified').length,
    absent: attendance.filter(a => a.status === 'Absent').length,
    // Un dia en campaña contado como 'excusado' suma aca, igual que en
    // /attendance-range. Contado como 'trabajado' no entra en ninguno de los
    // contadores de puntualidad (no ficho: no fue ni a tiempo ni tarde);
    // queda en `campaign`.
    excused: attendance.filter(a => a.status === 'Excused' || (a.status === 'Campaign' && a.campaignCountsAs === 'excusado')).length,
    campaign: attendance.filter(a => a.status === 'Campaign').length,
    // Fichó teniendo una licencia cargada -- a revisar (ver leaveConflict).
    leaveConflicts: attendance.filter(a => a.leaveConflict).length,
    // Solo aplica a empleados con turno partido (mas de un bloque WORK por
    // dia) -- faltó marcar entrada y/o salida de alguna de sus visitas, pero
    // no de todas (si no, ya cuenta como Absent). Ver evaluateMultiVisitDay.
    partialAbsence: attendance.filter(a => a.status === 'PartialAbsence').length,
    // Aviso: fichajes que no coinciden con su plantilla (fueraDeHorario.js).
    fueraDeHorario: attendance.filter(a => a.fueraDeHorario).length,
    total: attendance.length
  };
}

async function calculateDailyAttendance({ date, tenantId, templateId, repositories, umbralFueraDeHorario = null }) {
  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    throw new Error('Fecha inválida');
  }

  let tenantScheduleRows;
  if (templateId !== undefined && templateId !== null && templateId !== '') {
    tenantScheduleRows = await repositories.schedule.findByTemplateId(normalizedDate, Number(templateId));
  } else {
    tenantScheduleRows = await repositories.schedule.findByDate(normalizedDate, tenantId);
  }
  const tenantSchedule = Array.isArray(tenantScheduleRows) ? tenantScheduleRows[0] : tenantScheduleRows;

  const schedule = tenantSchedule && (tenantSchedule.source === 'new' || tenantSchedule.source === 'motor')
    ? buildMotorSchedule({ date: normalizedDate, tenantSchedule })
    : buildLegacySchedule({ date: normalizedDate, tenantSchedule });

  const holidayRows = await repositories.holiday.findByDate(normalizedDate, tenantId);
  // Solo un feriado SIN ciudad (toda la empresa) apaga el dia a nivel
  // "schedule" general -- uno acotado a una ciudad no debe marcar el dia
  // entero como no laborable para las demas ciudades. El chequeo por
  // empleado (WorkedHoliday/HolidayAbsent) se hace mas abajo, en
  // buildAttendance, con holidayRows completo.
  const companyWideHoliday = Array.isArray(holidayRows)
    ? holidayRows.some(h => isNonWorkHoliday(h) && h.ciudad_id == null)
    : false;

  if (companyWideHoliday) {
    schedule.isWorkDay = false;
  }

  const rawUsers = await repositories.user.findAll({ tenantId });
  const checkins = await repositories.checkin.findByDate(normalizedDate, tenantId);
  const exclusions = await repositories.exclusion.findByDate(normalizedDate, tenantId);
  const leaveEvents = await repositories.employeeEvent.findByDate(normalizedDate, tenantId);

  const usersMap = new Map();
  const tenantIds = new Set();
  rawUsers.forEach(u => {
    usersMap.set(String(u.employeeId), {
      employeeId: u.employeeId,
      userId: u.USERID || null,
      badgeNumber: u.Badgenumber || null,
      name: u.Name,
      tenantId: u.tenantId != null ? u.tenantId : null,
      ciudadId: u.ciudadId != null ? u.ciudadId : null,
      // Pedido real: un empleado inactivo (dado de baja, ya no trabaja acá)
      // no debe figurar como "Ausente" solo por no fichar -- eso es
      // esperable, no una ausencia real a revisar. Default activo=true si
      // viniera undefined/null (mismo criterio que overtimeAuthorized).
      active: u.activo === undefined || u.activo === null ? true : !!Number(u.activo),
      checkins: []
    });
    if (u.tenantId != null) {
      tenantIds.add(Number(u.tenantId));
    }
  });

  // .filter(!isNaN) -- si un empleado tiene employee_id nulo/vacio (fila mal
  // cargada, import a medio terminar), Number(id) da NaN y MySQL tira
  // "Unknown column 'NaN'" al armar el IN (?), tumbando el motor diario
  // ENTERO para todos los empleados por culpa de uno solo. Mismo filtro que
  // ya tiene /attendance-range (horasdedica2.js) para este mismo campo.
  const employeeIds = Array.from(usersMap.keys()).map(id => Number(id)).filter(id => !Number.isNaN(id));
  const assignedScheduleMap = await repositories.schedule.findAssignedScheduleMapForDate(normalizedDate, employeeIds, tenantId);

  const tenantScheduleMap = {};
  if (!templateId) {
    for (const tid of tenantIds) {
      const rows = await repositories.schedule.findByDate(normalizedDate, tid);
      const tenantSchedule = Array.isArray(rows) ? rows[0] : rows;
      if (tenantSchedule) {
        tenantScheduleMap[tid] = tenantSchedule.source === 'new' || tenantSchedule.source === 'motor'
          ? buildMotorSchedule({ date: normalizedDate, tenantSchedule })
          : buildLegacySchedule({ date: normalizedDate, tenantSchedule });
      }
    }
  }

  // Turnos que cruzan medianoche ("sereno"): solo hace falta el SCHEDULE de
  // ayer (para saber si cruzaba medianoche), no sus fichajes -- ver
  // getScheduleEntryOrNull/buildAttendance mas arriba. Mismo patron que
  // assignedScheduleMap/tenantScheduleMap de arriba, para el dia anterior.
  const yesterdayStr = previousDayStr(normalizedDate);
  const assignedScheduleMapYesterday = await repositories.schedule.findAssignedScheduleMapForDate(yesterdayStr, employeeIds, tenantId);
  const tenantScheduleMapYesterday = {};
  if (!templateId) {
    for (const tid of tenantIds) {
      const rows = await repositories.schedule.findByDate(yesterdayStr, tid);
      const tenantScheduleYesterday = Array.isArray(rows) ? rows[0] : rows;
      if (tenantScheduleYesterday) {
        tenantScheduleMapYesterday[tid] = tenantScheduleYesterday.source === 'new' || tenantScheduleYesterday.source === 'motor'
          ? buildMotorSchedule({ date: yesterdayStr, tenantSchedule: tenantScheduleYesterday })
          : buildLegacySchedule({ date: yesterdayStr, tenantSchedule: tenantScheduleYesterday });
      }
    }
  }

  // Campañas (ver campanaService.empleadosEnCampanaElDia): null si la empresa
  // no las interpreta. `repositories.campana` es opcional para no obligar a
  // cada llamador (tests con repositorios armados a mano) a proveerlo.
  const campana = repositories.campana
    ? await repositories.campana.empleadosEnCampanaElDia(normalizedDate, tenantId)
    : null;

  const attendance = buildAttendance(usersMap, checkins, exclusions, schedule, assignedScheduleMap, tenantScheduleMap, holidayRows, leaveEvents, assignedScheduleMapYesterday, tenantScheduleMapYesterday, campana, { umbralFueraDeHorario });
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

// Bug real encontrado en la re-auditoria de venta (Fase 19): esta funcion
// (el modo "Legacy" de Presentismo, para comparar contra el Motor
// Laboral) no recibia tenantId en absoluto -- ni filtraba employees por
// empresa, ni filtraba userexclusions -- devolvia SIEMPRE la asistencia de
// TODAS las empresas mezcladas, sin importar quien la pidiera. El llamador
// (motor-laboral/routes/attendance.js, /attendance/:date/compare) ya
// resuelve tenantId para el modo Motor -- ahora se lo pasa tambien aca.
async function calculateLegacyAttendance({ date, db, tenantId }) {
  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    throw new Error('Fecha inválida');
  }

  // Solo el horario de la empresa (antes leia el de cualquiera).
  // AISLAMIENTO_POR_EMPRESA.md, C.
  const [dayConfig] = tenantId !== undefined && tenantId !== null
    ? await db.query(`SELECT * FROM companyschedule WHERE scheduleDate = ? AND tenant_id = ?`, [normalizedDate, tenantId])
    : await db.query(`SELECT * FROM companyschedule WHERE scheduleDate = ?`, [normalizedDate]);

  const config = dayConfig[0] || {
    timeEntrance: '07:00:00',
    timeExit: '13:40:00',
    isWorkDay: isDefaultWorkday(normalizedDate)
  };

  // Bug real (Fase 21, mismo hallazgo que ya se corrigio en holidayRepository
  // para el motor diario): esta consulta nunca filtraba por tenant_id -- una
  // empresa veia el feriado de otra.
  // Aislamiento por empresa (2026-10-06, AISLAMIENTO_POR_EMPRESA.md letra B):
  // solo los feriados de la empresa. Antes tambien entraban los "globales"
  // (tenant_id NULL), que en la practica eran feriados de AVP cargados sin
  // empresa (ej. "Dia de Rawson"): se aplicaban a CUALQUIER empresa y la
  // pantalla de Feriados ni siquiera los mostraba.
  const holidayParams = [normalizedDate, normalizedDate];
  let holidayTenantClause = '';
  if (tenantId !== undefined && tenantId !== null) {
    holidayTenantClause = ' AND tenant_id = ?';
    holidayParams.push(tenantId);
  }
  const [holidayRows] = await db.query(
    `SELECT * FROM holidays
     WHERE (date = ? OR (recurring = 1 AND DATE_FORMAT(date, '%m-%d') = DATE_FORMAT(?, '%m-%d')))${holidayTenantClause}`,
    holidayParams
  );

  // Solo un feriado SIN ciudad (toda la empresa) corta temprano con el dia
  // entero no laborable, exactamente como siempre. Uno acotado a una ciudad
  // no apaga el dia para todos -- se evalua por empleado mas abajo.
  const companyWideHolidayOff = holidayRows.some(h => isNonWorkHoliday(h) && h.ciudad_id == null);
  if (companyWideHolidayOff) {
    config.isWorkDay = false;
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

  const exclusionsParams = [normalizedDate];
  let exclusionsQuery = `SELECT * FROM userexclusions WHERE excDate = ?`;
  if (tenantId !== undefined && tenantId !== null) {
    exclusionsQuery += ` AND tenant_id = ?`;
    exclusionsParams.push(tenantId);
  }
  const [exclusions] = await db.query(exclusionsQuery, exclusionsParams);

  const rowsParams = [normalizedDate, nextDayStr(normalizedDate)];
  let rowsQuery = `
      SELECT
        e.employee_id,
        e.nombre,
        e.ciudad_id,
        u.USERID,
        u.Badgenumber,
        u.Name,
        c.CHECKTIME
      FROM employees e

      LEFT JOIN user_employee_map ue
        ON ue.employee_id = e.id

      LEFT JOIN users u
        ON u.USERID = ue.USERID AND u.tenant_id = ue.tenant_id

      LEFT JOIN Checkins c
        ON c.USERID = u.USERID AND c.tenant_id = u.tenant_id
        AND c.CHECKTIME >= ? AND c.CHECKTIME < ?

      WHERE (e.exclude_from_report = 0 OR e.exclude_from_report IS NULL)`;

  if (tenantId !== undefined && tenantId !== null) {
    rowsQuery += ` AND e.tenant_id = ?`;
    rowsParams.push(tenantId);
  }

  rowsQuery += ` ORDER BY e.nombre, c.CHECKTIME`;

  const [rows] = await db.query(rowsQuery, rowsParams);

  const map = {};
  rows.forEach(r => {
    if (!map[r.employee_id]) {
      map[r.employee_id] = {
        userId: r.USERID,
        badgeNumber: r.Badgenumber,
        name: r.nombre,
        ciudadId: r.ciudad_id != null ? r.ciudad_id : null,
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
    // Feriado acotado a una ciudad (companyWideHolidayOff ya se manejo arriba
    // con el corte temprano de todo el dia): solo pesa para los empleados de
    // ESA ciudad. Misma prioridad que el motor diario -- un feriado pesa mas
    // que una exclusion individual.
    const isHolidayForEmployee = holidayRows.some(h => isNonWorkHoliday(h) && holidayAppliesToEmployee(h, u.ciudadId));

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

    // Feriado acotado a una ciudad (el caso sin ciudad ya se resolvio arriba
    // con el corte temprano de todo el dia): pesa mas que cualquier otro
    // motivo individual, exclusion incluida -- mismo criterio que el motor
    // diario ("un feriado pesa mas que cualquier otro motivo individual").
    if (isHolidayForEmployee) {
      status = checkins.length > 0 ? 'WorkedHoliday' : 'HolidayAbsent';
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
