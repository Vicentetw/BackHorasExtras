// E + F (2026-10-16): uso de cada plantilla, y que borrar / desactivar /
// archivar una plantilla nunca cambie en silencio el horario de días pasados.
// Ver motor-laboral/services/usoDePlantillas.js.
//
// Requiere el backend local corriendo y la migración 20261021 aplicada en la
// base local. Tenants descartables (999917/999939).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN = `${URL}/api/labor-engine/admin`;
const T = 999917;
const OTRA = 999939;
const PERMISOS = ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete', 'attendance:read'];
const LUNES_PASADO = '2026-08-03';

let h;
const tpl = {}; // nombre -> id
const emp = {}; // nombre -> { id, legajo }

const pedir = (metodo, url, body) => fetch(url, {
  method: metodo, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

async function cleanup() {
  for (const t of [T, OTRA]) {
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE c FROM employee_work_calendars c JOIN employees e ON e.id = c.employee_id WHERE e.tenant_id = ?', [t]);
    await db.query('DELETE FROM day_type_overtime_rules WHERE template_id IN (SELECT id FROM work_schedule_templates WHERE tenant_id = ?)', [t]);
    await db.query('DELETE h FROM work_schedule_template_config_history h JOIN work_schedule_templates w ON w.id = h.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_categories WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates w ON w.id = b.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

async function plantilla(tenant, nombre, { porDefecto = false, entrada = '07:00:00', salida = '13:00:00' } = {}) {
  const [r] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, created_at) VALUES (?, ?, 'FIXED', 1, ?, '2026-01-01 00:00:00')`,
    [tenant, nombre, porDefecto ? 1 : 0]);
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', ?, ?, 'WORK', 1)`,
    [r.insertId, entrada, salida]);
  return r.insertId;
}

async function empleado(tenant, nombre, legajo) {
  const [e] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report, activo) VALUES (?, ?, ?, 0, 1)', [legajo, nombre, tenant]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [legajo, tenant, String(legajo), nombre]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [legajo, tenant, e.insertId]);
  return { id: e.insertId, legajo };
}

const asignar = (empId, templateId, desde, hasta = null) =>
  db.query('INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
    [empId, T, templateId, desde, hasta]);

before(async () => {
  for (const id of [T, OTRA]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `Plantillas ${id} (test)`, `plantillas-${id}-test`]);
  }
  h = await getTestAuthHeaders('test-plantillas-uso', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  await cleanup();

  tpl.porDefecto = await plantilla(T, 'Por defecto (test)', { porDefecto: true });
  tpl.pasada = await plantilla(T, 'Usada en agosto (test)', { entrada: '10:00:00', salida: '14:00:00' });
  tpl.vigente = await plantilla(T, 'Usada hoy (test)');
  tpl.nueva = await plantilla(T, 'Nunca usada (test)');
  tpl.nueva2 = await plantilla(T, 'Nunca usada 2 (test)');
  tpl.conRegla = await plantilla(T, 'Con regla HE (test)');
  tpl.conCategoria = await plantilla(T, 'Sugerida por categoria (test)');
  tpl.conHistorial = await plantilla(T, 'Con historial (test)');
  tpl.ajena = await plantilla(OTRA, 'De otra empresa (test)');

  emp.agosto = await empleado(T, 'Tuvo la de agosto (test)', 917001);
  emp.hoy = await empleado(T, 'Tiene la vigente (test)', 917002);
  emp.sinHorario = await empleado(T, 'Sin horario propio (test)', 917003);
  emp.ajeno = await empleado(OTRA, 'De la otra (test)', 939001);

  await asignar(emp.agosto.id, tpl.pasada, '2026-08-01', '2026-08-31');
  await asignar(emp.hoy.id, tpl.vigente, '2026-01-01');
  await db.query('INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, ?)', [emp.ajeno.id, OTRA, tpl.ajena, '2026-01-01']);
  await db.query(`INSERT INTO day_type_overtime_rules (tenant_id, template_id, day_type, trigger_type, classification_type, rate, requires_authorization, active)
                  VALUES (NULL, ?, 'HOLIDAY', 'ALL_DAY', 'EXTRA', 100, 0, 1)`, [tpl.conRegla]);
  await db.query('INSERT INTO employee_categories (tenant_id, name, plantilla_sugerida_id) VALUES (?, ?, ?)', [T, 'Cat (test)', tpl.conCategoria]);
  await db.query(`INSERT INTO work_schedule_template_config_history (template_id, tolerancia_entrada_minutos, valid_from, valid_to) VALUES (?, 5, '2026-01-01', '2026-02-01')`, [tpl.conHistorial]);

  // Lunes 3/8 a las 9:20: con su plantilla de agosto (entra 10:00) es A TIEMPO;
  // con la por defecto (entra 7:00) sería TARDE. Sirve para ver si se perdió.
  for (const hora of ['09:20:00', '14:00:00']) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [emp.agosto.legajo, T, `${LUNES_PASADO} ${hora}`]);
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-plantillas-uso');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

async function uso() {
  const r = await pedir('GET', `${ADMIN}/templates/uso`);
  assert.equal(r.status, 200);
  const j = await r.json();
  return { ...j, de: (id) => j.plantillas.find((p) => p.id === id) };
}

async function estadoDelLunesPasado() {
  const r = await pedir('GET', `${URL}/attendance-range?from=${LUNES_PASADO}&to=${LUNES_PASADO}&employeeId=${emp.agosto.legajo}`);
  assert.equal(r.status, 200);
  const fila = (await r.json()).data.find((x) => String(x.employeeId) === String(emp.agosto.legajo));
  return fila.days.find((d) => d.date === LUNES_PASADO).status;
}

test('E: cuántas personas tiene cada plantilla (hoy, antes) y a cuántas mide la por defecto', async () => {
  const u = await uso();
  assert.deepEqual([u.de(tpl.pasada).hoy, u.de(tpl.pasada).antes, u.de(tpl.pasada).algunaVez], [0, 1, 1]);
  assert.deepEqual([u.de(tpl.vigente).hoy, u.de(tpl.vigente).antes], [1, 0]);
  assert.equal(u.de(tpl.nueva).algunaVez, 0);
  assert.equal(u.de(tpl.nueva).puedeBorrarse, true);
  assert.equal(u.porDefectoId, tpl.porDefecto);
  assert.equal(u.de(tpl.porDefecto).esPorDefecto, true);
  // Hoy la miden: el que solo la tuvo en agosto y el que nunca tuvo horario.
  assert.equal(u.de(tpl.porDefecto).personasPorDefecto, 2);
  assert.equal(u.asignacionesRotas, 0);
});

test('E: aislamiento -- no muestra ni cuenta plantillas de otra empresa', async () => {
  const u = await uso();
  assert.equal(u.de(tpl.ajena), undefined);
  assert.equal(u.plantillas.length, 8);
});

test('F: la que nunca se usó y no tiene referencias se puede borrar', async () => {
  assert.equal((await pedir('DELETE', `${ADMIN}/templates/${tpl.nueva}`)).status, 200);
  const [[t]] = await db.query('SELECT COUNT(*) n FROM work_schedule_templates WHERE id = ?', [tpl.nueva]);
  assert.equal(t.n, 0);
});

test('F: una usada en el pasado NO se borra, y el pasado sigue igual', async () => {
  assert.equal(await estadoDelLunesPasado(), 'OnTime', 'con su plantilla de agosto (entra 10:00)');
  const r = await pedir('DELETE', `${ADMIN}/templates/${tpl.pasada}`);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /días pasados/);
  const [[a]] = await db.query('SELECT COUNT(*) n FROM employee_work_calendars WHERE template_id = ?', [tpl.pasada]);
  assert.equal(a.n, 1, 'la asignación sigue');
  assert.equal(await estadoDelLunesPasado(), 'OnTime');
});

// Control: muestra POR QUÉ hace falta el bloqueo. El motor ignora las
// asignaciones a plantillas inactivas también en fechas pasadas (auditoría
// 2026-10-16). Se desactiva por fuera de la API y se vuelve a activar.
test('control: si la plantilla se desactiva por fuera de la API, el pasado SÍ cambia', async () => {
  await db.query('UPDATE work_schedule_templates SET active = 0 WHERE id = ?', [tpl.pasada]);
  try {
    assert.equal(await estadoDelLunesPasado(), 'Late', 'sin su plantilla, se la mide con la por defecto (entra 7:00)');
  } finally {
    await db.query('UPDATE work_schedule_templates SET active = 1 WHERE id = ?', [tpl.pasada]);
  }
  assert.equal(await estadoDelLunesPasado(), 'OnTime');
});

test('F: con reglas de horas extra, categorías o historial no se borra (409 claro, no error 500)', async () => {
  for (const [id, texto] of [[tpl.conRegla, /regla de horas extra/], [tpl.conCategoria, /categoría/], [tpl.conHistorial, /configuración guardado/]]) {
    const r = await pedir('DELETE', `${ADMIN}/templates/${id}`);
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, texto);
  }
});

test('F: la por defecto no se borra ni se desactiva', async () => {
  const r = await pedir('DELETE', `${ADMIN}/templates/${tpl.porDefecto}`);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /por defecto/);
  const p = await pedir('PUT', `${ADMIN}/templates/${tpl.porDefecto}`, { name: 'Por defecto (test)', type: 'FIXED', active: false, is_default: true });
  assert.equal(p.status, 409);
});

test('F: desactivar una usada se impide (cambiaría el pasado); una nunca usada se puede', async () => {
  const r = await pedir('PUT', `${ADMIN}/templates/${tpl.pasada}`, { name: 'Usada en agosto (test)', type: 'FIXED', active: false });
  assert.equal(r.status, 409);
  assert.equal(await estadoDelLunesPasado(), 'OnTime');
  assert.equal((await pedir('PUT', `${ADMIN}/templates/${tpl.nueva2}`, { name: 'Nunca usada 2 (test)', type: 'FIXED', active: false })).status, 200);
  const [[t]] = await db.query('SELECT active FROM work_schedule_templates WHERE id = ?', [tpl.nueva2]);
  assert.equal(Number(t.active), 0);
});

test('F: editar sin mandar "active" conserva el valor (antes la desactivaba en silencio)', async () => {
  assert.equal((await pedir('PUT', `${ADMIN}/templates/${tpl.pasada}`, { name: 'Usada en agosto (test)', type: 'FIXED' })).status, 200);
  const [[t]] = await db.query('SELECT active FROM work_schedule_templates WHERE id = ?', [tpl.pasada]);
  assert.equal(Number(t.active), 1);
});

test('F: archivar -- no con personas asignadas hoy; sí con solo pasado, y el pasado no cambia', async () => {
  const hoy = await pedir('POST', `${ADMIN}/templates/${tpl.vigente}/archivar`);
  assert.equal(hoy.status, 409);
  assert.match((await hoy.json()).error, /asignada/);
  assert.equal((await pedir('POST', `${ADMIN}/templates/${tpl.porDefecto}/archivar`)).status, 409);
  const cat = await pedir('POST', `${ADMIN}/templates/${tpl.conCategoria}/archivar`);
  assert.equal(cat.status, 409, 'una categoría la sugiere');
  assert.match((await cat.json()).error, /categoría/);

  assert.equal((await pedir('POST', `${ADMIN}/templates/${tpl.pasada}/archivar`)).status, 200);
  assert.equal(await estadoDelLunesPasado(), 'OnTime', 'archivada sigue valiendo para lo ya asignado');
  const u = await uso();
  assert.equal(u.de(tpl.pasada).archivada, true);
});

test('F: una archivada no se puede asignar (ni de a uno ni en bloque); desarchivada sí', async () => {
  const uno = await pedir('POST', `${ADMIN}/employees/${emp.sinHorario.id}/calendar`, { template_id: tpl.pasada, valid_from: '2026-11-01' });
  assert.equal(uno.status, 409);
  const bloque = await pedir('POST', `${ADMIN}/employees/bulk-assign-calendar`, { employeeIds: [emp.sinHorario.id], template_id: tpl.pasada, valid_from: '2026-11-01' });
  assert.equal(bloque.status, 409);
  assert.equal((await pedir('POST', `${ADMIN}/templates/${tpl.pasada}/desarchivar`)).status, 200);
  assert.equal((await uso()).de(tpl.pasada).archivada, false);
});

test('aislamiento: borrar, archivar o editar una plantilla de otra empresa da 404', async () => {
  assert.equal((await pedir('DELETE', `${ADMIN}/templates/${tpl.ajena}`)).status, 404);
  assert.equal((await pedir('POST', `${ADMIN}/templates/${tpl.ajena}/archivar`)).status, 404);
  assert.equal((await pedir('PUT', `${ADMIN}/templates/${tpl.ajena}`, { name: 'x', type: 'FIXED', active: false })).status, 404);
  const [[t]] = await db.query('SELECT active FROM work_schedule_templates WHERE id = ?', [tpl.ajena]);
  assert.equal(Number(t.active), 1);
});

test('E: asignaciones a plantillas que no existen se cuentan (no se reparan)', async () => {
  await asignar(emp.sinHorario.id, 99999999, '2026-05-01', '2026-05-31');
  assert.equal((await uso()).asignacionesRotas, 1);
  const [[a]] = await db.query('SELECT COUNT(*) n FROM employee_work_calendars WHERE template_id = 99999999');
  assert.equal(a.n, 1, 'no se tocó');
  await db.query('DELETE FROM employee_work_calendars WHERE template_id = 99999999');
});

// Asignaciones rotas: el administrador las ve y las quita él mismo. El
// cálculo ya las ignoraba, así que quitarlas no cambia ningún número.
test('asignaciones rotas: se listan y se quitan sin cambiar el cálculo; nunca una válida ni de otra empresa', async () => {
  // Rota: a una plantilla que no existe, encima del mes que ya tiene horario.
  const [r] = await db.query('INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, 99999998, ?, ?)',
    [emp.agosto.id, T, '2026-08-01', '2026-08-31']);
  const rota = r.insertId;
  const antes = await estadoDelLunesPasado();

  const lista = await (await pedir('GET', `${ADMIN}/templates/asignaciones-rotas`)).json();
  assert.deepEqual(lista.map((x) => [x.id, x.legajo, x.motivo]), [[rota, emp.agosto.legajo, 'La plantilla ya no existe']]);

  // Mandar también el id de una asignación VÁLIDA y el de una de OTRA empresa: no se tocan.
  const [[valida]] = await db.query('SELECT id FROM employee_work_calendars WHERE employee_id = ? AND template_id = ?', [emp.agosto.id, tpl.pasada]);
  const [[ajena]] = await db.query('SELECT id FROM employee_work_calendars WHERE employee_id = ?', [emp.ajeno.id]);
  const res = await (await pedir('POST', `${ADMIN}/templates/asignaciones-rotas/quitar`, { ids: [rota, valida.id, ajena.id] })).json();
  assert.equal(res.quitadas, 1);
  const [[quedan]] = await db.query('SELECT COUNT(*) n FROM employee_work_calendars WHERE id IN (?)', [[valida.id, ajena.id]]);
  assert.equal(quedan.n, 2, 'la válida y la ajena siguen');
  assert.equal((await uso()).asignacionesRotas, 0);
  assert.equal(await estadoDelLunesPasado(), antes, 'el cálculo no cambió');
});

test('asignaciones rotas: un usuario de otra empresa no las ve ni las puede quitar', async () => {
  const [r] = await db.query('INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, 99999997, ?, ?)',
    [emp.sinHorario.id, T, '2026-05-01', '2026-05-31']);
  const hOtra = await getTestAuthHeaders('test-plantillas-uso-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  try {
    const lista = await (await fetch(`${ADMIN}/templates/asignaciones-rotas`, { headers: hOtra })).json();
    assert.equal(lista.length, 0);
    const res = await (await fetch(`${ADMIN}/templates/asignaciones-rotas/quitar`, {
      method: 'POST', headers: { ...hOtra, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [r.insertId] }),
    })).json();
    assert.equal(res.quitadas, 0);
    const [[sigue]] = await db.query('SELECT COUNT(*) n FROM employee_work_calendars WHERE id = ?', [r.insertId]);
    assert.equal(sigue.n, 1);
  } finally {
    await db.query('DELETE FROM employee_work_calendars WHERE id = ?', [r.insertId]);
    await deleteTestUser('test-plantillas-uso-otra');
  }
});

// Columna "Horario" de Horarios de empleados: la plantilla que rige HOY, con
// la misma regla que el cálculo (si hay dos superpuestas, la que empezó más tarde).
test('horario vigente: el mismo que usa el cálculo, también con asignaciones superpuestas', async () => {
  const hoy = new Date();
  const fecha = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
  // emp.hoy tiene "vigente" desde enero; se le superpone "pasada" desde ayer, sin cerrar la otra.
  const [r] = await db.query('INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, ?)',
    [emp.hoy.id, T, tpl.pasada, fecha(ayer)]);
  try {
    const lista = await (await pedir('GET', `${ADMIN}/calendar-assignments/vigentes`)).json();
    const de = (id) => lista.find((x) => x.employee_id === id);
    assert.equal(de(emp.hoy.id).template_id, tpl.pasada, 'gana la que empezó más tarde');
    assert.equal(de(emp.agosto.id), undefined, 'la de agosto ya terminó: hoy usa la por defecto');
    assert.equal(de(emp.sinHorario.id), undefined);
    assert.equal(de(emp.ajeno.id), undefined, 'no muestra personas de otra empresa');
    // El cálculo de hoy usa esa misma plantilla.
    const repo = require('../motor-laboral/repositories/scheduleRepository');
    const mapa = await repo.findAssignedScheduleMapForDate(fecha(hoy), [emp.hoy.legajo], db, T);
    assert.equal(mapa[emp.hoy.legajo].templateId, tpl.pasada);
  } finally {
    await db.query('DELETE FROM employee_work_calendars WHERE id = ?', [r.insertId]);
  }
});
