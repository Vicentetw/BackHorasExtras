// "Fichajes" de una persona (GET /api/fichajes-persona, 2026-10-19): todo lo
// que fichó en un período, con el horario de cada día y el marcador previo de
// cada fichaje. Tiene que dar lo mismo que /api/fichajes-del-dia (una sola
// verdad) y mostrar el marcador aunque se lo haya llevado otra persona.
// Requiere el backend local. Tenants descartables 999976 / 999975.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999976;
const OTRA = 999975;
const LEGAJO = 976001;
const OTRO = 976002; // otra persona de la misma empresa
const M_SALIDA = 976005; // marcador salida particular
const M_REGRESO = 976006; // marcador regreso particular
const PERMISOS = ['attendance:read'];
let h;
let hOtra;

async function limpiar() {
  for (const t of [T, OTRA]) {
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE c FROM employee_work_calendars c JOIN employees e ON e.id = c.employee_id WHERE e.tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates w ON w.id = b.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

async function persona(legajo, nombre, plantilla) {
  const [e] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report, activo, fecha_alta) VALUES (?, ?, ?, 0, 1, \'2020-01-01\')', [legajo, nombre, T]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [legajo, T, String(legajo), nombre]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [legajo, T, e.insertId]);
  if (plantilla) await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [e.insertId, T, plantilla]);
}

const fichar = (userId, cuando) => db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, T, cuando]);

before(async () => {
  for (const t of [T, OTRA]) await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [t, `Fichajes persona ${t} (test)`, `fichajes-persona-${t}-test`]);
  await limpiar();
  h = await getTestAuthHeaders('test-fichajes-persona', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  hOtra = await getTestAuthHeaders('test-fichajes-persona-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  const [tp] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Oficina 8 a 17 (test)', 'FIXED', 1, 1)`, [T]);
  for (const dia of [1, 2, 3, 4, 5]) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Jornada', '08:00:00', '17:00:00', 'WORK', 1)`, [tp.insertId, dia]);
  }
  await persona(LEGAJO, 'Persona Fichajes (test)', tp.insertId);
  await persona(OTRO, 'Otra Persona (test)', tp.insertId);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, \'5\', \'Marcador Salida\'), (?, ?, \'6\', \'Marcador Regreso\')', [M_SALIDA, T, M_REGRESO, T]);
  await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES
    (?, ?, '5', 'Salida particular', 'PARTICULAR', 'SALIDA', 1), (?, ?, '6', 'Regreso particular', 'PARTICULAR', 'REGRESO', 1)`, [M_SALIDA, T, M_REGRESO, T]);
  // Lunes 07/09: sale y vuelve con marcadores (se le asignan).
  await fichar(LEGAJO, '2026-09-07 08:00:00');
  await fichar(M_SALIDA, '2026-09-07 12:00:00');
  await fichar(LEGAJO, '2026-09-07 12:00:05');
  await fichar(M_REGRESO, '2026-09-07 13:00:00');
  await fichar(LEGAJO, '2026-09-07 13:00:04');
  await fichar(LEGAJO, '2026-09-07 17:00:00');
  // Martes 08/09: el marcador se lo lleva OTRA persona que ficha en el medio.
  await fichar(LEGAJO, '2026-09-08 08:00:00');
  await fichar(M_SALIDA, '2026-09-08 12:00:00');
  await fichar(OTRO, '2026-09-08 12:00:03');
  await fichar(LEGAJO, '2026-09-08 12:00:08');
  await fichar(LEGAJO, '2026-09-08 17:00:00');
  // Sábado 12/09: fichó en su franco.
  await fichar(LEGAJO, '2026-09-12 09:00:00');
  await fichar(LEGAJO, '2026-09-12 12:00:00');
});

after(async () => {
  await limpiar();
  await deleteTestUser('test-fichajes-persona');
  await deleteTestUser('test-fichajes-persona-otra');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

const pedir = (ruta, headers = h) => fetch(URL + ruta, { headers });

test('el período entero, con el horario de cada día y el marcador previo', async () => {
  const r = await pedir(`/api/fichajes-persona?legajo=${LEGAJO}&from=2026-09-01&to=2026-09-30`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.dias.length, 30, 'todos los días, también los que no fichó');
  const lunes = j.dias.find((d) => d.fecha === '2026-09-07');
  assert.deepEqual([lunes.horario.plantilla, lunes.horario.entrada, lunes.horario.salida, lunes.horario.trabaja], ['Oficina 8 a 17 (test)', '08:00', '17:00', true]);
  const salida = lunes.fichajes.find((f) => f.en.endsWith('12:00:05'));
  assert.equal(salida.marcadorPrevio.tarjeta, '5');
  assert.equal(salida.marcadorPrevio.segundosAntes, 5);
  assert.equal(salida.marcadorPrevio.asignado, true, 'el sistema se lo asignó');
  assert.ok(salida.tipos.some((t) => t.categoria === 'PARTICULAR'));
  assert.equal(lunes.fichajes.find((f) => f.en.endsWith('08:00:00')).marcadorPrevio, null, 'sin marcador cerca: nada');

  const martes = j.dias.find((d) => d.fecha === '2026-09-08');
  const m = martes.fichajes.find((f) => f.en.endsWith('12:00:08')).marcadorPrevio;
  assert.equal(m.tarjeta, '5');
  assert.equal(m.asignado, false, 'se lo llevó la otra persona');
  assert.equal(m.otroFichajeEnMedio, true);

  const sabado = j.dias.find((d) => d.fecha === '2026-09-12');
  assert.equal(sabado.horario.trabaja, false, 'franco');
  assert.equal(sabado.fichajes.length, 2);
});

test('una sola verdad: cada día igual a Fichajes del día y a Presentismo', async () => {
  const j = await (await pedir(`/api/fichajes-persona?legajo=${LEGAJO}&from=2026-09-01&to=2026-09-30`)).json();
  for (const fecha of ['2026-09-07', '2026-09-08', '2026-09-12']) {
    const dia = await (await pedir(`/api/fichajes-del-dia?fecha=${fecha}&employeeId=${LEGAJO}`)).json();
    const mio = j.dias.find((d) => d.fecha === fecha).fichajes.map(({ reloj, marcadorPrevio, ...x }) => x);
    assert.deepEqual(mio, dia.empleados[String(LEGAJO)], fecha);
  }
  const ar = await (await pedir(`/attendance-range?from=2026-09-01&to=2026-09-30&employeeId=${LEGAJO}`)).json();
  const fila = ar.data.find((x) => String(x.employeeId) === String(LEGAJO));
  assert.equal(j.dias.reduce((s, d) => s + d.horasExtraMinutos, 0), fila.overtimeMinutes);
  for (const d of fila.days) assert.equal(j.dias.find((x) => x.fecha === d.date).estado, d.status, d.date);
  // Si el motor le asignó un marcador a un fichaje, se muestra ESE como asignado.
  for (const d of j.dias) for (const f of d.fichajes) {
    const conMarcador = f.tipos.find((t) => t.marcador);
    if (conMarcador) assert.equal(f.marcadorPrevio && f.marcadorPrevio.asignado, true, f.en);
  }
});

test('el horario del día solo viene en el detalle de una persona', async () => {
  const todos = await (await pedir('/attendance-range?from=2026-09-07&to=2026-09-07')).json();
  for (const r of todos.data) for (const d of r.days || []) assert.equal(d.horario, undefined);
});

test('validación y aislamiento', async () => {
  assert.equal((await pedir(`/api/fichajes-persona?legajo=${LEGAJO}&from=2026-09-01&to=2026-10-15`)).status, 400, 'más de 31 días');
  assert.equal((await pedir(`/api/fichajes-persona?legajo=${LEGAJO}&from=2026-09-10&to=2026-09-01`)).status, 400);
  assert.equal((await pedir(`/api/fichajes-persona?legajo=${LEGAJO}&from=2026-09-01&to=2026-09-30`, hOtra)).status, 404, 'otra empresa no la ve');
});
