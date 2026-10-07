// Horarios rotativos de punta a punta (DISENO_HORARIOS_ROTATIVOS.md, etapa 1):
// turnos (con turno partido), plantilla rotativa, "dia 1" al asignar, y que
// Presentismo (diario y mensual) use el turno del dia del ciclo. Aislamiento:
// la empresa B no ve ni usa nada de la A.
//
// AGUILAR (3056), 4x1 real de abril-septiembre 2026: Mañana, Noche, (sale de
// la noche), Tarde, Franco. Dia 1 = 15/06/2026.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000) y la
// migracion 20261015 aplicada en la base local.
// Tenants descartables propios (999957/999969), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const API = `${BASE_URL}/api/labor-engine/admin`;
const A = 999957;
const B = 999969;
const UID_A = 'test-rotativos-a';
const UID_B = 'test-rotativos-b';
const SERENO = 901501;
const COMERCIO = 901502;
let hA; let hB;
const turnos = {};
let plantillaSereno; let plantillaComercio; let empSereno; let empComercio;

const pedir = (url, h, method = 'GET', body) => fetch(url, {
  method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const lectura = (userId, cuando) => db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, A, cuando]);

async function cleanup() {
  for (const t of [A, B]) {
    await db.query('DELETE d FROM template_cycle_days d JOIN work_schedule_templates w ON w.id = d.template_id WHERE w.tenant_id = ?', [t]);
    for (const tabla of ['employee_work_calendars', 'work_schedule_templates', 'shift_definitions', 'Checkins', 'user_employee_map', 'users', 'employees']) {
      await db.query(`DELETE FROM ${tabla} WHERE tenant_id = ?`, [t]);
    }
  }
}

before(async () => {
  for (const [id, code] of [[A, 'rotativos-a'], [B, 'rotativos-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await cleanup();
  const permisos = ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete', 'attendance:read'];
  hA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: A, permissions: permisos });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: B, permissions: permisos });
  for (const [legajo, nombre, uid] of [[SERENO, 'AGUILAR (test)', 8891501], [COMERCIO, 'Comercio (test)', 8891502]]) {
    const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)`, [legajo, nombre, A]);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [uid, A, String(legajo), nombre]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [uid, A, e.insertId]);
    if (legajo === SERENO) empSereno = e.insertId; else empComercio = e.insertId;
  }
  // AGUILAR: 15 Mañana, 16 Noche (sale el 17), 18 Tarde, 19 Franco.
  for (const c of ['2026-06-15 07:00:00', '2026-06-15 15:02:00', '2026-06-16 22:58:00', '2026-06-17 07:05:00', '2026-06-18 14:59:00', '2026-06-18 23:04:00']) {
    await lectura(8891501, c);
  }
  // Comercio: 07-12 y 16-20 el 15/06.
  for (const c of ['2026-06-15 06:58:00', '2026-06-15 12:01:00', '2026-06-15 15:59:00', '2026-06-15 20:02:00']) {
    await lectura(8891502, c);
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('turnos: se crean con uno o varios tramos, se validan, y son de cada empresa', async () => {
  for (const [nombre, tramos] of [
    ['Mañana', [{ inicio: '07:00', fin: '15:00' }]],
    ['Tarde', [{ inicio: '15:00', fin: '23:00' }]],
    ['Noche', [{ inicio: '23:00', fin: '07:00' }]],
    ['Comercio partido', [{ inicio: '07:00', fin: '12:00' }, { inicio: '16:00', fin: '20:00' }]],
  ]) {
    const r = await pedir(`${API}/turnos`, hA, 'POST', { nombre, tramos });
    assert.equal(r.status, 201, await r.clone().text());
    turnos[nombre] = (await r.json()).id;
  }
  assert.equal((await pedir(`${API}/turnos`, hA, 'POST', { nombre: 'Mañana', tramos: [{ inicio: '07:00', fin: '15:00' }] })).status, 409, 'nombre repetido');
  assert.equal((await pedir(`${API}/turnos`, hA, 'POST', { nombre: 'Mal', tramos: [{ inicio: '07:00', fin: '12:00' }, { inicio: '11:00', fin: '20:00' }] })).status, 400, 'tramos superpuestos');
  assert.equal((await pedir(`${API}/turnos`, hA, 'POST', { nombre: 'Mal', tramos: [] })).status, 400);

  const lista = await (await pedir(`${API}/turnos`, hA)).json();
  const noche = lista.find((t) => t.nombre === 'Noche');
  assert.deepEqual(noche.tramos, [{ inicio: '23:00', fin: '07:00', cruzaMedianoche: true }], 'la noche se marca sola como "cruza medianoche"');
  assert.equal(lista.find((t) => t.nombre === 'Comercio partido').tramos.length, 2);

  assert.deepEqual(await (await pedir(`${API}/turnos`, hB)).json(), [], 'la otra empresa no ve los turnos');
  assert.equal((await pedir(`${API}/turnos/${turnos.Noche}`, hB, 'PUT', { nombre: 'X', tramos: [{ inicio: '01:00', fin: '02:00' }] })).status, 404);
  assert.equal((await pedir(`${API}/turnos/${turnos.Noche}`, hB, 'DELETE')).status, 404);
});

test('plantilla rotativa: se guarda el ciclo, solo con turnos de la misma empresa', async () => {
  const crear = async (name) => {
    const r = await pedir(`${API}/templates`, hA, 'POST', { name, type: 'FIXED', active: true });
    return (await r.json()).id;
  };
  plantillaSereno = await crear('Sereno 4x1 (test)');
  plantillaComercio = await crear('Comercio rotativo (test)');
  const ciclo = { largo: 5, dias: [turnos['Mañana'], turnos.Noche, null, turnos.Tarde, null] };
  assert.equal((await pedir(`${API}/templates/${plantillaSereno}/ciclo`, hB, 'PUT', ciclo)).status, 404, 'otra empresa');
  assert.equal((await pedir(`${API}/templates/${plantillaSereno}/ciclo`, hA, 'PUT', { largo: 5, dias: [null, null] })).status, 400);
  const r = await pedir(`${API}/templates/${plantillaSereno}/ciclo`, hA, 'PUT', ciclo);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await (await pedir(`${API}/templates/${plantillaSereno}/ciclo`, hA)).json(), { modo: 'ROTATIVO', largo: 5, dias: ciclo.dias });
  assert.equal((await pedir(`${API}/templates/${plantillaComercio}/ciclo`, hA, 'PUT', { largo: 2, dias: [turnos['Comercio partido'], null] })).status, 200);

  // Un turno de OTRA empresa no se puede usar.
  const [tb] = await db.query(`INSERT INTO shift_definitions (tenant_id, nombre) VALUES (?, 'De B')`, [B]);
  assert.equal((await pedir(`${API}/templates/${plantillaComercio}/ciclo`, hA, 'PUT', { largo: 2, dias: [tb.insertId, null] })).status, 400);
  // Un turno que usa una rotativa no se puede borrar.
  assert.equal((await pedir(`${API}/turnos/${turnos.Noche}`, hA, 'DELETE')).status, 409);
});

test('asignar con "dia 1": AGUILAR 4x1 desde el 15/06 y el comercio partido', async () => {
  const r = await pedir(`${API}/employees/${empSereno}/calendar`, hA, 'POST', { template_id: plantillaSereno, valid_from: '2026-06-01', cycle_start_date: '2026-06-15' });
  assert.equal(r.status, 201, await r.clone().text());
  assert.equal((await pedir(`${API}/employees/${empComercio}/calendar`, hA, 'POST', { template_id: plantillaComercio, valid_from: '2026-06-15' })).status, 201);
  assert.equal((await pedir(`${API}/employees/${empSereno}/calendar`, hA, 'POST', { template_id: plantillaSereno, valid_from: '2026-06-01', cycle_start_date: '15/06/2026' })).status, 400);
  const hist = await (await pedir(`${API}/employees/${empSereno}/calendar`, hA)).json();
  assert.equal(String(hist[0].cycle_start_date).slice(0, 10), '2026-06-15', 'el historial muestra el dia 1');
});

test('Presentismo mensual: cada dia usa el turno de su dia del ciclo (noche incluida)', async () => {
  const res = await (await fetch(`${BASE_URL}/attendance-range?from=2026-06-15&to=2026-06-19&employeeId=${SERENO}`, { headers: hA })).json();
  const dias = Object.fromEntries(res.data[0].days.map((d) => [d.date, d]));
  assert.equal(dias['2026-06-15'].status, 'OnTime', 'dia 1: Mañana, entró 07:00');
  assert.equal(dias['2026-06-16'].status, 'OnTime', 'dia 2: Noche, entró 22:58');
  assert.equal(dias['2026-06-16'].firstCheckin, '22:58');
  assert.equal(dias['2026-06-17'].status, 'NonWorkDay', 'dia 3: sin turno; su 07:05 es la salida de la noche anterior');
  assert.equal(dias['2026-06-18'].status, 'OnTime', 'dia 4: Tarde, entró 14:59');
  assert.equal(dias['2026-06-19'].status, 'NonWorkDay', 'dia 5: franco');
  for (const d of Object.values(dias)) assert.equal(d.fueraDeHorario || null, null, `${d.date}: no es "fuera de horario"`);
  assert.equal(res.data[0].absent, 0);
});

test('Presentismo diario: el turno partido del comercio y la noche del sereno', async () => {
  const d15 = await (await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-15`, { headers: hA })).json();
  const comercio = d15.attendance.find((a) => String(a.employeeId) === String(COMERCIO));
  assert.equal(comercio.status, 'OnTime', 'cumplio los dos tramos');
  assert.equal(comercio.schedule.blocks.length, 2);
  const d16 = await (await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-06-16`, { headers: hA })).json();
  const sereno = d16.attendance.find((a) => String(a.employeeId) === String(SERENO));
  assert.equal(sereno.status, 'OnTime');
  assert.equal(String(sereno.schedule.timeEntrance).slice(0, 5), '23:00');
  const d16c = d16.attendance.find((a) => String(a.employeeId) === String(COMERCIO));
  assert.equal(d16c.status, 'NonWorkDay', 'el comercio rotativo descansa el dia 2');
});

test('la plantilla rotativa nunca queda como la "por defecto" de la empresa', async () => {
  await db.query('UPDATE work_schedule_templates SET is_default = 1 WHERE id = ?', [plantillaSereno]);
  const scheduleRepository = require('../motor-laboral/repositories/scheduleRepository');
  const def = await scheduleRepository.findTenantTemplate(null, A, db);
  assert.notEqual(def && def.id, plantillaSereno);
});
