// P3 (2026-10-08): un empleado ACTIVO sin ningún horario (ni asignado ni el de
// su empresa) figura "Sin horario" (NoSchedule) en vez de medirse contra un
// horario inventado (el fijo 07:00-13:40 de lunes a viernes).
//
// Por qué: ese horario inventado daba "Ausente" o "Tarde" a gente que nadie
// sabía a qué hora tenía que venir, y no avisaba que faltaba configurar algo.
// "Sin horario" hace visible el problema (y la pantalla ofrece asignarlo).
//
// Lo que NO tiene que cambiar (el contraste): con un horario de empresa o una
// asignación, todo sigue igual; un inactivo sigue "Inactivo".
//
// Requiere el backend local corriendo (puerto 3000). Tenant descartable propio
// (999918), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-presentismo-sin-horario';
const TENANT = 999918;
const ACTIVO = 918001;
const INACTIVO = 918002;
const USER_ACTIVO = 999918001;
const USER_INACTIVO = 999918002;
// Lunes 17 a domingo 23 de agosto de 2026.
const LUNES = '2026-08-17';
const MARTES = '2026-08-18';
const DOMINGO = '2026-08-23';

let headers;
let empActivo; let empInactivo; let plantilla = null;

async function limpiar() {
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?)', [USER_ACTIVO, USER_INACTIVO]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [USER_ACTIVO, USER_INACTIVO]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [USER_ACTIVO, USER_INACTIVO]);
  await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE sb FROM shift_blocks sb JOIN work_schedule_templates t ON t.id = sb.template_id WHERE t.tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT]);
}

before(async () => {
  assert.equal(new Date(`${LUNES}T12:00:00`).getDay(), 1, 'LUNES tiene que ser lunes');
  await db.query("INSERT INTO tenants (id, name, code) VALUES (?, 'Sin horario (test)', 'sin-horario-test') ON DUPLICATE KEY UPDATE name = VALUES(name)", [TENANT]);
  await limpiar();
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: false, tenantId: TENANT });
  empActivo = (await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, 'Activo Sin Horario (test)', ?, '2020-01-01', 0, 1)", [ACTIVO, TENANT]))[0].insertId;
  empInactivo = (await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, 'Inactivo Sin Horario (test)', ?, '2020-01-01', 0, 0)", [INACTIVO, TENANT]))[0].insertId;
  for (const [uid, legajo, emp] of [[USER_ACTIVO, ACTIVO, empActivo], [USER_INACTIVO, INACTIVO, empInactivo]]) {
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [uid, TENANT, String(legajo), `Usuario ${legajo}`]);
    await db.query("INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')", [uid, TENANT, emp]);
  }
  // El martes, el activo fichó: tiene que verse igual (no se pierde).
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)',
    [USER_ACTIVO, TENANT, `${MARTES} 09:00:00`, USER_ACTIVO, TENANT, `${MARTES} 17:00:00`]);
});

after(async () => {
  await limpiar();
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]).catch(() => {});
  await deleteTestUser(TEST_UID);
  await closeDb();
});

async function diario(fecha) {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${fecha}?tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  const de = (legajo) => body.attendance.find((a) => String(a.employeeId) === String(legajo));
  return { body, activo: de(ACTIVO), inactivo: de(INACTIVO) };
}

// Con `legajo`, el detalle de una persona (trae `days`, el calendario).
async function mensual(legajo) {
  const persona = legajo ? `&employeeId=${legajo}` : '';
  const res = await fetch(`${BASE_URL}/attendance-range?from=${LUNES}&to=${DOMINGO}&tenantId=${TENANT}${persona}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  return (legajo) => json.data.find((e) => String(e.employeeId) === String(legajo));
}

test('diario: activo sin horario = "Sin horario", no "Ausente"; el inactivo sigue Inactivo', async () => {
  const { body, activo, inactivo } = await diario(LUNES);
  assert.equal(activo.status, 'NoSchedule');
  assert.equal(activo.fueraDeHorario, null, 'sin horario no hay contra qué comparar');
  assert.equal(inactivo.status, 'Inactive');
  assert.equal(body.summary.absent, 0, 'nadie figura ausente por un horario inventado');
  assert.equal(body.summary.desglose.sinHorario, 1);
  const d = body.summary.desglose;
  const suma = d.aTiempo + d.tarde + d.tardeJustificada + d.ausente + d.ausenciaParcial + d.excusado + d.campana + d.feriado + d.noLaborable + d.sinHorario;
  assert.equal(suma, d.total, 'el desglose sigue sumando el total');
});

test('diario: si fichó sin horario, los fichajes se ven igual', async () => {
  const { activo } = await diario(MARTES);
  assert.equal(activo.status, 'NoSchedule');
  assert.ok(activo.firstCheckin, 'la entrada real tiene que estar');
  assert.equal(activo.totalCheckins, 2);
});

test('mensual: los 7 días son "sin horario", ninguno falta, y el día que fichó cuenta como trabajado', async () => {
  const fila = await mensual();
  const a = fila(ACTIVO);
  assert.equal(a.noScheduleDays, 7);
  assert.equal(a.absent, 0);
  assert.equal(a.late, 0);
  assert.equal(a.daysWorked, 1, 'el martes estuvo');
  // El detalle (calendario) dice lo mismo que el resumen.
  const det = (await mensual(ACTIVO))(ACTIVO);
  assert.equal(det.noScheduleDays, 7);
  assert.ok(det.days.every((d) => d.status === 'NoSchedule'));
  assert.ok(det.days.find((d) => d.date === MARTES).firstCheckin);
  // Mismo criterio que el diario: el inactivo no es "sin horario".
  const i = fila(INACTIVO);
  if (i) assert.ok(!i.noScheduleDays, 'un inactivo no suma días sin horario');
});

test('una excepción cargada manda sobre "sin horario", y el diario dice lo mismo que el mensual', async () => {
  // Lunes 24: tiene una excepción de día completo Y fichó.
  const LUNES_24 = '2026-08-24';
  await db.query("INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, 'tramite (test)', 'FULL_DAY')", [USER_ACTIVO, TENANT, LUNES_24]);
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [USER_ACTIVO, TENANT, `${LUNES_24} 09:00:00`]);
  try {
    const { activo } = await diario(LUNES_24);
    assert.notEqual(activo.status, 'NoSchedule');
    const res = await fetch(`${BASE_URL}/attendance-range?from=${LUNES_24}&to=${LUNES_24}&tenantId=${TENANT}&employeeId=${ACTIVO}`, { headers });
    const fila = (await res.json()).data.find((e) => String(e.employeeId) === String(ACTIVO));
    assert.equal(fila.days[0].status, activo.status, 'mismo estado en las dos vistas');
    assert.equal(fila.noScheduleDays, 0);
  } finally {
    await db.query('DELETE FROM userexclusions WHERE userId = ? AND excDate = ?', [USER_ACTIVO, LUNES_24]);
    await db.query('DELETE FROM Checkins WHERE USERID = ? AND CHECKTIME = ?', [USER_ACTIVO, `${LUNES_24} 09:00:00`]);
  }
});

test('EL CONTRASTE: con una plantilla de empresa vuelve a medirse (el lunes sin fichar = Ausente)', async () => {
  plantilla = (await db.query("INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Lunes a Viernes (test)', 'FIXED', 1, 1)", [TENANT]))[0].insertId;
  for (let dow = 1; dow <= 5; dow++) {
    await db.query("INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active) VALUES (?, ?, 'Oficina', '08:00:00', '16:00:00', 'WORK', 0, 1)", [plantilla, dow]);
  }
  const { activo, body } = await diario(LUNES);
  assert.equal(activo.status, 'Absent');
  assert.equal(body.summary.desglose.sinHorario, 0);
  const a = (await mensual())(ACTIVO);
  assert.equal(a.noScheduleDays, 0);
  assert.equal(a.absent, 4, 'lunes, miércoles, jueves y viernes sin fichar');
});
