// Presentismo y Campaña: los dias que una persona pasa en el campo.
//
// Caso real que lo origino: OLGUIN (AVP, legajo 2555), agosto 2026. Se fue al
// campo el 03/08 (ficha, aprieta el marcador 8, vuelve a fichar) y volvio el
// 15/08 (marcador 7). Presentismo lo mostraba "Ausente" los 9 dias habiles del
// medio, porque nunca miraba las campañas -- y ademas la campaña ni siquiera
// se detectaba, por la regla de rebote (ver movementsCalculations.js).
//
// Lo que se prueba aca, contra el servidor real:
//   1. Con el modo por defecto ('ignorar') todo sigue EXACTAMENTE como antes.
//   2. Con 'trabajado' / 'excusado', los dias habiles del medio cuentan asi.
//   3. Una licencia cargada a mano gana sobre la campaña detectada.
//   4. Sabado y domingo siguen siendo no laborables (lo decide la plantilla),
//      solo se marcan como "en campaña".
//   5. El reporte de Campaña detecta la salida con el patron de OLGUIN.
//   6. Una licencia de OTRA empresa con el mismo legajo no se cuela.
//
// Requiere el backend local corriendo (puerto 3000) contra la misma base.
// Tenants descartables propios (999937/999938), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const db = require('../db');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-campana';
const TENANT_A = 999937; // usa campañas
const TENANT_B = 999938; // mismo legajo, con una licencia propia
const LEGAJO = 7001;
const USERID = 999937001;
const MARCADOR_SALIDA = 999937008;
const MARCADOR_REGRESO = 999937007;
const DESDE = '2026-05-04'; // lunes: sale al campo
const HASTA = '2026-05-11'; // lunes siguiente: vuelve

let headers;

async function detalle() {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${DESDE}&to=${HASTA}&employeeId=${LEGAJO}&tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((e) => String(e.employeeId) === String(LEGAJO));
  assert.ok(row, 'el empleado debe aparecer en el reporte');
  const dia = (fecha) => row.days.find((d) => d.date === fecha);
  return { row, dia };
}

// Vista DIARIA de Presentismo (motor diario). Bug real: OLGUIN el 23/09/2026
// salia "Ausente" aca aunque /attendance-range ya lo resolvia.
async function diario(fecha) {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${fecha}?tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const fila = json.attendance.find((a) => String(a.employeeId) === String(LEGAJO));
  assert.ok(fila, 'el empleado debe aparecer en el motor diario');
  return { fila, summary: json.summary };
}

async function ponerModo(modo) {
  const res = await fetch(`${BASE_URL}/config/campana-presentismo-modo?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campanaPresentismoModo: modo }),
  });
  assert.equal(res.status, 200);
}

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);

  for (const [id, code] of [[TENANT_A, 'tenant-campana-test-a'], [TENANT_B, 'tenant-campana-test-b']]) {
    await db.query(
      `INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [id, `Tenant Campaña (test) ${id}`, code]
    );
  }

  // Empresa A: el empleado, sus dos marcadores de campaña y sus fichajes.
  const [empA] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Campaña Test', ?, '2020-01-01', 0)`,
    [LEGAJO, TENANT_A]
  );
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Campaña Test')`, [USERID, TENANT_A, String(LEGAJO)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [USERID, TENANT_A, empA.insertId]);
  for (const [userId, badge, direction] of [[MARCADOR_SALIDA, '8', 'SALIDA'], [MARCADOR_REGRESO, '7', 'REGRESO']]) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`, [userId, TENANT_A, badge, `Marcador ${badge}`]);
    await db.query(
      `INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, ?, 'CAMPANA', ?, 1)`,
      [userId, TENANT_A, badge, `Marcador ${badge}`, direction]
    );
  }
  // El patron de OLGUIN: ficha, aprieta el 8 y vuelve a fichar 3 s despues.
  await db.query(
    `INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    [
      USERID, TENANT_A, `${DESDE} 07:00:00`,
      MARCADOR_SALIDA, TENANT_A, `${DESDE} 07:00:06`,
      USERID, TENANT_A, `${DESDE} 07:00:09`,
      MARCADOR_REGRESO, TENANT_A, `${HASTA} 07:00:00`,
      USERID, TENANT_A, `${HASTA} 07:00:03`,
    ]
  );

  // Licencia de la empresa A el jueves: tiene que ganarle a la campaña.
  const [etA] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'TEST_CAMP_A', 'Licencia medica (test)', 1)`, [TENANT_A]);
  await db.query(
    `INSERT INTO employee_events (employee_id, fecha_desde, fecha_hasta, dias, observaciones, event_type_id) VALUES (?, '2026-05-07', '2026-05-07', 1, 'licencia en campaña (test)', ?)`,
    [empA.insertId, etA.insertId]
  );

  // Empresa B: OTRA persona con el MISMO legajo y una licencia el miercoles.
  const [empB] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Otra Empresa Mismo Legajo', ?, '2020-01-01', 0)`,
    [LEGAJO, TENANT_B]
  );
  const [etB] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'TEST_CAMP_B', 'Vacaciones (test)', 1)`, [TENANT_B]);
  await db.query(
    `INSERT INTO employee_events (employee_id, fecha_desde, fecha_hasta, dias, observaciones, event_type_id) VALUES (?, '2026-05-06', '2026-05-06', 1, 'licencia de otra empresa (test)', ?)`,
    [empB.insertId, etB.insertId]
  );
});

after(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    await db.query('DELETE ee FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE e.tenant_id = ?', [t]);
    await db.query('DELETE FROM event_types WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM app_settings WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM tenants WHERE id = ?', [t]);
  }
  await deleteTestUser(TEST_UID);
  await closeDb();
});

// Los tests corren en orden: primero el modo por defecto, despues los otros.

test('modo por defecto (ignorar): los dias en el campo siguen "Ausente", igual que siempre', async () => {
  const { row, dia } = await detalle();
  assert.equal(dia('2026-05-05').status, 'Absent');
  assert.equal(dia('2026-05-08').status, 'Absent');
  assert.equal(row.campaignDays, 0);
  assert.equal(dia('2026-05-09').inCampaign, undefined, 'con ignorar no se agrega ninguna marca');
});

test('motor diario, modo por defecto: un dia en el campo sigue "Ausente", igual que siempre', async () => {
  const { fila, summary } = await diario('2026-05-05');
  assert.equal(fila.status, 'Absent');
  assert.equal(fila.campaignCountsAs, undefined);
  assert.equal(summary.campaign, 0);
});

test('una licencia de OTRA empresa con el mismo legajo no se cuela', async () => {
  // La empresa B cargo una licencia el miercoles para SU legajo 7001. Antes
  // del arreglo, este miercoles salia "Excused" en la empresa A.
  const { dia } = await detalle();
  assert.equal(dia('2026-05-06').status, 'Absent');
});

test('config: rechaza un modo que no existe y guarda uno valido', async () => {
  const mal = await fetch(`${BASE_URL}/config/campana-presentismo-modo?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campanaPresentismoModo: 'siempre' }),
  });
  assert.equal(mal.status, 400);

  await ponerModo('trabajado');
  const res = await fetch(`${BASE_URL}/config/campana-presentismo-modo?tenantId=${TENANT_A}`, { headers });
  assert.deepEqual(await res.json(), { campanaPresentismoModo: 'trabajado' });
});

test('modo trabajado: los dias habiles del medio cuentan como trabajados y se muestran "En campaña"', async () => {
  await ponerModo('trabajado');
  const { row, dia } = await detalle();

  for (const fecha of ['2026-05-05', '2026-05-06', '2026-05-08']) {
    assert.equal(dia(fecha).status, 'Campaign', fecha);
    assert.equal(dia(fecha).campaignCountsAs, 'trabajado', fecha);
  }
  // El dia de salida y el de regreso cuentan por sus fichajes, no dos veces.
  assert.notEqual(dia(DESDE).status, 'Campaign');
  assert.notEqual(dia(HASTA).status, 'Campaign');
  assert.equal(row.campaignDays, 3);
  assert.equal(row.daysWorked, 5, '2 dias fichados + 3 en campaña');
  assert.equal(row.absent, 0);
});

test('la licencia cargada a mano gana sobre la campaña detectada', async () => {
  await ponerModo('trabajado');
  const { dia } = await detalle();
  assert.equal(dia('2026-05-07').status, 'Excused');
});

test('sabado y domingo en campaña siguen siendo no laborables, marcados "en campaña"', async () => {
  await ponerModo('trabajado');
  const { dia } = await detalle();
  for (const fecha of ['2026-05-09', '2026-05-10']) {
    assert.equal(dia(fecha).status, 'NonWorkDay', fecha);
    assert.equal(dia(fecha).inCampaign, true, fecha);
  }
});

test('motor diario, modo trabajado: el dia en el campo es "Campaign", igual que en la vista mensual', async () => {
  await ponerModo('trabajado');
  const { fila, summary } = await diario('2026-05-05');
  assert.equal(fila.status, 'Campaign');
  assert.equal(fila.campaignCountsAs, 'trabajado');
  assert.equal(summary.campaign, 1);
  assert.equal(summary.absent, 0);
});

test('motor diario: el dia de salida cuenta por su fichaje y la licencia gana sobre la campaña', async () => {
  await ponerModo('trabajado');
  assert.notEqual((await diario(DESDE)).fila.status, 'Campaign');
  assert.equal((await diario('2026-05-07')).fila.status, 'Excused');
});

test('motor diario, modo excusado: suma a excusados', async () => {
  await ponerModo('excusado');
  const { fila, summary } = await diario('2026-05-06');
  assert.equal(fila.status, 'Campaign');
  assert.equal(fila.campaignCountsAs, 'excusado');
  assert.equal(summary.excused, 1);
});

test('modo excusado: los dias del medio suman a Excusado, no a trabajados', async () => {
  await ponerModo('excusado');
  const { row, dia } = await detalle();
  assert.equal(dia('2026-05-05').status, 'Campaign');
  assert.equal(dia('2026-05-05').campaignCountsAs, 'excusado');
  assert.equal(row.daysWorked, 2);
  assert.equal(row.excused, 4, '3 en campaña + 1 licencia');
  assert.equal(row.absent, 0);
});

test('/campana-range detecta la salida con el patron de OLGUIN (ficha, marcador, ficha)', async () => {
  const res = await fetch(`${BASE_URL}/campana-range?from=${DESDE}&to=${HASTA}&tenantId=${TENANT_A}`, { headers });
  assert.equal(res.status, 200);
  const { rows } = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasReturn, true);
  assert.match(rows[0].timeOut, /^2026-05-04[ T]07:00:09/);
  assert.match(rows[0].timeIn, /^2026-05-11[ T]07:00:03/);
});
