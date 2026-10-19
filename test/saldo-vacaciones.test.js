// Saldo de vacaciones: una sola cuenta (motor-laboral/services/saldoVacaciones.js,
// rediseño de ausencias B, 2026-10-19). Lo que importa:
//  - sin nada cargado a mano, los días del año salen de la escala por
//    antigüedad (antes daba 0 y el saldo negativo);
//  - lo cargado a mano manda;
//  - descuenta CUALQUIER motivo marcado "descuenta vacaciones" (antes solo el
//    de código exacto 'VACACIONES');
//  - la lista, el saldo de una persona y "Cargar ausencia" dan lo mismo.
// Requiere el backend local corriendo. Tenant descartable 999979.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { diasPorEscala, ESCALA_LCT } = require('../motor-laboral/services/saldoVacaciones');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999979;
const LEGAJO = 979001;
let h, empId, tipoAdelantadas;

async function cleanup() {
  await db.query('DELETE ee FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE e.tenant_id = ?', [T]);
  await db.query('DELETE b FROM employee_leave_balances b JOIN employees e ON e.id = b.employee_id WHERE e.tenant_id = ?', [T]);
  await db.query('DELETE FROM event_types WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [T]);
}

before(async () => {
  await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [T, 'Saldo vacaciones (test)', 'saldo-vac-test']);
  h = await getTestAuthHeaders('test-saldo-vac', { isSuperadmin: false, tenantId: T, permissions: ['leaves:read', 'leaves:create', 'exclusions:create'] });
  await cleanup();
  // Alta 2020-03-01: al 1/1/2026 tiene 5,8 años → 21 días por la ley.
  const [e] = await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, 'Saldo (test)', ?, 1, '2020-03-01', 0)", [LEGAJO, T]);
  empId = e.insertId;
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [LEGAJO, T, String(LEGAJO), 'Saldo']);
  await db.query("INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')", [LEGAJO, T, empId]);
  // Un motivo que descuenta vacaciones pero NO se llama 'VACACIONES'.
  const [t] = await db.query("INSERT INTO event_types (tenant_id, code, descripcion, descuenta_vacaciones, active) VALUES (?, 'VAC_ADEL', 'Vacaciones adelantadas (test)', 1, 1)", [T]);
  tipoAdelantadas = t.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-saldo-vac');
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

const pedir = async (ruta) => (await fetch(URL + ruta, { headers: h })).json();
const deLaLista = async () => (await pedir('/api/leave-balances?year=2026')).balances.find((b) => String(b.legajo) === String(LEGAJO));

test('escala por antigüedad (pura)', () => {
  assert.equal(diasPorEscala('2020-03-01', 2026, ESCALA_LCT).dias, 21);
  assert.equal(diasPorEscala('2025-06-01', 2026, ESCALA_LCT).dias, 14);
  assert.equal(diasPorEscala(null, 2026, ESCALA_LCT).dias, null);
});

test('sin nada cargado: los días salen de la escala (no 0)', async () => {
  const b = await deLaLista();
  assert.deepEqual([b.allotted, b.porEscala, b.taken, b.pending], [21, true, 0, 21]);
});

test('descuenta un motivo marcado "descuenta vacaciones" aunque no se llame VACACIONES', async () => {
  await db.query("INSERT INTO employee_events (employee_id, fecha_desde, fecha_hasta, dias, event_type_id) VALUES (?, '2026-02-02', '2026-02-06', 5, ?)", [empId, tipoAdelantadas]);
  const b = await deLaLista();
  assert.deepEqual([b.taken, b.pending], [5, 16]);
});

test('la lista, el saldo de la persona y "Cargar ausencia" dan lo mismo', async () => {
  const lista = await deLaLista();
  const una = await pedir(`/api/leave-balances/${LEGAJO}/2026`);
  const form = await pedir(`/api/ausencias/persona?legajo=${LEGAJO}&anio=2026`);
  assert.deepEqual([una.allotted, una.taken, una.pending], [lista.allotted, lista.taken, lista.pending]);
  assert.deepEqual([form.saldoVacaciones.asignados, form.saldoVacaciones.tomados, form.saldoVacaciones.quedan], [lista.allotted, lista.taken, lista.pending]);
  assert.equal(form.userId, LEGAJO, 'trae el número del reloj para poder justificar');
  assert.equal(form.employeeId, empId);
});

test('lo cargado a mano manda sobre la escala', async () => {
  await db.query('INSERT INTO employee_leave_balances (employee_id, year, allotted_days) VALUES (?, 2026, 10)', [empId]);
  const b = await deLaLista();
  assert.deepEqual([b.allotted, b.porEscala, b.pending], [10, false, 5]);
});
