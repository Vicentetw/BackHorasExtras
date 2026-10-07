// Licencias largas (LICENCIAS_LARGAS.md): letras A, D y E.
//   A. La lista de Licencias muestra una licencia en TODOS los años que toca,
//      no solo en el de inicio y el de fin.
//   D. El resumen de Presentismo separa los dias "Excusado" por motivo.
//   E. Avisos: licencia larga por vencer, y vencida sin volver a fichar.
//
// Fecha de referencia de los avisos: 2098-06-15 (fuera de cualquier dato real).
// Licencias de los empleados, todas "Licencia gremial (test)" salvo VACACIONES:
//   POR_VENCER   2097-01-01 .. 2098-06-25   termina en 10 dias          -> por_vencer
//   VENCIDA      2097-01-01 .. 2098-06-10   no volvio a fichar           -> vencida (5 dias)
//   VOLVIO       2097-01-01 .. 2098-06-10   ficho el 2098-06-12          -> nada
//   REELECTO     2097-01-01 .. 2098-06-10   + otra desde el 2098-06-11   -> nada
//   VACACIONES   2098-06-01 .. 2098-06-14   (14 dias: no es larga)       -> nada
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999943/999944), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999943;
const OTRA = 999944;
const UID = 'test-licencias-largas';
const UID_OTRA = 'test-licencias-largas-otra';
const FECHA = '2098-06-15';
const LEGAJOS = { POR_VENCER: 901201, VENCIDA: 901202, VOLVIO: 901203, REELECTO: 901204, VACACIONES: 901205 };
const userIdDe = (legajo) => 8890000 + (legajo % 10000);

let headers;
let headersOtra;
let gremial;
let vacaciones;
const interno = {};

async function cleanup() {
  await db.query('DELETE ee FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE e.tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM event_types WHERE tenant_id = ?', [TENANT]);
  for (const t of ['Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [TENANT]);
  }
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [TENANT, OTRA]);
}

const licencia = (legajo, eventTypeId, desde, hasta) => db.query(
  'INSERT INTO employee_events (employee_id, event_type_id, fecha_desde, fecha_hasta, dias) VALUES (?, ?, ?, ?, 1)',
  [interno[legajo], eventTypeId, desde, hasta]);

before(async () => {
  for (const [id, code] of [[TENANT, 'tenant-licencias-largas-test'], [OTRA, 'tenant-licencias-largas-otra-test']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  const permisos = ['attendance:read', 'leaves:read', 'schedules:update'];
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: TENANT, permissions: permisos });
  headersOtra = await getTestAuthHeaders(UID_OTRA, { isSuperadmin: false, tenantId: OTRA, permissions: permisos });
  await cleanup();

  const [g] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'GREMIAL_TEST', 'Licencia gremial (test)', 1)`, [TENANT]);
  gremial = g.insertId;
  const [v] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'VAC_TEST', 'Vacaciones (test)', 1)`, [TENANT]);
  vacaciones = v.insertId;

  for (const legajo of Object.values(LEGAJOS)) {
    const [emp] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)`,
      [legajo, `Licencia ${legajo}`, TENANT]);
    interno[legajo] = emp.insertId;
    const userId = userIdDe(legajo);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, TENANT, String(legajo), `Licencia ${legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [userId, TENANT, emp.insertId]);
  }
  await licencia(LEGAJOS.POR_VENCER, gremial, '2097-01-01', '2098-06-25');
  await licencia(LEGAJOS.VENCIDA, gremial, '2097-01-01', '2098-06-10');
  await licencia(LEGAJOS.VOLVIO, gremial, '2097-01-01', '2098-06-10');
  await licencia(LEGAJOS.REELECTO, gremial, '2097-01-01', '2098-06-10');
  await licencia(LEGAJOS.REELECTO, gremial, '2098-06-11', '2100-06-10');
  await licencia(LEGAJOS.VACACIONES, vacaciones, '2098-06-01', '2098-06-14');
  const volvio = userIdDe(LEGAJOS.VOLVIO);
  await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)',
    [volvio, TENANT, '2098-06-12 07:00:00', volvio, TENANT, '2098-06-12 14:00:00']);
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await deleteTestUser(UID_OTRA);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT, OTRA]);
  await closeDb();
});

const vencimientos = async (qs, h = headers) => {
  const res = await fetch(`${BASE_URL}/api/employee-events/vencimientos?fecha=${FECHA}&${qs}`, { headers: h });
  return { status: res.status, body: await res.json() };
};

// ---------------------------------------------------------------- A
test('A. la lista de Licencias muestra la licencia en los años del medio', async () => {
  const legajosDe = async (year) => {
    const res = await fetch(`${BASE_URL}/api/employee-events?year=${year}`, { headers });
    assert.equal(res.status, 200);
    return (await res.json()).events.map((e) => e.legajo);
  };
  // La del reelecto va de 2098-06-11 a 2100-06-10: 2099 es un año del medio.
  assert.deepEqual(await legajosDe(2099), [LEGAJOS.REELECTO], 'antes no aparecia: ni empieza ni termina en 2099');
  assert.equal((await legajosDe(2097)).length, 4, 'las cuatro gremiales empiezan en 2097');
  assert.equal((await legajosDe(2101)).length, 0);
  const mal = await fetch(`${BASE_URL}/api/employee-events?year=2099;DROP`, { headers });
  assert.equal(mal.status, 400);
});

// ---------------------------------------------------------------- E
test('E. por vencer y vencida sin volver; no avisa si volvio, si fue reelecto ni si es corta', async () => {
  const { status, body } = await vencimientos('largaDesde=60&porVencerDias=30');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.filas.map((f) => [Number(f.employeeId), f.estado, f.dias, f.motivo]), [
    [LEGAJOS.VENCIDA, 'vencida', 5, 'Licencia gremial (test)'],
    [LEGAJOS.POR_VENCER, 'por_vencer', 10, 'Licencia gremial (test)'],
  ]);
});

test('E. los umbrales mandan: anticipacion corta, solo vencidas, o apagado', async () => {
  assert.deepEqual((await vencimientos('largaDesde=60&porVencerDias=5')).body.filas.map((f) => f.estado), ['vencida'],
    'vence en 10 dias: con 5 de anticipacion todavia no avisa');
  assert.deepEqual((await vencimientos('largaDesde=60&porVencerDias=')).body.filas.map((f) => f.estado), ['vencida']);
  assert.deepEqual((await vencimientos('largaDesde=&porVencerDias=30')).body.filas, []);
  assert.equal((await vencimientos('largaDesde=0&porVencerDias=30')).status, 400);
  // Con "larga desde 10 dias", las vacaciones de 14 tambien cuentan: vencieron
  // ayer y no volvio a fichar.
  const conCortas = (await vencimientos('largaDesde=10&porVencerDias=30')).body.filas;
  assert.ok(conCortas.some((f) => Number(f.employeeId) === LEGAJOS.VACACIONES && f.estado === 'vencida' && f.dias === 1));
});

test('E. otra empresa no ve nada', async () => {
  const { status, body } = await vencimientos('largaDesde=1&porVencerDias=365', headersOtra);
  assert.equal(status, 200);
  assert.deepEqual(body.filas, []);
});

test('E. configuracion: defaults, y una pantalla vieja que no manda las claves nuevas no las apaga', async () => {
  const leer = async () => (await fetch(`${BASE_URL}/config/avisos-asistencia`, { headers })).json();
  const def = await leer();
  assert.equal(def.licenciaLargaDesde, 60);
  assert.equal(def.licenciaPorVencerDias, 30);
  const post = (body) => fetch(`${BASE_URL}/config/avisos-asistencia`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post({ licenciaLargaDesde: 90, licenciaPorVencerDias: '' })).status, 200);
  // La pantalla de antes manda solo las 4 claves viejas.
  assert.equal((await post({ faltasSeguidas: 3, faltasSinAvisoPeriodo: null, justificadasPeriodo: null, cupoPorAgotarsePct: 80 })).status, 200);
  const despues = await leer();
  assert.equal(despues.faltasSeguidas, 3);
  assert.equal(despues.licenciaLargaDesde, 90, 'no la mando: se conserva');
  assert.equal(despues.licenciaPorVencerDias, null, 'se habia apagado a proposito: sigue apagada');
});

// ---------------------------------------------------------------- D
test('D. el resumen separa los dias excusados por motivo y suma igual que "Excusado"', async () => {
  // Presentismo no calcula dias futuros (corta el rango en hoy), asi que D usa
  // una semana pasada: lunes 2026-05-04 a viernes 2026-05-08, la misma del
  // test de avisos. El VACACIONES esta de vacaciones y el POR_VENCER de
  // licencia gremial; ninguno ficha.
  await licencia(LEGAJOS.VACACIONES, vacaciones, '2026-05-04', '2026-05-08');
  await licencia(LEGAJOS.POR_VENCER, gremial, '2026-05-04', '2026-05-08');
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-05-04&to=2026-05-08&tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  const filas = (await res.json()).data;
  for (const [legajo, motivo] of [[LEGAJOS.VACACIONES, 'Vacaciones (test)'], [LEGAJOS.POR_VENCER, 'Licencia gremial (test)']]) {
    const r = filas.find((f) => String(f.employeeId) === String(legajo));
    assert.equal(r.excused, 5, `${legajo}: los 5 dias habiles excusados`);
    assert.deepEqual(r.excusedPorMotivo, [{ motivo, dias: r.excused }]);
  }
});
