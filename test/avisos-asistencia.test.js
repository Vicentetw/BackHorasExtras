// Avisos de Presentismo: faltas seguidas sin aviso, umbrales por empresa y
// estado de cupos de toda la empresa.
//
// MAYO 2026 (lun 04 a mar 12), horario por defecto de lunes a viernes:
//   SIN_JUSTIFICAR: ficha lun 04 y jue 07; falta mar 05, mie 06, vie 08,
//                   lun 11 y mar 12 -> racha mas larga 3 (vie + lun + mar: el
//                   fin de semana NO corta), y sigue abierta al final.
//   CON_JUSTIFICACION: igual, pero el lun 11 tiene un "Articulo 55" de dia
//                   completo -> corta la racha: queda en 2 (mar-mie).
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999971/999972), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999971;
const OTRA = 999972;
const UID = 'test-avisos-asistencia';
const UID_OTRA = 'test-avisos-asistencia-otra';
const SIN_JUSTIFICAR = 900821;
const CON_JUSTIFICACION = 900822;
const userIdDe = (legajo) => 8890000 + (legajo % 1000);

let headers;
let headersOtra;
let art55;

const post = (url, body, h = headers) => fetch(`${BASE_URL}${url}`, {
  method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function cleanup() {
  await db.query('DELETE FROM user_exclusion_log WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM event_type_quotas WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM event_types WHERE tenant_id = ?', [TENANT]);
  for (const t of ['Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [TENANT]);
  }
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [TENANT, OTRA]);
}

before(async () => {
  for (const [id, code] of [[TENANT, 'tenant-avisos-asistencia-test'], [OTRA, 'tenant-avisos-asistencia-otra-test']]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, `${code} (test)`, code]);
  }
  const permisos = ['attendance:read', 'schedules:read', 'schedules:update', 'exclusions:read'];
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: TENANT, permissions: permisos });
  headersOtra = await getTestAuthHeaders(UID_OTRA, { isSuperadmin: false, tenantId: OTRA, permissions: permisos });
  await cleanup();

  const [et] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'ART55_AVISOS', 'Artículo 55 (test)', 1)`, [TENANT]);
  art55 = et.insertId;

  for (const legajo of [SIN_JUSTIFICAR, CON_JUSTIFICACION]) {
    const [emp] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)`,
      [legajo, `Avisos ${legajo}`, TENANT]
    );
    const userId = userIdDe(legajo);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, TENANT, String(legajo), `Avisos ${legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [userId, TENANT, emp.insertId]);
    for (const dia of ['2026-05-04', '2026-05-07']) {
      await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)',
        [userId, TENANT, `${dia} 07:00:00`, userId, TENANT, `${dia} 14:00:00`]);
    }
  }
  for (const dia of ['2026-05-11', '2026-05-13']) {
    await db.query(`INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type, event_type_id) VALUES (?, ?, ?, 'personal', 'FULL_DAY', ?)`,
      [userIdDe(CON_JUSTIFICACION), TENANT, dia, art55]);
  }
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await deleteTestUser(UID_OTRA);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT, OTRA]);
  await closeDb();
});

async function fila(legajo) {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-05-04&to=2026-05-12&tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  return (await res.json()).data.find((e) => String(e.employeeId) === String(legajo));
}

test('faltas seguidas: un fin de semana en el medio no corta la racha', async () => {
  const r = await fila(SIN_JUSTIFICAR);
  assert.equal(r.absent, 5, 'los numeros de siempre no cambian');
  assert.equal(r.faltasSeguidasMax, 3, 'vie 08 + lun 11 + mar 12');
  assert.equal(r.faltasSeguidasAlFinal, 3, 'sigue faltando al ultimo dia');
});

test('un dia justificado corta la racha', async () => {
  const r = await fila(CON_JUSTIFICACION);
  assert.equal(r.absent, 4);
  assert.equal(r.excused, 1);
  assert.equal(r.faltasSeguidasMax, 2, 'mar 05 + mie 06');
  assert.equal(r.faltasSeguidasAlFinal, 1, 'solo el mar 12');
});

test('umbrales: defaults sensatos, validacion y aislamiento por empresa', async () => {
  const def = await (await fetch(`${BASE_URL}/config/avisos-asistencia`, { headers })).json();
  assert.deepEqual(def, { faltasSeguidas: 2, faltasSinAvisoPeriodo: null, justificadasPeriodo: null, cupoPorAgotarsePct: 80, licenciaLargaDesde: 60, licenciaPorVencerDias: 30 });

  assert.equal((await post('/config/avisos-asistencia', { faltasSeguidas: 0 })).status, 400);
  const ok = await post('/config/avisos-asistencia', { faltasSeguidas: 3, faltasSinAvisoPeriodo: 4, justificadasPeriodo: '', cupoPorAgotarsePct: 50 });
  assert.equal(ok.status, 200);
  const guardado = await (await fetch(`${BASE_URL}/config/avisos-asistencia`, { headers })).json();
  // Las claves de licencias no se mandaron: conservan su valor (ver licencias-largas.test.js).
  assert.deepEqual(guardado, { faltasSeguidas: 3, faltasSinAvisoPeriodo: 4, justificadasPeriodo: null, cupoPorAgotarsePct: 50, licenciaLargaDesde: 60, licenciaPorVencerDias: 30 });

  const otra = await (await fetch(`${BASE_URL}/config/avisos-asistencia`, { headers: headersOtra })).json();
  assert.equal(otra.faltasSeguidas, 2, 'la otra empresa sigue con los defaults');
});

test('estado de cupos: agotado, por agotarse segun el porcentaje, y nada para otra empresa', async () => {
  await db.query(`INSERT INTO event_type_quotas (tenant_id, event_type_id, max_dias_anio, vigente_desde) VALUES (?, ?, 2, '2020-01-01')`, [TENANT, art55]);

  const agotado = await (await fetch(`${BASE_URL}/api/event-types/cupos/estado?fecha=2026-06-01`, { headers })).json();
  assert.deepEqual(agotado.filas.map((f) => [f.employeeId, f.usados, f.max, f.estado]), [[String(CON_JUSTIFICACION), 2, 2, 'agotado']]);

  await db.query(`UPDATE event_type_quotas SET max_dias_anio = 3 WHERE tenant_id = ?`, [TENANT]);
  const conPct = await (await fetch(`${BASE_URL}/api/event-types/cupos/estado?fecha=2026-06-01&porcentaje=50`, { headers })).json();
  assert.equal(conPct.filas[0].estado, 'por_agotarse', '2 de 3 es mas del 50%');
  const sinPct = await (await fetch(`${BASE_URL}/api/event-types/cupos/estado?fecha=2026-06-01&porcentaje=`, { headers })).json();
  assert.equal(sinPct.filas.length, 0, 'porcentaje vacio: solo agotado/superado');

  const otra = await (await fetch(`${BASE_URL}/api/event-types/cupos/estado?fecha=2026-06-01`, { headers: headersOtra })).json();
  assert.equal(otra.filas.length, 0);
});
