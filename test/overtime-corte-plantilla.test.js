// El "Corte HE" de la plantilla tambien vale para las HE por marcador.
//
// Caso real (MARTENSEN, 2026-09-29): plantilla "Horas extras" con Trabajo
// 7-14, Descanso 14-15 y Corte HE 15:00. Fichó 06:49, apretó el 9 a las 14:42
// y el 10 a las 18:01. La pantalla de plantillas promete que el corte es "la
// hora a partir de la cual el tiempo trabajado empieza a contar como HE", pero
// con marcador contaba desde 14:42 (3h 19m). Tiene que contar desde 15:00.
//
// Otro empleado, con la misma plantilla pero SIN corte cargado, no cambia.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenant descartable propio (999993), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999993;
const UID = 'test-overtime-corte-plantilla';
const DIA = '2026-06-02'; // pasado a proposito: la vista mensual corta el periodo en hoy
const DOW = new Date(`${DIA}T12:00:00`).getDay();
const CON_CORTE = { legajo: 900841, userId: 8890141 };
const SIN_CORTE = { legajo: 900842, userId: 8890142 };
const MARCA_9 = 8890143;
const MARCA_10 = 8890144;

let headers;
const plantillas = [];

async function cleanup() {
  await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [TENANT]);
  const [tpls] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ?', [TENANT]);
  for (const { id } of tpls) await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [id]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [TENANT]);
  for (const t of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [TENANT]);
  }
}

before(async () => {
  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Corte HE (test)', 'tenant-corte-he-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [TENANT]);
  headers = await getTestAuthHeaders(UID);
  await cleanup();

  for (const [nombre, corte] of [['Horas extras (corte 15)', '15:00:00'], ['Horas extras (sin corte)', null]]) {
    const [tpl] = await db.query(
      `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode, overtime_cutoff_time)
       VALUES (?, ?, 'FIXED', 1, 0, 'legacy', ?)`, [TENANT, nombre, corte]);
    plantillas.push(tpl.insertId);
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Jornada', '07:00:00', '14:00:00', 'WORK', 1)`, [tpl.insertId, DOW]);
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Almuerzo', '14:00:00', '15:00:00', 'BREAK', 1)`, [tpl.insertId, DOW]);
  }

  for (const [emp, tplId] of [[CON_CORTE, plantillas[0]], [SIN_CORTE, plantillas[1]]]) {
    const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, ?, ?, 1, '2020-01-01', 0)`, [emp.legajo, `HE ${emp.legajo}`, TENANT]);
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`, [emp.userId, TENANT, String(emp.legajo), `HE ${emp.legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [emp.userId, TENANT, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`, [e.insertId, TENANT, tplId]);
  }
  for (const [uid, badge, dir] of [[MARCA_9, '9', 'SALIDA'], [MARCA_10, '10', 'REGRESO']]) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')`, [uid, TENANT, badge]);
    await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', 'HE', ?, 1)`, [uid, TENANT, badge, dir]);
  }
  // Los dos empleados fichan igual, en relojes distintos para no mezclar marcadores.
  // Cada uno en su reloj (los marcadores son por reloj) y 2 s corridos, porque
  // el mismo marcador no puede tener dos fichajes en el mismo segundo.
  for (const [emp, reloj, desfase] of [[CON_CORTE, '10.0.0.1', 0], [SIN_CORTE, '10.0.0.2', 2]]) {
    const s = (hhmm, seg) => `${DIA} ${hhmm}:${String(seg + desfase).padStart(2, '0')}`;
    const filas = [
      [emp.userId, s('06:49', 0)],
      [MARCA_9, s('14:41', 55)], [emp.userId, s('14:42', 0)],
      [MARCA_10, s('18:00', 55)], [emp.userId, s('18:01', 0)],
    ];
    for (const [userId, cuando] of filas) {
      await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?)', [userId, TENANT, cuando, reloj]);
    }
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]);
  await closeDb();
});

async function dia(legajo) {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${DIA}&to=${DIA}&employeeId=${legajo}&tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((e) => String(e.employeeId) === String(legajo));
  return row.days.find((d) => d.date === DIA);
}

test('con corte 15:00 en la plantilla, la HE por marcador cuenta desde las 15:00', async () => {
  const d = await dia(CON_CORTE.legajo);
  assert.equal(d.overtimeSource, 'marker');
  assert.equal(d.overtimeStartTime, '15:00');
  assert.equal(d.overtimeMinutes, 181, '15:00 a 18:01');
  assert.equal(d.overtimeMarkerStart, '14:42');
  assert.equal(d.overtimeMinutesBeforeCutoff, 18);
});

test('sin corte cargado, la misma plantilla sigue contando desde el marcador (sin cambios)', async () => {
  const d = await dia(SIN_CORTE.legajo);
  assert.equal(d.overtimeSource, 'marker');
  assert.equal(d.overtimeMinutes, 199, '14:42 a 18:01');
  assert.equal(d.overtimeMarkerStart, null);
  assert.equal(d.overtimeMinutesBeforeCutoff, 0);
});
