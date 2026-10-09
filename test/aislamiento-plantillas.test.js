// Aislamiento de las PLANTILLAS DE HORARIO entre empresas (2026-10-09).
// La empresa B intenta todo sobre una plantilla de la empresa A: verla,
// editarla, borrarla, sus bloques, su ciclo, asignarla a sus empleados,
// simularla y usarla en Presentismo. Todo tiene que fallar, y lo de A tiene
// que seguir intacto.
// Requiere el backend local corriendo (puerto 3000). Tenants descartables (999907/999908), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999907;
const B = 999908;
const PERMS = ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete', 'attendance:read', 'employees:read'];
let hA; let hB; let tplA; let bloqueA; let empB;
const ADMIN = '/api/labor-engine/admin';

const req = (h, method, url, body) => fetch(`${BASE_URL}${url}`, {
  method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

async function limpiar() {
  for (const t of [A, B]) {
    await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE sb FROM shift_blocks sb JOIN work_schedule_templates w ON w.id = sb.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE d FROM template_cycle_days d JOIN work_schedule_templates w ON w.id = d.template_id WHERE w.tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

before(async () => {
  for (const [id, code] of [[A, 'aisl-plantillas-a'], [B, 'aisl-plantillas-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await limpiar();
  hA = await getTestAuthHeaders('test-aisl-plantillas-a', { isSuperadmin: false, tenantId: A, permissions: PERMS });
  hB = await getTestAuthHeaders('test-aisl-plantillas-b', { isSuperadmin: false, tenantId: B, permissions: PERMS });
  const r = await req(hA, 'POST', `${ADMIN}/templates/asistente`, { nombre: 'Secreta de A (test)', semana: [1, 2, 3, 4, 5].map((dia) => ({ dia, tramos: [{ inicio: '06:15', fin: '13:45' }] })) });
  tplA = (await r.json()).id;
  bloqueA = (await db.query('SELECT id FROM shift_blocks WHERE template_id = ? LIMIT 1', [tplA]))[0][0].id;
  const [e] = await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (908001, 'Empleado de B (test)', ?, '2020-01-01', 0, 1)", [B]);
  empB = e.insertId;
});

after(async () => {
  await limpiar();
  await deleteTestUser('test-aisl-plantillas-a');
  await deleteTestUser('test-aisl-plantillas-b');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('B no ve la plantilla de A en su lista; A sí', async () => {
  const deB = await (await req(hB, 'GET', `${ADMIN}/templates`)).json();
  assert.ok(!deB.some((t) => t.id === tplA));
  const deA = await (await req(hA, 'GET', `${ADMIN}/templates`)).json();
  assert.ok(deA.some((t) => t.id === tplA));
});

test('B no puede leer, editar ni borrar la plantilla de A, ni sus bloques ni su ciclo', async () => {
  const casos = [
    ['GET', `${ADMIN}/templates/${tplA}/blocks`],
    ['POST', `${ADMIN}/templates/${tplA}/blocks`, { day_of_week: 6, name: 'x', start_time: '08:00', end_time: '09:00', type: 'WORK', active: true }],
    ['PUT', `${ADMIN}/templates/${tplA}`, { name: 'Hackeada', type: 'FIXED' }],
    ['PUT', `${ADMIN}/blocks/${bloqueA}`, { day_of_week: 1, name: 'x', start_time: '01:00', end_time: '02:00', type: 'WORK', active: true }],
    ['DELETE', `${ADMIN}/blocks/${bloqueA}`],
    ['DELETE', `${ADMIN}/templates/${tplA}`],
  ];
  for (const [m, url, body] of casos) {
    const r = await req(hB, m, url, body);
    assert.ok([403, 404].includes(r.status), `${m} ${url} -> ${r.status}`);
  }
  // Ciclo: sin la migración 20261015 responde 503; con ella, 404. Nunca 200.
  for (const [m, body] of [['GET'], ['PUT', { largo: 2, dias: [null, null] }], ['DELETE']]) {
    const r = await req(hB, m, `${ADMIN}/templates/${tplA}/ciclo`, body);
    assert.notEqual(r.status, 200, `${m} ciclo`);
  }
  // Lo de A sigue intacto.
  const [[t]] = await db.query('SELECT name FROM work_schedule_templates WHERE id = ?', [tplA]);
  assert.equal(t.name, 'Secreta de A (test)');
  const [[n]] = await db.query('SELECT COUNT(*) n FROM shift_blocks WHERE template_id = ?', [tplA]);
  assert.equal(n.n, 5);
});

test('B no puede asignar la plantilla de A a sus empleados (de a uno ni en bloque)', async () => {
  const uno = await req(hB, 'POST', `${ADMIN}/employees/${empB}/calendar`, { template_id: tplA, valid_from: '2026-01-01' });
  assert.equal(uno.status, 400);
  const bloque = await (await req(hB, 'POST', `${ADMIN}/employees/bulk-assign-calendar`, { employeeIds: [empB], template_id: tplA, valid_from: '2026-01-01' })).json();
  assert.equal(bloque.assigned.length, 0);
  const [[c]] = await db.query('SELECT COUNT(*) n FROM employee_work_calendars WHERE employee_id = ?', [empB]);
  assert.equal(c.n, 0);
});

test('B no puede simular ni calcular Presentismo con la plantilla de A (no ve sus horarios)', async () => {
  const sim = await req(hB, 'POST', `${ADMIN}/simulate`, { templateId: tplA, checkins: ['06:15', '13:45'], dayType: 'WORKDAY', isOvertimeAuthorized: false });
  assert.ok([403, 404].includes(sim.status), `simulate -> ${sim.status}`);
  const dia = await req(hB, 'GET', `/api/labor-engine/attendance/2026-08-17?templateId=${tplA}`);
  assert.equal(dia.status, 404);
  assert.doesNotMatch(await dia.text(), /06:15/);
  // Con su propia plantilla (o sin plantilla) sí anda.
  assert.equal((await req(hB, 'GET', '/api/labor-engine/attendance/2026-08-17')).status, 200);
  assert.equal((await req(hA, 'GET', `/api/labor-engine/attendance/2026-08-17?templateId=${tplA}`)).status, 200);
});

test('aunque una asignación vieja apuntara a una plantilla de otra empresa, no se usa', async () => {
  // Se fuerza en la base (las rutas ya no lo permiten).
  await db.query("INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)", [empB, B, tplA]);
  try {
    const j = await (await req(hB, 'GET', '/api/labor-engine/attendance/2026-08-17')).json();
    const fila = j.attendance.find((x) => String(x.employeeId) === '908001');
    assert.ok(fila, 'el empleado aparece');
    assert.notEqual(fila.schedule.templateId, tplA, 'no se usa la plantilla de A');
    assert.doesNotMatch(JSON.stringify(fila.schedule), /06:15/);
  } finally {
    await db.query('DELETE FROM employee_work_calendars WHERE employee_id = ?', [empB]);
  }
});
