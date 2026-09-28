// Bug real reportado (empresa AVP, sabado 26/09/2026): en el Presentismo
// DIARIO aparecian "muchos ausentes que en realidad no estaban ausentes",
// porque segun su plantilla de horario el sabado y el domingo no trabajan.
//
// Causa raiz: motor-laboral/services/attendanceService.js -> buildAttendance()
// arranca con status = 'Absent' y solo lo cambia si hubo fichajes, si es
// feriado, si hay licencia/exclusion, o si el empleado esta inactivo. No
// existia ninguna rama para "este dia NO es laborable segun su plantilla",
// asi que todos los que no tenian jornada ese dia caian en Absent.
//
// Es exactamente el mismo tipo de bug que ya se habia corregido para los
// feriados (ver holiday-absent-daily-motor.test.js): la rama faltaba en el
// bloque "no hubo fichajes". /attendance-range (el mensual, el calendario y
// el PDF) SI lo resolvia bien con el status 'NonWorkDay' -- por eso el
// usuario veia el informe impreso correcto y la pantalla mal.
//
// Por que importa mas de lo que parece: "Ausente" tiene que significar una
// sola cosa -- tenia que venir y no vino. Si tambien significa "era sabado",
// el numero deja de servir para lo unico que se lo mira, y obliga a descartar
// a mano los que no correspondian.
//
// Requiere el backend local corriendo (puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-dia-no-laborable-daily-motor';
const TENANT = 999942;

// 2026-08-21 es VIERNES y 2026-08-22 es SABADO. El par importa: el mismo
// empleado, sin fichar ninguno de los dos dias, tiene que dar resultados
// DISTINTOS. Sin el viernes de control, un bug que devolviera 'NonWorkDay'
// siempre pasaria este test sin que nadie lo note.
const VIERNES = '2026-08-21';
const SABADO = '2026-08-22';

let headers;
let db;
let empleadoId, badge, userId, templateId;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306
  });

  // Se verifica que las fechas sean las que se cree. Un test construido sobre
  // una suposicion de calendario equivocada "pasa" sin probar nada.
  assert.equal(new Date(`${VIERNES}T12:00:00`).getDay(), 5, 'VIERNES tiene que ser viernes');
  assert.equal(new Date(`${SABADO}T12:00:00`).getDay(), 6, 'SABADO tiene que ser sabado');

  const seed = Date.now() % 1000000;
  badge = 930000 + (seed % 30000);
  userId = 930000 + ((seed + 1) % 30000);

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant No Laborable (test)', 'tenant-no-laborable-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT]);

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, '2020-01-01', 0)`,
    [badge, 'Administrativo Lunes a Viernes', TENANT]);
  empleadoId = empResult.insertId;

  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`,
    [userId, TENANT, String(badge), 'Administrativo Lunes a Viernes']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`,
    [userId, TENANT, empleadoId]);

  const [tplResult] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Lunes a Viernes (test)', 'FIXED', 1, 0)`,
    [TENANT]);
  templateId = tplResult.insertId;

  // SOLO lunes(1) a viernes(5). Sin bloques para sabado(6) ni domingo(0):
  // asi es como se configura de verdad un administrativo, y es lo que hace
  // que buildScheduleFromBlocks devuelva isWorkDay = 0 para el fin de semana
  // (`workBlocks.length > 0 ? 1 : 0`).
  for (let dow = 1; dow <= 5; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Administrativo', '08:00:00', '16:00:00', 'WORK', 0, 1)`,
      [templateId, dow]);
  }

  await db.query(
    `INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`,
    [empleadoId, TENANT, templateId]);
});

after(async () => {
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [empleadoId]);
  await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM users WHERE USERID = ?', [userId]);
  await db.query('DELETE FROM employees WHERE id = ?', [empleadoId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]).catch(() => {});
  await db.end();
  await deleteTestUser(TEST_UID);
  await closeDb();
});

async function traerDia(fecha) {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${fecha}?tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  return { body, fila: body.attendance.find(a => String(a.employeeId) === String(badge)) };
}

test('EL BUG: un sabado, quien trabaja de lunes a viernes NO es Ausente', async () => {
  const { fila } = await traerDia(SABADO);

  assert.ok(fila, 'el empleado tiene que aparecer igual en la grilla del dia');
  assert.equal(fila.status, 'NonWorkDay',
    'sin jornada asignada ese dia: no es una ausencia, es un dia que no le tocaba');
});

test('EL CONTRASTE: el viernes, sin fichar, SI es Ausente', async () => {
  // La otra mitad, y la que evita que el arreglo se pase de largo. Si todo
  // diera 'NonWorkDay', el test de arriba pasaria igual y habriamos tapado
  // las ausencias de verdad, que es peor que el bug original.
  const { fila } = await traerDia(VIERNES);

  assert.ok(fila);
  assert.equal(fila.status, 'Absent',
    'el viernes SI tenia que venir: esa ausencia tiene que seguir contandose');
});

test('el resumen del sabado no lo cuenta como ausente', async () => {
  // Es el numero que se mira de un vistazo, y el que el usuario vio inflado.
  const { body } = await traerDia(SABADO);
  const noLaborables = body.attendance.filter(a => a.status === 'NonWorkDay').length;

  assert.ok(noLaborables >= 1, 'tiene que haber al menos un dia no laborable');
  assert.equal(body.summary.absent, 0, 'el resumen del sabado no puede mostrar ausentes');
});

test('si igual ficho un sabado, se registra como trabajado (no se pierde)', async () => {
  // Trabajar un dia no laborable pasa de verdad (una urgencia, un refuerzo) y
  // es justo lo que hay que poder ver -- si el arreglo lo silenciara,
  // estariamos escondiendo horas trabajadas.
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)`,
    [userId, TENANT, `${SABADO} 09:00:00`]);
  try {
    const { fila } = await traerDia(SABADO);
    assert.ok(fila);
    assert.notEqual(fila.status, 'NonWorkDay', 'si ficho, no puede figurar como si no hubiera venido');
    assert.ok(fila.firstCheckin, 'el fichaje real tiene que estar');
  } finally {
    await db.query('DELETE FROM Checkins WHERE USERID = ? AND CHECKTIME = ?', [userId, `${SABADO} 09:00:00`]);
  }
});
