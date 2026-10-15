// Etapa 1 del orden de horas extra + D1 (2026-10-15). Ver ESTADO_PROYECTO.md.
//
// D1: la "Tolerancia de entrada" de la plantilla se usa en el cálculo de
// siempre (antes solo en el motor nuevo). Con entrada 9:00 y 10 min, 9:10 es a
// tiempo y 9:11 es tarde; la tardanza se cuenta desde las 9:00. 0 = estricto.
// Vale con el valor que regía ESE día (historial de la plantilla), y el
// reporte mensual y la vista diaria tienen que dar lo mismo.
//
// Etapa 1: GET /day-type-rules dice si cada regla se aplica de verdad
// (seAplica/motivoNoSeAplica), y no se pueden cargar dos reglas activas para
// el mismo tipo de día y alcance (409).
//
// Requiere el backend local corriendo. Tenants descartables (999927/999928).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN = `${URL}/api/labor-engine/admin`;
const T = 999927;
const OTRA = 999928;
const PERMISOS = ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete', 'attendance:read'];
const UID = 'test-orden-horas-extra';

let h, templateId, employeeId, userId, badge, conv;

const pedir = (metodo, url, body) => fetch(url, {
  method: metodo, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

async function cleanup() {
  await db.query(
    `DELETE FROM day_type_overtime_rules WHERE tenant_id IN (?, ?)
        OR convention_id IN (SELECT id FROM labor_conventions WHERE tenant_id IN (?, ?))
        OR template_id IN (SELECT id FROM work_schedule_templates WHERE tenant_id IN (?, ?))`, [T, OTRA, T, OTRA, T, OTRA]);
  await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM labor_conventions WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM Checkins WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM employee_work_calendars WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM users WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [T, OTRA]);
  await db.query(
    `DELETE h FROM work_schedule_template_config_history h JOIN work_schedule_templates t ON t.id = h.template_id WHERE t.tenant_id IN (?, ?)`, [T, OTRA]);
  await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates t ON t.id = b.template_id WHERE t.tenant_id IN (?, ?)', [T, OTRA]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id IN (?, ?)', [T, OTRA]);
}

before(async () => {
  for (const id of [T, OTRA]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [id, `Orden HE ${id} (test)`, `orden-he-${id}-test`]);
  }
  h = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  await cleanup();

  // Plantilla de la empresa con tolerancia 0 (estricta), lunes 9:00-13:00.
  // created_at viejo: existe desde antes de las fechas del test.
  const [tpl] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, tolerancia_entrada_minutos, created_at)
     VALUES (?, 'Estricta (test)', 'FIXED', 1, 1, 0, '2026-01-01 00:00:00')`, [T]);
  templateId = tpl.insertId;
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active)
                  VALUES (?, 1, 'Jornada', '09:00:00', '13:00:00', 'WORK', 1)`, [templateId]);
  // Del 10 al 16 de agosto regía 15 minutos (historial de la plantilla).
  await db.query(`INSERT INTO work_schedule_template_config_history (template_id, tolerancia_entrada_minutos, valid_from, valid_to)
                  VALUES (?, 15, '2026-08-10', '2026-08-16')`, [templateId]);

  const seed = Date.now() % 1000000;
  badge = 600000 + (seed % 90000);
  userId = 600000 + ((seed + 7) % 90000);
  const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (?, 'Tolerancia (test)', ?, 0)`, [badge, T]);
  employeeId = e.insertId;
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Tolerancia (test)')`, [userId, T, String(badge)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [userId, T, employeeId]);
  await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`,
    [employeeId, T, templateId]);
  const fichajes = [
    ['2026-08-03', '09:07'], ['2026-08-03', '13:00'], // tol 0 -> tarde 7
    ['2026-08-10', '09:12'], ['2026-08-10', '13:00'], // tol 15 (historial) -> a tiempo
    ['2026-08-24', '09:00'], ['2026-08-24', '13:00'], // justo en hora -> a tiempo
    ['2026-08-31', '09:01'], ['2026-08-31', '13:00'], // tol 0 -> tarde 1
  ];
  for (const [d, hora] of fichajes) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, T, `${d} ${hora}:00`]);
  }

  const [c] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Convenio (test)')`, [T]);
  conv = c.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

async function diasDelMes() {
  const res = await pedir('GET', `${URL}/attendance-range?from=2026-08-01&to=2026-08-31&employeeId=${badge}`);
  assert.equal(res.status, 200);
  const fila = (await res.json()).data.find((r) => String(r.employeeId) === String(badge));
  assert.ok(fila, 'la persona aparece en el reporte');
  return new Map(fila.days.map((d) => [d.date, d]));
}

async function vistaDiaria(fecha) {
  const res = await pedir('GET', `${URL}/api/labor-engine/attendance/${fecha}`);
  assert.equal(res.status, 200);
  return (await res.json()).attendance.find((a) => String(a.employeeId) === String(badge));
}

test('D1: tolerancia 0 de la plantilla = estricto (9:07 es tarde, 7 min contados desde las 9:00)', async () => {
  const dias = await diasDelMes();
  assert.equal(dias.get('2026-08-03').status, 'Late');
  assert.equal(dias.get('2026-08-03').lateMinutes, 7);
  assert.equal(dias.get('2026-08-31').status, 'Late');
  assert.equal(dias.get('2026-08-31').lateMinutes, 1);
  assert.equal(dias.get('2026-08-24').status, 'OnTime', 'llegar a la hora exacta no es tarde');
});

test('D1: cada día usa la tolerancia que regía ese día (historial: 15 min del 10 al 16/08)', async () => {
  const dias = await diasDelMes();
  assert.equal(dias.get('2026-08-10').status, 'OnTime', '9:12 con 15 min de tolerancia es a tiempo');
});

test('D1: la vista diaria da lo mismo que el reporte mensual (una sola verdad)', async () => {
  const dias = await diasDelMes();
  for (const fecha of ['2026-08-03', '2026-08-10', '2026-08-24', '2026-08-31']) {
    const diaria = await vistaDiaria(fecha);
    assert.ok(diaria, `la persona aparece en la vista diaria del ${fecha}`);
    assert.equal(diaria.status, dias.get(fecha).status, `mismo estado el ${fecha}`);
  }
});

test('Etapa 1: una regla sin máximos cargados avisa que no se aplica; con máximos del convenio, sí', async () => {
  const res = await pedir('POST', `${ADMIN}/day-type-rules`,
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 100, convention_id: conv });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  let regla = (await (await pedir('GET', `${ADMIN}/day-type-rules`)).json()).find((r) => r.id === id);
  assert.equal(regla.seAplica, false);
  assert.match(regla.motivoNoSeAplica, /máximos/);

  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos, politica_excedente)
                  VALUES (?, ?, '2026-01-01', 1800, 'AVISAR')`, [T, conv]);
  regla = (await (await pedir('GET', `${ADMIN}/day-type-rules`)).json()).find((r) => r.id === id);
  assert.equal(regla.seAplica, true);
  assert.equal(regla.motivoNoSeAplica, null);
});

test('Etapa 1: una regla de toda la empresa con máximos solo en un convenio se aplica a medias (y lo dice)', async () => {
  const res = await pedir('POST', `${ADMIN}/day-type-rules`,
    { day_type: 'SUNDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 100 });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const regla = (await (await pedir('GET', `${ADMIN}/day-type-rules`)).json()).find((r) => r.id === id);
  assert.equal(regla.seAplica, true);
  assert.match(regla.motivoNoSeAplica, /Solo se aplica/);
});

test('Etapa 1: una regla de plantilla sin motor nuevo no se aplica', async () => {
  const res = await pedir('POST', `${ADMIN}/day-type-rules`,
    { day_type: 'SATURDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 50, template_id: templateId });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const regla = (await (await pedir('GET', `${ADMIN}/day-type-rules`)).json()).find((r) => r.id === id);
  assert.equal(regla.seAplica, false);
  assert.match(regla.motivoNoSeAplica, /motor de reglas nuevo/);
});

test('Etapa 1: no se pueden cargar dos reglas activas para el mismo tipo de día y alcance', async () => {
  // Ya hay HOLIDAY del convenio (test de arriba).
  const otra = await pedir('POST', `${ADMIN}/day-type-rules`,
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 50, convention_id: conv });
  assert.equal(otra.status, 409);
  assert.match((await otra.json()).error, /Ya hay una regla activa/);

  // Otro alcance (toda la empresa) sí se puede: el convenio gana sobre la empresa.
  const empresa = await pedir('POST', `${ADMIN}/day-type-rules`,
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 50 });
  assert.equal(empresa.status, 201);

  // Desactivada no choca; activarla después sí.
  const inactiva = await pedir('POST', `${ADMIN}/day-type-rules`,
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 75, convention_id: conv, active: false });
  assert.equal(inactiva.status, 201);
  const { id } = await inactiva.json();
  const activar = await pedir('PUT', `${ADMIN}/day-type-rules/${id}`,
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 75, active: true });
  assert.equal(activar.status, 409);

  // Editar la misma regla (sin cambiar el tipo de día) no choca consigo misma.
  const [[propia]] = await db.query(
    `SELECT id FROM day_type_overtime_rules WHERE convention_id = ? AND day_type = 'HOLIDAY' AND active = 1`, [conv]);
  const editar = await pedir('PUT', `${ADMIN}/day-type-rules/${propia.id}`,
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 100, active: true });
  assert.equal(editar.status, 200);
});
