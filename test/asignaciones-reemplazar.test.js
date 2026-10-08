// Horarios de empleados (revisión 2026-10-08): "reemplazar" al asignar, y
// convenio en bloque / vigente. Aislamiento: nada de otra empresa.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999913/999914), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const API = `${BASE_URL}/api/labor-engine/admin`;
const A = 999913;
const B = 999914;
let hA; let hB;
let emp1; let emp2; let empB; let tpl1; let tpl2; let tplB; let convA; let convB;

const pedir = async (h, url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const rangos = async (emp) => (await db.query(
  "SELECT template_id t, DATE_FORMAT(valid_from,'%Y-%m-%d') d, DATE_FORMAT(valid_to,'%Y-%m-%d') h FROM employee_work_calendars WHERE employee_id = ? ORDER BY valid_from", [emp]))[0]
  .map((r) => `${r.t === tpl1 ? 'T1' : r.t === tpl2 ? 'T2' : r.t}:${r.d}→${r.h || '∞'}`);

async function cleanup() {
  for (const t of [A, B]) {
    for (const tabla of ['employee_convention_assignments', 'employee_work_calendars', 'labor_conventions', 'work_schedule_templates', 'employees']) {
      await db.query(`DELETE FROM ${tabla} WHERE tenant_id = ?`, [t]);
    }
  }
}

before(async () => {
  for (const [id, code] of [[A, 'reemplazar-a'], [B, 'reemplazar-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await cleanup();
  const permisos = ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete'];
  hA = await getTestAuthHeaders('test-reemplazar-a', { isSuperadmin: false, tenantId: A, permissions: permisos });
  hB = await getTestAuthHeaders('test-reemplazar-b', { isSuperadmin: false, tenantId: B, permissions: permisos });
  const nuevoEmp = async (t, legajo) => (await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, 'x (test)', ?, '2020-01-01', 0, 1)`, [legajo, t]))[0].insertId;
  emp1 = await nuevoEmp(A, 901913); emp2 = await nuevoEmp(A, 901914); empB = await nuevoEmp(B, 901915);
  const nuevaTpl = async (t, n) => (await db.query("INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 0)", [t, n]))[0].insertId;
  tpl1 = await nuevaTpl(A, 'T1 (test)'); tpl2 = await nuevaTpl(A, 'T2 (test)'); tplB = await nuevaTpl(B, 'TB (test)');
  convA = (await db.query("INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio A (test)', 1)", [A]))[0].insertId;
  convB = (await db.query("INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio B (test)', 1)", [B]))[0].insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-reemplazar-a');
  await deleteTestUser('test-reemplazar-b');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('sin "reemplazar", como siempre: asignar desde antes no corta la vigente (quedan superpuestas)', async () => {
  await pedir(hA, `${API}/employees/${emp1}/calendar`, 'POST', { template_id: tpl1, valid_from: '2026-09-29' });
  await pedir(hA, `${API}/employees/${emp1}/calendar`, 'POST', { template_id: tpl2, valid_from: '2026-01-01' });
  assert.deepEqual(await rangos(emp1), ['T2:2026-01-01→∞', 'T1:2026-09-29→∞']);
  await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [emp1]);
});

test('con "reemplazar": la nueva queda sola en sus fechas', async () => {
  await pedir(hA, `${API}/employees/${emp1}/calendar`, 'POST', { template_id: tpl1, valid_from: '2026-09-29' });
  const r = await pedir(hA, `${API}/employees/${emp1}/calendar`, 'POST', { template_id: tpl2, valid_from: '2026-01-01', reemplazar: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.reemplazadas, 1);
  assert.deepEqual(await rangos(emp1), ['T2:2026-01-01→∞']);
  // Una temporal en el medio, reemplazando: la permanente se parte y vuelve después.
  await pedir(hA, `${API}/employees/${emp1}/calendar`, 'POST', { template_id: tpl1, valid_from: '2026-10-10', valid_to: '2026-10-12', reemplazar: true });
  assert.deepEqual(await rangos(emp1), ['T2:2026-01-01→2026-10-09', 'T1:2026-10-10→2026-10-12', 'T2:2026-10-13→∞']);
});

test('en bloque con "reemplazar", y sin tocar empleados de otra empresa', async () => {
  await pedir(hA, `${API}/employees/${emp2}/calendar`, 'POST', { template_id: tpl1, valid_from: '2026-09-29' });
  const r = await pedir(hA, `${API}/employees/bulk-assign-calendar`, 'POST', { employeeIds: [emp2, empB], template_id: tpl2, valid_from: '2026-01-01', reemplazar: true });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.skipped.map((s) => s.employeeId), [empB]);
  assert.deepEqual(await rangos(emp2), ['T2:2026-01-01→∞']);
  assert.deepEqual(await rangos(empB), []);
});

test('convenio en bloque: encuadra a los de la empresa, cierra el anterior, y "vigentes" los muestra', async () => {
  const r = await pedir(hA, `${API}/employees/bulk-convention-assignments`, 'POST', { employeeIds: [emp1, emp2, empB], convention_id: convA, valid_from: '2026-01-01' });
  assert.equal(r.status, 201);
  assert.equal(r.body.assigned.length, 2);
  assert.deepEqual(r.body.skipped.map((s) => s.employeeId), [empB]);
  const v = await pedir(hA, `${API}/convention-assignments/vigentes`);
  assert.deepEqual(v.body.map((x) => x.employee_id).sort(), [emp1, emp2].sort());
  assert.deepEqual((await pedir(hB, `${API}/convention-assignments/vigentes`)).body, [], 'B no ve los de A');
  // Un convenio de otra empresa: no existe para A.
  assert.equal((await pedir(hA, `${API}/employees/bulk-convention-assignments`, 'POST', { employeeIds: [emp1], convention_id: convB, valid_from: '2026-01-01' })).status, 404);
});
