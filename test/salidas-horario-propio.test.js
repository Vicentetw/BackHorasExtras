// Salidas sin par se completan con el horario DE LA PERSONA (2026-10-10).
// Antes se usaba el horario por defecto de la empresa (o 07:00/13:40
// inventados), y a quien tenía otro horario se le calculaba mal la duración
// (AVP 2026: 1.732 salidas, 142 personas). Ver horarioParaSalidasSinPar.js.
//
// Empresa de prueba con horario general 8 a 16 y:
//   A: plantilla propia 7 a 14 -> salida sin regreso se cierra a las 14:00
//   B: sin plantilla           -> horario general (16:00) + aviso "sin plantilla"
//   C: plantilla sin sábado    -> salida un sábado: sin duración + aviso
//   D: sereno 22 a 6           -> se cierra a las 6 del día siguiente
//   E: plantilla propia 7 a 14 -> "entrada particular" arranca a las 07:00
// Requiere el backend local (puerto 3000). Tenant descartable 999909.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { AVISO_SIN_PLANTILLA, AVISO_SIN_JORNADA } = require('../motor-laboral/services/horarioParaSalidasSinPar');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999909;
const U = 8890900; // USERID base del reloj de prueba
const M_SALIDA = U + 96; // lejos de los usuarios de los empleados (U + legajo)
const M_REGRESO = U + 95;
let h; let filas;

async function limpiar() {
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [T]);
  await db.query('DELETE sb FROM shift_blocks sb JOIN work_schedule_templates w ON w.id = sb.template_id WHERE w.tenant_id = ?', [T]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [T]);
}

async function plantilla(nombre, esDefault, bloques) {
  const [t] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, ?, 'FIXED', 1, ?, 'legacy')`, [T, nombre, esDefault ? 1 : 0]);
  for (const [dia, ini, fin, cruza] of bloques) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active) VALUES (?, ?, 'Jornada', ?, ?, 'WORK', ?, 1)`, [t.insertId, dia, ini, fin, cruza ? 1 : 0]);
  }
  return t.insertId;
}

async function empleado(legajo, nombre, plantillaId) {
  const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, ?, ?, 1, '2020-01-01', 0)`, [legajo, nombre, T]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [U + legajo, T, String(legajo), nombre]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [U + legajo, T, e.insertId]);
  if (plantillaId) await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`, [e.insertId, T, plantillaId]);
}

before(async () => {
  await db.query("INSERT INTO tenants (id, name, code) VALUES (?, 'Salidas horario propio (test)', 'salidas-horario-propio') ON DUPLICATE KEY UPDATE name = VALUES(name)", [T]);
  await limpiar();
  const lunesAViernes = (ini, fin, cruza = false) => [1, 2, 3, 4, 5].map((d) => [d, ini, fin, cruza]);
  await plantilla('General 8 a 16', true, lunesAViernes('08:00:00', '16:00:00'));
  const deSiete = await plantilla('Turno 7 a 14', false, lunesAViernes('07:00:00', '14:00:00'));
  const sereno = await plantilla('Sereno 22 a 6', false, lunesAViernes('22:00:00', '06:00:00', true));
  await empleado(1, 'A con horario propio', deSiete);
  await empleado(2, 'B sin plantilla', null);
  await empleado(3, 'C sin sabado', deSiete);
  await empleado(4, 'D sereno', sereno);
  await empleado(5, 'E entrada particular', deSiete);
  for (const [uid, badge, dir] of [[M_SALIDA, '96', 'SALIDA'], [M_REGRESO, '95', 'REGRESO']]) {
    await db.query("INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')", [uid, T, badge]);
    await db.query("INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', 'PARTICULAR', ?, 1)", [uid, T, badge, dir]);
  }
  const f = (uid, t) => [uid, T, t, '10.99.0.1'];
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES ?', [[
    // miércoles 2026-03-04
    f(U + 1, '2026-03-04 07:00:00'), f(M_SALIDA, '2026-03-04 10:59:58'), f(U + 1, '2026-03-04 11:00:00'),
    f(U + 2, '2026-03-04 08:00:00'), f(M_SALIDA, '2026-03-04 11:59:58'), f(U + 2, '2026-03-04 12:00:00'),
    f(M_REGRESO, '2026-03-04 09:59:58'), f(U + 5, '2026-03-04 10:00:00'), f(U + 5, '2026-03-04 14:00:00'),
    f(U + 4, '2026-03-04 21:55:00'), f(M_SALIDA, '2026-03-04 22:59:58'), f(U + 4, '2026-03-04 23:00:00'),
    // sábado 2026-03-07
    f(U + 3, '2026-03-07 09:00:00'), f(M_SALIDA, '2026-03-07 10:59:58'), f(U + 3, '2026-03-07 11:00:00'),
  ]]);
  h = await getTestAuthHeaders('test-salidas-horario', { isSuperadmin: false, tenantId: T, permissions: ['attendance:read'] });
  const r = await fetch(`${BASE_URL}/movements-range?from=2026-03-04&to=2026-03-07&category=PARTICULAR`, { headers: h });
  assert.equal(r.status, 200);
  filas = (await r.json()).rows;
});

after(async () => {
  await limpiar();
  await deleteTestUser('test-salidas-horario');
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

const de = (legajo) => filas.find((x) => String(x.employeeId) === String(legajo));

test('con horario propio: la salida sin regreso se cierra al fin de SU horario (14:00), no del general (16:00)', () => {
  const a = de(1);
  assert.equal(a.timeIn, '2026-03-04 14:00:00');
  assert.equal(a.durationMinutes, 180);
  assert.equal(a.avisoHorario, null);
});

test('sin plantilla: se usa el horario general y avisa para que se le asigne una', () => {
  const b = de(2);
  assert.equal(b.timeIn, '2026-03-04 16:00:00');
  assert.equal(b.durationMinutes, 240);
  assert.equal(b.avisoHorario, AVISO_SIN_PLANTILLA);
});

test('un día que no trabaja (sábado): no se inventa una hora; sin duración y con aviso', () => {
  const c = de(3);
  assert.equal(c.hasReturn, false);
  assert.equal(c.timeIn, null);
  assert.equal(c.durationMinutes, null);
  assert.equal(c.avisoHorario, AVISO_SIN_JORNADA);
});

test('turno que cruza la medianoche: se cierra a las 6 del día siguiente', () => {
  const d = de(4);
  assert.equal(d.timeIn, '2026-03-05 06:00:00');
  assert.equal(d.durationMinutes, 420);
});

test('entrada particular: arranca a la hora de entrada de SU horario (07:00)', () => {
  const e = de(5);
  assert.equal(e.timeOut, '2026-03-04 07:00:00');
  assert.equal(e.durationMinutes, 180);
  assert.equal(e.avisoHorario, null);
});
