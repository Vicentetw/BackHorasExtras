// Regimen de horas extra en el calculo mensual (/attendance-range), bloque B3.
// Ver HORAS_EXTRA_REGIMENES.md. Verificado ademas contra septiembre completo
// de la copia de produccion (479 empleados): sin regimen, identico; con un
// regimen para 3 personas, los otros 476 sin ninguna diferencia.
//
// Dos empleados que hacen lo mismo toda la semana (HE con marcadores 9/10,
// 15:00 a 18:00, lunes 01/06 a viernes 05/06/2026) y ademas trabajan el
// domingo 07/06 de 08:00 a 12:00:
//   CON_REGIMEN: regimen "Horas extra": habil 50 %, domingo 100 %,
//                tope 12 h/mes, excedente NO_COMPUTAR.
//   SIN_REGIMEN: nada asignado -> tiene que quedar exactamente como hoy
//                (15 h, y el domingo no genera HE automatica).
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenant descartable propio (999997), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999997;
const UID = 'test-regimen-mensual';
const CON = { legajo: 900861, userId: 8890161, reloj: '10.0.1.1' };
const SIN = { legajo: 900862, userId: 8890162, reloj: '10.0.1.2' };
const M9 = 8890163;
const M10 = 8890164;
const HABILES = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
const DOMINGO = '2026-06-07';

let headers;

async function cleanup() {
  await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM day_type_overtime_rules WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM employee_convention_assignments WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM labor_conventions WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [T]);
  const [tpls] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ?', [T]);
  for (const { id } of tpls) await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [id]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [T]);
  for (const t of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [T]);
  }
}

before(async () => {
  await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Regimen Mensual (test)', 'tenant-regimen-mensual-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`, [T]);
  headers = await getTestAuthHeaders(UID);
  await cleanup();

  const [tpl] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Lunes a viernes 7-14 (test)', 'FIXED', 1, 0, 'legacy')`, [T]);
  for (let dow = 1; dow <= 5; dow++) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Jornada', '07:00:00', '14:00:00', 'WORK', 1)`, [tpl.insertId, dow]);
  }
  const ids = {};
  for (const emp of [CON, SIN]) {
    const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, ?, ?, 1, '2020-01-01', 0)`, [emp.legajo, `HE ${emp.legajo}`, T]);
    ids[emp.legajo] = e.insertId;
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`, [emp.userId, T, String(emp.legajo), `HE ${emp.legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [emp.userId, T, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`, [e.insertId, T, tpl.insertId]);
  }
  for (const [uid, badge, dir] of [[M9, '9', 'SALIDA'], [M10, '10', 'REGRESO']]) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')`, [uid, T, badge]);
    await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', 'HE', ?, 1)`, [uid, T, badge, dir]);
  }
  for (const [i, emp] of [CON, SIN].entries()) {
    const s = (dia, hhmm, seg) => `${dia} ${hhmm}:${String(seg + i * 2).padStart(2, '0')}`;
    for (const dia of HABILES) {
      for (const [userId, cuando] of [
        [emp.userId, s(dia, '06:55', 0)],
        [M9, s(dia, '14:59', 55)], [emp.userId, s(dia, '15:00', 0)],
        [M10, s(dia, '17:59', 55)], [emp.userId, s(dia, '18:00', 0)],
      ]) {
        await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?)', [userId, T, cuando, emp.reloj]);
      }
    }
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [emp.userId, T, s(DOMINGO, '08:00', 0), emp.reloj, emp.userId, T, s(DOMINGO, '12:00', 0), emp.reloj]);
  }

  const [c] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Horas extra (test)')`, [T]);
  await db.query(`INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [ids[CON.legajo], T, c.insertId]);
  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos, politica_excedente) VALUES (?, ?, '2026-01-01', 720, 'NO_COMPUTAR')`, [T, c.insertId]);
  await db.query(`INSERT INTO day_type_overtime_rules (tenant_id, convention_id, day_type, trigger_type, classification_type, rate) VALUES (?, ?, 'WORKDAY', 'AFTER_SCHEDULE', 'EXTRA', 50), (?, ?, 'SUNDAY', 'AFTER_SCHEDULE', 'EXTRA', 100)`,
    [T, c.insertId, T, c.insertId]);
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

async function fila(legajo) {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-06-01&to=2026-06-07&employeeId=${legajo}&tenantId=${T}`, { headers });
  assert.equal(res.status, 200);
  return (await res.json()).data.find((e) => String(e.employeeId) === String(legajo));
}

test('sin regimen asignado: exactamente como hoy (15 h, el domingo no genera HE automatica)', async () => {
  const r = await fila(SIN.legajo);
  assert.equal(r.overtimeHours, '15.00');
  assert.equal(r.regimenHorasExtra, undefined);
});

test('con regimen: reales 19 h (incluye el domingo), computables = tope de 12 h, excedente 7 h', async () => {
  const r = await fila(CON.legajo);
  const g = r.regimenHorasExtra;
  assert.equal(g.reales, 19 * 60);
  assert.equal(g.computables, 12 * 60);
  assert.equal(g.excedente, 7 * 60);
  assert.equal(r.overtimeHours, '12.00', 'lo oficial pasa a ser lo computable');
});

test('con regimen: el tope se consume en orden cronologico y cada hora lleva su recargo', async () => {
  const r = await fila(CON.legajo);
  // 01 al 04 = 12 h al 50 % llenan el tope; el 05 y el domingo quedan de excedente.
  assert.deepEqual(r.regimenHorasExtra.porRecargo, { '50%': 12 * 60, '100%': 0 }, 'el domingo tuvo horas al 100 %, pero quedaron de excedente');
  const domingo = r.days.find((d) => d.date === DOMINGO);
  assert.equal(domingo.regimen.tipoDeDia, 'SUNDAY');
  assert.equal(domingo.regimen.recargo, 100);
  assert.equal(domingo.regimen.excedente, 240);
});
