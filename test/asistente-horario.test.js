// Asistente para crear horarios (2026-10-09). Primero las reglas puras
// (motor-laboral/services/asistenteHorario.js), después el endpoint
// POST /api/labor-engine/admin/templates/asistente, y por último que lo que
// crea se calcule bien en Presentismo (el cortado de 2 fichadas NO puede dar
// "ausente parcial").
//
// Requiere el backend local corriendo (puerto 3000). Tenants descartables
// propios (999919/999920), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const a = require('../motor-laboral/services/asistenteHorario');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999919;
const B = 999920;
const PERMISOS = ['schedules:read', 'schedules:create', 'schedules:update', 'attendance:read', 'employees:read'];
let hA; let hB;

// ---------- Reglas puras ----------
test('tramos: horas válidas, en orden, sin pisarse, solo el último cruza la medianoche', () => {
  assert.deepEqual(a.validarTramos([{ inicio: '07:00', fin: '14:00' }], 'x'), [{ inicio: '07:00', fin: '14:00' }]);
  assert.equal(a.validarTramos([{ inicio: '23:00', fin: '07:00' }], 'x').length, 1, 'noche');
  const err = (t) => assert.throws(() => a.validarTramos(t, 'El lunes'), a.ErrorAsistente);
  err([]);
  err([{ inicio: '7:00', fin: '14:00' }]);
  err([{ inicio: '07:00', fin: '07:00' }]);
  err([{ inicio: '08:00', fin: '12:00' }, { inicio: '11:00', fin: '20:00' }]); // se pisan
  err([{ inicio: '20:00', fin: '02:00' }, { inicio: '03:00', fin: '06:00' }]); // cruza y no es el último
  err([{ inicio: '01:00', fin: '23:00' }]); // 22 horas
  assert.throws(() => a.validarTramos([{ inicio: '08:00', fin: '12:00' }, { inicio: '11:00', fin: '20:00' }], 'El lunes'), /empieza antes de que termine/);
});

test('semana: días únicos y bloques; cortado sin fichar al mediodía = una jornada + pausa', () => {
  assert.throws(() => a.validarSemana([]), /al menos un día/);
  assert.throws(() => a.validarSemana([{ dia: 1, tramos: [{ inicio: '07:00', fin: '14:00' }] }, { dia: 1, tramos: [{ inicio: '07:00', fin: '14:00' }] }]), /repetido/);
  const [d4] = a.validarSemana([{ dia: 1, tramos: [{ inicio: '08:00', fin: '12:00' }, { inicio: '16:00', fin: '20:00' }] }]);
  assert.deepEqual(a.bloquesDelDia(d4).map((b) => [b.block_name, b.start_time, b.end_time, b.block_type]),
    [['Mañana', '08:00', '12:00', 'WORK'], ['Tarde', '16:00', '20:00', 'WORK']]);
  const [d2] = a.validarSemana([{ dia: 1, descanso_sin_fichar: true, tramos: [{ inicio: '08:00', fin: '12:00' }, { inicio: '16:00', fin: '20:00' }] }]);
  assert.deepEqual(a.bloquesDelDia(d2).map((b) => [b.block_name, b.start_time, b.end_time, b.block_type]),
    [['Jornada', '08:00', '20:00', 'WORK'], ['Pausa', '12:00', '16:00', 'BREAK']]);
  const [noche] = a.validarSemana([{ dia: 5, tramos: [{ inicio: '22:00', fin: '06:00' }] }]);
  assert.equal(a.bloquesDelDia(noche)[0].crosses_midnight, 1);
});

test('rotativo: ciclo de 2 a 60 días, con trabajo, y turnos que existen', () => {
  const t = [{ clave: 'm', nombre: 'Mañana', tramos: [{ inicio: '07:00', fin: '15:00' }] }];
  const r = a.validarRotativo({ turnos: t, ciclo: ['m', 'm', null] });
  assert.deepEqual(r.dias, ['m', 'm', null]);
  assert.throws(() => a.validarRotativo({ turnos: t, ciclo: ['m'] }), /entre 2 y 60/);
  assert.throws(() => a.validarRotativo({ turnos: t, ciclo: [null, null] }), /al menos un día de trabajo/);
  assert.throws(() => a.validarRotativo({ turnos: t, ciclo: ['m', 'x'] }), /no existe/);
  assert.throws(() => a.validarRotativo({ turnos: [...t, { clave: 'z', nombre: 'mañana', tramos: [{ inicio: '08:00', fin: '16:00' }] }], ciclo: ['m', 'z'] }), /dos turnos/);
});

// ---------- Endpoint ----------
async function limpiar() {
  for (const t of [A, B]) {
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE d FROM template_cycle_days d JOIN work_schedule_templates w ON w.id = d.template_id WHERE w.tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE sb FROM shift_blocks sb JOIN work_schedule_templates w ON w.id = sb.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
    await db.query('DELETE tr FROM shift_definition_tramos tr JOIN shift_definitions s ON s.id = tr.shift_id WHERE s.tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM shift_definitions WHERE tenant_id = ?', [t]).catch(() => {});
  }
}

before(async () => {
  for (const [id, code] of [[A, 'asistente-a'], [B, 'asistente-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await limpiar();
  hA = await getTestAuthHeaders('test-asistente-a', { isSuperadmin: false, tenantId: A, permissions: PERMISOS });
  hB = await getTestAuthHeaders('test-asistente-b', { isSuperadmin: false, tenantId: B, permissions: PERMISOS });
});

after(async () => {
  await limpiar();
  await deleteTestUser('test-asistente-a');
  await deleteTestUser('test-asistente-b');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

const crear = (h, body) => fetch(`${BASE_URL}/api/labor-engine/admin/templates/asistente`, {
  method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const LUN_A_VIE = [1, 2, 3, 4, 5];
const bloques = async (id) => (await db.query('SELECT day_of_week, block_name, TIME_FORMAT(start_time, "%H:%i") s, TIME_FORMAT(end_time, "%H:%i") e, block_type, crosses_midnight FROM shift_blocks WHERE template_id = ? ORDER BY day_of_week, start_time', [id]))[0];
const cantPlantillas = async (t) => (await db.query('SELECT COUNT(*) n FROM work_schedule_templates WHERE tenant_id = ?', [t]))[0][0].n;

test('corrido de lunes a viernes: una plantilla con 5 bloques de trabajo, de esta empresa', async () => {
  const r = await crear(hA, { nombre: 'Administración (test)', semana: LUN_A_VIE.map((dia) => ({ dia, tramos: [{ inicio: '07:00', fin: '14:00' }] })) });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  const [[t]] = await db.query('SELECT tenant_id, type, is_default, active FROM work_schedule_templates WHERE id = ?', [id]);
  assert.deepEqual([t.tenant_id, t.type, t.is_default, t.active], [A, 'FIXED', 0, 1]);
  const b = await bloques(id);
  assert.equal(b.length, 5);
  assert.ok(b.every((x) => x.s === '07:00' && x.e === '14:00' && x.block_type === 'WORK' && x.crosses_midnight === 0));
});

test('nombre repetido -> 409 y no se crea nada; datos inválidos -> 400 con mensaje claro', async () => {
  const antes = await cantPlantillas(A);
  const r = await crear(hA, { nombre: 'Administración (test)', semana: [{ dia: 1, tramos: [{ inicio: '07:00', fin: '14:00' }] }] });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Ya hay un horario/);
  const mal = await crear(hA, { nombre: 'Malo (test)', semana: [{ dia: 1, tramos: [{ inicio: '08:00', fin: '12:00' }, { inicio: '11:00', fin: '20:00' }] }] });
  assert.equal(mal.status, 400);
  assert.match((await mal.json()).error, /lunes/);
  assert.equal((await crear(hA, { nombre: 'Nada (test)' })).status, 400, 'sin semana ni rotativo');
  assert.equal(await cantPlantillas(A), antes, 'no quedó nada a medias');
});

test('cortado: con 4 fichadas son dos bloques; con 2 fichadas, una jornada y la pausa', async () => {
  const cortado = [{ inicio: '08:00', fin: '12:00' }, { inicio: '16:00', fin: '20:00' }];
  const r4 = await crear(hA, { nombre: 'Comercio 4 fichadas (test)', semana: [{ dia: 1, tramos: cortado }] });
  const b4 = await bloques((await r4.json()).id);
  assert.deepEqual(b4.map((x) => [x.s, x.e, x.block_type]), [['08:00', '12:00', 'WORK'], ['16:00', '20:00', 'WORK']]);
  const r2 = await crear(hA, { nombre: 'Comercio 2 fichadas (test)', semana: LUN_A_VIE.map((dia) => ({ dia, tramos: cortado, descanso_sin_fichar: true })) });
  const b2 = await bloques((await r2.json()).id);
  assert.deepEqual(b2.filter((x) => x.day_of_week === 1).map((x) => [x.s, x.e, x.block_type]), [['08:00', '20:00', 'WORK'], ['12:00', '16:00', 'BREAK']]);
});

test('"por defecto": queda una sola por defecto en la empresa', async () => {
  const r = await crear(hA, { nombre: 'Por defecto (test)', por_defecto: true, semana: [{ dia: 1, tramos: [{ inicio: '09:00', fin: '17:00' }] }] });
  const { id } = await r.json();
  const [def] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ? AND is_default = 1', [A]);
  assert.deepEqual(def.map((x) => x.id), [id]);
});

test('rotativo: crea los turnos y el ciclo; reutiliza un turno con el mismo nombre y horario', async () => {
  const body = {
    nombre: 'Sereno 2-2-2 (test)',
    rotativo: {
      turnos: [
        { clave: 'm', nombre: 'Mañana', tramos: [{ inicio: '07:00', fin: '15:00' }] },
        { clave: 't', nombre: 'Tarde', tramos: [{ inicio: '15:00', fin: '23:00' }] },
        { clave: 'n', nombre: 'Noche', tramos: [{ inicio: '23:00', fin: '07:00' }] },
      ],
      ciclo: ['m', 'm', 't', 't', 'n', 'n', null, null, null, null],
    },
  };
  const r = await crear(hA, body);
  if (r.status === 503) { console.log('  (sin la migración 20261015 en la base de tests: se saltea)'); return; }
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.turnosCreados, 3);
  const [[t]] = await db.query('SELECT modo, cycle_length, is_default FROM work_schedule_templates WHERE id = ?', [j.id]);
  assert.deepEqual([t.modo, t.cycle_length, t.is_default], ['ROTATIVO', 10, 0]);
  const [dias] = await db.query(
    'SELECT d.day_number, s.nombre FROM template_cycle_days d LEFT JOIN shift_definitions s ON s.id = d.shift_id WHERE d.template_id = ? ORDER BY d.day_number', [j.id]);
  assert.deepEqual(dias.map((d) => d.nombre), ['Mañana', 'Mañana', 'Tarde', 'Tarde', 'Noche', 'Noche', null, null, null, null]);
  const [[noche]] = await db.query('SELECT tr.cruza_medianoche FROM shift_definition_tramos tr JOIN shift_definitions s ON s.id = tr.shift_id WHERE s.tenant_id = ? AND s.nombre = ?', [A, 'Noche']);
  assert.equal(noche.cruza_medianoche, 1);

  // Otra plantilla con "Mañana" igual: no duplica el turno.
  const r2 = await crear(hA, { nombre: 'Rotativo 2 (test)', rotativo: { turnos: [{ clave: 'x', nombre: 'mañana', tramos: [{ inicio: '07:00', fin: '15:00' }] }], ciclo: ['x', null] } });
  assert.equal((await r2.json()).turnosCreados, 0);
  // "Mañana" con OTRO horario: 409 y no se crea la plantilla.
  const antes = await cantPlantillas(A);
  const r3 = await crear(hA, { nombre: 'Rotativo 3 (test)', rotativo: { turnos: [{ clave: 'x', nombre: 'Mañana', tramos: [{ inicio: '06:00', fin: '14:00' }] }], ciclo: ['x', null] } });
  assert.equal(r3.status, 409);
  assert.match((await r3.json()).error, /otro horario/);
  assert.equal(await cantPlantillas(A), antes);

  // Aislamiento: la empresa B no puede usar un turno de la A.
  const [[manana]] = await db.query('SELECT id FROM shift_definitions WHERE tenant_id = ? AND nombre = ?', [A, 'Mañana']);
  const rb = await crear(hB, { nombre: 'Ajena (test)', rotativo: { turnos: [{ clave: 'x', id: manana.id }], ciclo: ['x', null] } });
  assert.equal(rb.status, 400);
  assert.equal(await cantPlantillas(B), 0);
});

// ---------- De punta a punta: cómo se calcula ----------
async function personaConHorario(templateId, legajo, userId, fichajes) {
  const [e] = await db.query("INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)", [legajo, `Persona ${legajo} (test)`, A]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, A, String(legajo), `Persona ${legajo}`]);
  await db.query("INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')", [userId, A, e.insertId]);
  await db.query("INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)", [e.insertId, A, templateId]);
  for (const f of fichajes) await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, A, f]);
}

test('Presentismo: cortado de 2 fichadas ficha 2 veces = "a tiempo"; el de 4 fichadas con 2 = "ausente parcial"', async () => {
  const LUNES = '2026-08-17';
  const [[t2]] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ? AND name = ?', [A, 'Comercio 2 fichadas (test)']);
  const [[t4]] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ? AND name = ?', [A, 'Comercio 4 fichadas (test)']);
  await personaConHorario(t2.id, 919001, 999919001, [`${LUNES} 07:58:00`, `${LUNES} 20:03:00`]);
  await personaConHorario(t4.id, 919002, 999919002, [`${LUNES} 07:58:00`, `${LUNES} 20:03:00`]);
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${LUNES}?tenantId=${A}`, { headers: hA });
  assert.equal(res.status, 200);
  const filas = (await res.json()).attendance;
  const de = (l) => filas.find((x) => String(x.employeeId) === String(l));
  assert.equal(de(919001).status, 'OnTime', 'cortado sin fichar al mediodía: llegó 07:58 a las 08:00');
  assert.equal(de(919002).status, 'PartialAbsence', 'el de 4 fichadas espera también el mediodía');
});
