// "Ver el reloj" (/api/ver-reloj) y el aviso "Fuera de su horario" (vista
// diaria, mensual y configuracion). Reproduce los casos reales del 07/10/2026:
//   BELCARO: marcador 4, ficha, marcador 4 otra vez, ficha -- a las 05:08 con
//            plantilla de 07:00 a 13:40.
//   El 10 de AVP: el marcador esta cargado con USERID 2 y el reloj lo manda
//            como 10 -> el sistema no lo toma; "Ver el reloj" tiene que decirlo.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999939/999949), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999939;
const OTRA = 999949;
const UID = 'test-ver-reloj';
const UID_OTRA = 'test-ver-reloj-otra';
const LEGAJO = 901401;
const USERID = 8891401;
const IP = '10.99.0.1';
let headers; let headersOtra;

const post = (url, body) => fetch(`${BASE_URL}${url}`, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const lectura = (userId, cuando) => db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?)', [userId, T, cuando, IP]);

async function cleanup() {
  await db.query('DELETE sb FROM shift_blocks sb JOIN work_schedule_templates w ON w.id = sb.template_id WHERE w.tenant_id = ?', [T]);
  for (const t of ['employee_work_calendars', 'work_schedule_templates', 'specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [T]);
  }
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [T, OTRA]);
}

before(async () => {
  for (const [id, code] of [[T, 'ver-reloj'], [OTRA, 'ver-reloj-otra']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await cleanup();
  const permisos = ['attendance:read', 'schedules:read', 'schedules:update'];
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: T, permissions: permisos });
  headersOtra = await getTestAuthHeaders(UID_OTRA, { isSuperadmin: false, tenantId: OTRA, permissions: permisos });

  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, 'BELCARO (test)', ?, '2020-01-01', 0, 1)`, [LEGAJO, T]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID, T, String(LEGAJO), 'BELCARO']);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [USERID, T, emp.insertId]);
  const [tpl] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Administración (test)', 'fixed', 1, 0)`, [T]);
  for (let dia = 1; dia <= 5; dia++) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Turno', '07:00:00', '13:40:00', 'WORK', 1)`, [tpl.insertId, dia]);
  }
  await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [emp.insertId, T, tpl.insertId]);
  // Marcadores: el 4 bien configurado (USERID 4); el "10" cargado con USERID 2
  // y numero de tarjeta 10, tal cual esta en AVP.
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (4, ?, '4', '4'), (2, ?, '10', '10')`, [T, T]);
  await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (4, ?, '4', '4', 'OFICIAL', 'SALIDA', 1), (2, ?, '10', '10', 'HE', 'REGRESO', 1)`, [T, T]);

  // Lunes 04/05/2026: el gesto de BELCARO, a las 05:08.
  await lectura(4, '2026-05-04 05:08:20');
  await lectura(USERID, '2026-05-04 05:08:23');
  await lectura(4, '2026-05-04 05:08:42');
  await lectura(USERID, '2026-05-04 05:08:46');
  // Martes 05/05: el 10 llega como 10 (no como 2), y despues ficha a horario.
  await lectura(10, '2026-05-05 07:04:10');
  await lectura(USERID, '2026-05-05 07:04:13');
  await lectura(USERID, '2026-05-05 13:45:00');
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await deleteTestUser(UID_OTRA);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

const verReloj = async (en, h = headers, legajo = LEGAJO) => {
  const res = await fetch(`${BASE_URL}/api/ver-reloj?legajo=${legajo}&en=${encodeURIComponent(en)}&margen=60`, { headers: h });
  return { status: res.status, body: await res.json() };
};

test('ver el reloj: muestra los dos marcadores 4, sus lecturas y como las tomo el sistema', async () => {
  const { status, body } = await verReloj('2026-05-04 05:08:23');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.lecturas.map((l) => [l.hora, l.tipo, l.numero || l.legajo]), [
    ['05:08:20', 'marcador', '4'], ['05:08:23', 'persona', String(LEGAJO)],
    ['05:08:42', 'marcador', '4'], ['05:08:46', 'persona', String(LEGAJO)],
  ]);
  assert.equal(body.lecturas[0].texto, 'Salida oficial');
  assert.ok(body.lecturas[1].esLaPersona);
  assert.match(body.lecturas[1].sistema, /Entrada/, 'la interpretacion es la misma que la vista diaria');
  assert.ok(body.avisos.includes('Nadie más usó este reloj en esos minutos.'));
});

test('ver el reloj: un marcador que el sistema no toma (el 10 cargado como 2) se muestra y se avisa', async () => {
  const { body } = await verReloj('2026-05-05 07:04:13');
  const diez = body.lecturas.find((l) => l.tipo === 'marcador');
  assert.deepEqual([diez.numero, diez.texto, diez.reconocido], ['10', 'Fin de horas extra', false]);
  assert.ok(body.avisos.some((a) => /no se toma en cuenta/.test(a)));
});

test('ver el reloj: pide los datos, no encuentra fichajes inventados, y otra empresa no ve nada', async () => {
  assert.equal((await fetch(`${BASE_URL}/api/ver-reloj?legajo=${LEGAJO}`, { headers })).status, 400);
  assert.equal((await verReloj('2026-05-04 05:08:24')).status, 404, 'no hay fichaje a esa hora exacta');
  assert.equal((await verReloj('2026-05-04 05:08:23', headersOtra)).status, 404, 'otra empresa: como si no existiera');
});

test('fuera de horario (vista diaria): fichó a las 05:08 con plantilla de 07:00 a 13:40', async () => {
  const d = await (await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-05-04`, { headers })).json();
  const f = d.attendance.find((a) => String(a.employeeId) === String(LEGAJO));
  assert.equal(f.fueraDeHorario.tipo, 'no_coincide');
  assert.match(f.fueraDeHorario.texto, /Administración \(test\)/);
  assert.equal(d.summary.fueraDeHorario, 1);
  const martes = await (await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-05-05`, { headers })).json();
  assert.equal(martes.attendance.find((a) => String(a.employeeId) === String(LEGAJO)).fueraDeHorario, null, 'el martes fichó a horario');
});

test('fuera de horario (mensual): cuenta el dia en el listado y lo explica en el detalle', async () => {
  const lista = await (await fetch(`${BASE_URL}/attendance-range?from=2026-05-04&to=2026-05-05`, { headers })).json();
  assert.equal(lista.data.find((r) => String(r.employeeId) === String(LEGAJO)).fueraDeHorarioDays, 1, 'el listado sin detalle tambien cuenta');
  const det = await (await fetch(`${BASE_URL}/attendance-range?from=2026-05-04&to=2026-05-05&employeeId=${LEGAJO}`, { headers })).json();
  const dias = det.data[0].days;
  assert.equal(dias.find((x) => x.date === '2026-05-04').fueraDeHorario.tipo, 'no_coincide');
  assert.equal(dias.find((x) => x.date === '2026-05-05').fueraDeHorario, null);
});

test('fuera de horario: default 60 min, y vacio lo apaga', async () => {
  const cfg = await (await fetch(`${BASE_URL}/config/avisos-asistencia`, { headers })).json();
  assert.equal(cfg.fueraDeHorarioMinutos, 60);
  assert.equal((await post('/config/avisos-asistencia', { fueraDeHorarioMinutos: 2 })).status, 400, 'minimo 5');
  assert.equal((await post('/config/avisos-asistencia', { fueraDeHorarioMinutos: '' })).status, 200);
  const d = await (await fetch(`${BASE_URL}/api/labor-engine/attendance/2026-05-04`, { headers })).json();
  assert.equal(d.attendance.find((a) => String(a.employeeId) === String(LEGAJO)).fueraDeHorario, null);
  const lista = await (await fetch(`${BASE_URL}/attendance-range?from=2026-05-04&to=2026-05-05`, { headers })).json();
  assert.equal(lista.data.find((r) => String(r.employeeId) === String(LEGAJO)).fueraDeHorarioDays, 0);
});
