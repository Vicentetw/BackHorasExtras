// Cupo por motivo -- lectura de datos para el calculo puro de
// motor-laboral/services/cupoMotivos.js. Ver migracion 20261005.
const { periodoAnual, cupoVigente, calcularConsumo, evaluarCupo } = require('../services/cupoMotivos');
const { findVigenciasParaCalculo, findFeriadosEnRango } = require('./eventTypeCountModeRepository');

const PERIODOS = ['calendario', 'aniversario'];
const ACCIONES = ['avisar', 'bloquear'];

async function findCupos(eventTypeId, db) {
  const [rows] = await db.query(
    `SELECT q.id, q.event_type_id, q.max_dias_anio, q.max_dias_mes, q.periodo, q.al_exceder,
            q.vigente_desde, q.created_at, au.email AS created_by_email
     FROM event_type_quotas q
     LEFT JOIN app_users au ON au.id = q.created_by
     WHERE q.event_type_id = ?
     ORDER BY q.vigente_desde DESC`,
    [eventTypeId]
  ).catch((err) => {
    // Backend publicado antes que la migracion 20261005: sin cupos, como antes.
    if (err && err.code === 'ER_NO_SUCH_TABLE') return [[]];
    throw err;
  });
  return rows;
}

async function createCupo({ tenantId, eventTypeId, maxDiasAnio, maxDiasMes, periodo, alExceder, vigenteDesde, createdBy }, db) {
  const [r] = await db.query(
    `INSERT INTO event_type_quotas
       (tenant_id, event_type_id, max_dias_anio, max_dias_mes, periodo, al_exceder, vigente_desde, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, eventTypeId, maxDiasAnio, maxDiasMes, periodo, alExceder, vigenteDesde, createdBy ?? null]
  );
  return r.insertId;
}

// Empleado (id interno de employees) y los numeros con que puede aparecer en
// Checkins: su USERID de reloj y su Badgenumber (hay relojes que graban uno y
// relojes que graban el otro -- ver campanaService.fetchMovementCheckins).
async function datosDelEmpleado(db, tenantId, employeeInternalId) {
  const [[emp]] = await db.query(
    'SELECT id, employee_id AS legajo, tenant_id, fecha_alta FROM employees WHERE id = ? AND tenant_id = ?',
    [employeeInternalId, tenantId]
  );
  if (!emp) return null;
  const [users] = await db.query(
    `SELECT u.USERID, u.Badgenumber FROM user_employee_map m
     JOIN users u ON u.USERID = m.USERID AND u.tenant_id = m.tenant_id
     WHERE m.employee_id = ? AND m.tenant_id = ?`,
    [employeeInternalId, tenantId]
  );
  const userIds = users.map((u) => u.USERID);
  const numerosEnReloj = [...new Set([
    ...userIds,
    ...users.map((u) => Number(u.Badgenumber)).filter(Number.isInteger),
  ])];
  return { ...emp, userIds, numerosEnReloj };
}

// De USERID de reloj (lo que usan las justificaciones) al id interno del
// empleado (lo que usan las licencias).
async function empleadoDeUserId(db, tenantId, userId) {
  const [[row]] = await db.query(
    'SELECT employee_id FROM user_employee_map WHERE USERID = ? AND tenant_id = ?',
    [userId, tenantId]
  );
  return row ? row.employee_id : null;
}

/**
 * Consumo de un motivo por un empleado, y si una carga nueva se pasaria del
 * cupo. Punto unico para la pantalla (preview) y para los POST que cargan
 * licencias y justificaciones: el numero que se ve es el que se valida.
 *
 * @returns {Promise<null | {cupo, periodo, usados, usadosConNuevo, porMes, excesos, accion, detalle}>}
 *   null si el empleado no es de la empresa.
 */
async function consumoDeEmpleado(db, {
  tenantId, employeeInternalId, eventTypeId, fecha, nuevo = null,
  excluirLicenciaId = null, excluirJustificacionIds = [],
}) {
  const emp = await datosDelEmpleado(db, tenantId, employeeInternalId);
  if (!emp) return null;

  const referencia = nuevo ? nuevo.desde : fecha;
  const cupos = await findCupos(eventTypeId, db);
  const cupo = cupoVigente(referencia, cupos);
  const periodo = periodoAnual(referencia, cupo ? cupo.periodo : 'calendario', emp.fecha_alta);

  const [licencias] = await db.query(
    `SELECT id, fecha_desde, fecha_hasta FROM employee_events
     WHERE employee_id = ? AND event_type_id = ? AND fecha_desde <= ? AND fecha_hasta >= ?`,
    [emp.id, eventTypeId, periodo.hasta, periodo.desde]
  );
  let justificaciones = [];
  if (emp.userIds.length) {
    [justificaciones] = await db.query(
      `SELECT id, excDate FROM userexclusions
       WHERE tenant_id = ? AND userId IN (?) AND event_type_id = ? AND type = 'FULL_DAY'
         AND excDate BETWEEN ? AND ?`,
      [tenantId, emp.userIds, eventTypeId, periodo.desde, periodo.hasta]
    );
  }
  const diasFichados = new Set();
  if (emp.numerosEnReloj.length) {
    const [fichados] = await db.query(
      `SELECT DISTINCT DATE_FORMAT(CHECKTIME, '%Y-%m-%d') AS d FROM Checkins
       WHERE tenant_id = ? AND USERID IN (?) AND CHECKTIME >= ? AND CHECKTIME < DATE_ADD(?, INTERVAL 1 DAY)`,
      [tenantId, emp.numerosEnReloj, periodo.desde, periodo.hasta]
    );
    fichados.forEach((f) => diasFichados.add(f.d));
  }
  const [vigenciasModo, feriados] = await Promise.all([
    findVigenciasParaCalculo(eventTypeId, db),
    findFeriadosEnRango(periodo.desde, periodo.hasta, db),
  ]);

  const excluidas = new Set((excluirJustificacionIds || []).map(Number));
  const consumo = calcularConsumo({
    periodo,
    licencias: licencias.filter((l) => l.id !== Number(excluirLicenciaId)),
    justificaciones: justificaciones.filter((j) => !excluidas.has(j.id)).map((j) => j.excDate),
    diasFichados,
    vigenciasModo,
    feriados,
    nuevo,
  });
  const excesos = nuevo ? evaluarCupo(cupo, consumo) : [];
  return {
    cupo: cupo ? {
      maxDiasAnio: cupo.max_dias_anio, maxDiasMes: cupo.max_dias_mes,
      periodo: cupo.periodo, alExceder: cupo.al_exceder, vigenteDesde: cupo.vigente_desde,
    } : null,
    periodo,
    usados: consumo.usados,
    usadosConNuevo: consumo.usadosConNuevo,
    porMes: consumo.porMes,
    excesos,
    accion: excesos.length ? cupo.al_exceder : null,
    detalle: consumo.detalle,
  };
}

/**
 * Validacion de una carga (licencia o justificacion de dia completo) contra el
 * cupo de su motivo. La usan los POST/PUT: si el motivo esta en 'bloquear' y
 * la carga lo pasa, el endpoint responde 409; si esta en 'avisar', guarda y
 * devuelve los excesos para que la pantalla los muestre.
 * @returns {Promise<{bloquear:boolean, excesos:string[], mensaje:string|null}>}
 */
async function verificarCarga(db, { employeeInternalId, eventTypeId, desde, hasta, excluirLicenciaId = null, excluirJustificacionIds = [] }) {
  const nada = { bloquear: false, excesos: [], mensaje: null };
  if (!employeeInternalId || !eventTypeId || !desde || !hasta) return nada;
  const [[et]] = await db.query('SELECT tenant_id, descripcion FROM event_types WHERE id = ?', [eventTypeId]);
  if (!et) return nada;
  const r = await consumoDeEmpleado(db, {
    tenantId: et.tenant_id, employeeInternalId, eventTypeId, fecha: desde,
    nuevo: { desde, hasta }, excluirLicenciaId, excluirJustificacionIds,
  });
  if (!r || !r.excesos.length) return nada;
  return {
    bloquear: r.accion === 'bloquear',
    excesos: r.excesos,
    mensaje: `${et.descripcion || 'El motivo'}: ${r.excesos.join('; ')}`,
  };
}

/**
 * Quienes de la empresa estan cerca o pasados del cupo de algun motivo, a una
 * fecha. Para los avisos de Presentismo ("Art. 55: 6 de 6").
 *
 * PENSADO PARA ESCALAR (20 empleados o 5000)
 * -------------------------------------------
 * La primera version calculaba persona por persona (consumoDeEmpleado): ~5
 * consultas por cada una. Con 5000 empleados y cientos de articulos 55
 * cargados eran miles de consultas por cada vista de Presentismo. Esta hace
 * ~5 consultas POR MOTIVO, sin importar cuanta gente haya: trae todo en
 * lote y reparte en memoria. La regla es la MISMA funcion pura
 * (calcularConsumo) que usa la pantalla de carga, asi que el numero del
 * aviso y el de "usados X de N" no pueden diferir (lo verifica
 * test/avisos-asistencia.test.js, y se comparo contra la version anterior
 * persona por persona con 300 empleados sinteticos: resultados identicos).
 *
 * Solo se mira a quien tiene algo cargado de un motivo con cupo: el resto
 * esta en 0 y no puede generar aviso.
 *
 * @param {number|null} porcentaje  desde que % del tope se avisa "por agotarse" (ej. 80)
 */
async function estadoCuposEmpresa(db, tenantId, fecha, porcentaje = 80) {
  let cuposRows = [];
  try {
    [cuposRows] = await db.query(
      `SELECT q.*, et.descripcion FROM event_type_quotas q JOIN event_types et ON et.id = q.event_type_id
       WHERE q.tenant_id = ?`,
      [tenantId]
    );
  } catch (err) {
    if (!err || err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  const porMotivo = new Map();
  cuposRows.forEach((c) => {
    if (!porMotivo.has(c.event_type_id)) porMotivo.set(c.event_type_id, []);
    porMotivo.get(c.event_type_id).push(c);
  });

  // Ventana que contiene cualquier periodo anual que incluya `fecha`
  // (calendario o aniversario): un año antes y un año despues.
  const [fy, fm, fd] = fecha.split('-').map(Number);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ventana = { desde: iso(new Date(fy - 1, fm - 1, fd)), hasta: iso(new Date(fy + 1, fm - 1, fd)) };

  const filas = [];
  for (const [eventTypeId, cupos] of porMotivo) {
    const cupo = cupoVigente(fecha, cupos);
    if (!cupo || cupo.max_dias_anio == null) continue;

    // 1. Licencias del motivo en la ventana (de toda la empresa).
    const [licencias] = await db.query(
      `SELECT ee.employee_id, ee.fecha_desde, ee.fecha_hasta FROM employee_events ee
       JOIN employees e ON e.id = ee.employee_id
       WHERE e.tenant_id = ? AND e.activo = 1 AND ee.event_type_id = ?
         AND ee.fecha_desde <= ? AND ee.fecha_hasta >= ?`,
      [tenantId, eventTypeId, ventana.hasta, ventana.desde]
    );
    // 2. Justificaciones de dia completo del motivo en la ventana, ya con su empleado.
    const [justif] = await db.query(
      `SELECT m.employee_id, ux.excDate FROM userexclusions ux
       JOIN user_employee_map m ON m.USERID = ux.userId AND m.tenant_id = ux.tenant_id
       JOIN employees e ON e.id = m.employee_id
       WHERE ux.tenant_id = ? AND e.activo = 1 AND ux.event_type_id = ? AND ux.type = 'FULL_DAY'
         AND ux.excDate BETWEEN ? AND ?`,
      [tenantId, eventTypeId, ventana.desde, ventana.hasta]
    );
    const candidatos = [...new Set([...licencias.map((l) => l.employee_id), ...justif.map((j) => j.employee_id)])];
    if (!candidatos.length) continue;

    // 3. Datos de los candidatos y los numeros con que aparecen en el reloj.
    const [emps] = await db.query(
      'SELECT id, employee_id, fecha_alta FROM employees WHERE tenant_id = ? AND id IN (?)',
      [tenantId, candidatos]
    );
    const [users] = await db.query(
      `SELECT m.employee_id, u.USERID, u.Badgenumber FROM user_employee_map m
       JOIN users u ON u.USERID = m.USERID AND u.tenant_id = m.tenant_id
       WHERE m.tenant_id = ? AND m.employee_id IN (?)`,
      [tenantId, candidatos]
    );
    const empleadoDeNumero = new Map(); // numero en el reloj -> id interno
    users.forEach((u) => {
      empleadoDeNumero.set(Number(u.USERID), u.employee_id);
      const b = Number(u.Badgenumber);
      if (Number.isInteger(b) && !empleadoDeNumero.has(b)) empleadoDeNumero.set(b, u.employee_id);
    });

    // 4. Dias fichados de los candidatos, en una sola consulta (usa el indice
    //    uq_checkin: tenant_id, USERID, CHECKTIME).
    const diasFichados = new Map(); // id interno -> Set de fechas
    if (empleadoDeNumero.size) {
      const [fichados] = await db.query(
        `SELECT USERID, DATE_FORMAT(CHECKTIME, '%Y-%m-%d') AS d FROM Checkins
         WHERE tenant_id = ? AND USERID IN (?) AND CHECKTIME >= ? AND CHECKTIME < DATE_ADD(?, INTERVAL 1 DAY)
         GROUP BY USERID, d`,
        [tenantId, [...empleadoDeNumero.keys()], ventana.desde, ventana.hasta]
      );
      fichados.forEach((f) => {
        const id = empleadoDeNumero.get(Number(f.USERID));
        if (!diasFichados.has(id)) diasFichados.set(id, new Set());
        diasFichados.get(id).add(f.d);
      });
    }

    // 5. Modalidad y feriados: una vez por motivo.
    const [vigenciasModo, feriados] = await Promise.all([
      findVigenciasParaCalculo(eventTypeId, db),
      findFeriadosEnRango(ventana.desde, ventana.hasta, db),
    ]);

    for (const emp of emps) {
      const periodo = periodoAnual(fecha, cupo.periodo, emp.fecha_alta);
      const consumo = calcularConsumo({
        periodo,
        licencias: licencias.filter((l) => l.employee_id === emp.id),
        justificaciones: justif.filter((j) => j.employee_id === emp.id).map((j) => j.excDate),
        diasFichados: diasFichados.get(emp.id) || new Set(),
        vigenciasModo,
        feriados,
      });
      const max = cupo.max_dias_anio;
      let estado = null;
      if (consumo.usados > max) estado = 'superado';
      else if (consumo.usados === max) estado = 'agotado';
      else if (porcentaje != null && max > 0 && consumo.usados * 100 >= max * porcentaje) estado = 'por_agotarse';
      if (!estado) continue;
      filas.push({
        employeeId: String(emp.employee_id), eventTypeId, motivo: cupo.descripcion,
        usados: consumo.usados, max, estado, periodo,
      });
    }
  }
  return filas;
}

module.exports = {
  PERIODOS, ACCIONES, findCupos, createCupo, consumoDeEmpleado, empleadoDeUserId, verificarCarga, estadoCuposEmpresa,
};
