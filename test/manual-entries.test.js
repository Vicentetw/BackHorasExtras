// Fase 6.1: guards nuevos en las rutas de ManualEntries/import/clear que no
// tenian NINGUNA proteccion de permisos, mas la integracion de ManualEntries
// al total de /attendance-range (antes solo se sumaban en GET /data, un
// motor aparte sin horarios/feriados/exclusiones).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const NO_PERMS_UID = 'test-manual-entries-none-ci';
const FULL_PERMS_UID = 'test-manual-entries-full-ci';
const LEGAJO_2525 = '2525';

let userIdFor2525;
const insertedManualIds = [];

before(async () => {
  const [[row]] = await db.query(
    `SELECT u.USERID FROM users u
     JOIN user_employee_map uem ON uem.USERID = u.USERID
     JOIN employees e ON e.id = uem.employee_id
     WHERE e.employee_id = ?`,
    [LEGAJO_2525]
  );
  userIdFor2525 = row ? row.USERID : null;
});

after(async () => {
  if (insertedManualIds.length) {
    await db.query('DELETE FROM ManualEntries WHERE id IN (?)', [insertedManualIds]).catch(() => {});
  }
  await deleteTestUser(NO_PERMS_UID);
  await deleteTestUser(FULL_PERMS_UID);
  await closeDb();
});

test('sin attendance:create: /add/manual, /import/checkins y /import/users responden 403', async () => {
  const headers = await getTestAuthHeaders(NO_PERMS_UID, { isSuperadmin: false, tenantId: 4, permissions: [] });

  const r1 = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 1, startDatetime: '2026-12-15 14:00', endDatetime: '2026-12-15 16:00', durationMinutes: 120, type: 'he' })
  });
  assert.equal(r1.status, 403);

  const r2 = await fetch(`${BASE_URL}/import/checkins`, { method: 'POST', headers });
  assert.equal(r2.status, 403, 'sin permiso, ni siquiera deberia llegar a exigir el archivo');

  const r3 = await fetch(`${BASE_URL}/import/users`, { method: 'POST', headers });
  assert.equal(r3.status, 403);
});

test('sin attendance:delete: /delete/manual/:id responde 403', async () => {
  const headers = await getTestAuthHeaders(NO_PERMS_UID, { isSuperadmin: false, tenantId: 4, permissions: ['attendance:create'] });
  const res = await fetch(`${BASE_URL}/delete/manual/999999`, { method: 'DELETE', headers });
  assert.equal(res.status, 403);
});

test('/clear/checkins exige superadmin -- un usuario normal con todos los permisos igual da 403', async () => {
  const headers = await getTestAuthHeaders(NO_PERMS_UID, {
    isSuperadmin: false,
    tenantId: 4,
    permissions: ['attendance:read', 'attendance:create', 'attendance:update', 'attendance:delete']
  });
  const res = await fetch(`${BASE_URL}/clear/checkins`, { method: 'DELETE', headers });
  assert.equal(res.status, 403, 'borrar TODOS los fichajes no debe alcanzar con un permiso de modulo, solo superadmin');
});

test('ManualEntries: alta, edicion y baja de una HE manual, reflejada en /attendance-range', async () => {
  assert.ok(userIdFor2525, 'legajo 2525 debe tener un USERID de reloj asociado para esta prueba');
  const headers = await getTestAuthHeaders(FULL_PERMS_UID, { isSuperadmin: true });
  // Tiene que ser una fecha PASADA -- /attendance-range recorta el rango a
  // "hoy" (effectiveEndDate), asi que una fecha futura devuelve data:[] vacio.
  // No se asume que el dia este "limpio" (puede haber fichajes/HE real ya
  // computada) -- se compara contra el total ANTES de agregar nada, no
  // contra un valor absoluto.
  const testDate = '2026-08-15';
  const rangeUrl = `${BASE_URL}/attendance-range?from=${testDate}&to=${testDate}&employeeId=${LEGAJO_2525}`;

  const baselineRes = await fetch(rangeUrl, { headers });
  const baselineJson = await baselineRes.json();
  const baselineEmp = baselineJson.data.find((e) => String(e.employeeId) === LEGAJO_2525);
  assert.ok(baselineEmp, 'legajo 2525 debe aparecer en el reporte');
  const baselineHours = Number(baselineEmp.overtimeHours);

  // Alta: 2 horas (120 min)
  const addRes = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: userIdFor2525,
      startDatetime: `${testDate} 14:00`,
      endDatetime: `${testDate} 16:00`,
      durationMinutes: 120,
      type: 'he',
      note: 'test Fase 6.1'
    })
  });
  assert.equal(addRes.status, 200);
  const addJson = await addRes.json();
  assert.ok(addJson.id);
  insertedManualIds.push(addJson.id);

  const r1 = await fetch(rangeUrl, { headers });
  const j1 = await r1.json();
  const emp1 = j1.data.find((e) => String(e.employeeId) === LEGAJO_2525);
  assert.ok(emp1, 'legajo 2525 debe aparecer en el reporte');
  assert.equal(Number(emp1.overtimeHours), baselineHours + 2, 'las 2hs manuales deben sumarse al total ya existente');
  const day1 = emp1.days.find((d) => d.date === testDate);
  assert.equal(day1.overtimeManualMinutes, 120);

  // Edicion: bajar a 60 minutos
  const updRes = await fetch(`${BASE_URL}/update/manual/${addJson.id}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDatetime: `${testDate} 14:00`,
      endDatetime: `${testDate} 15:00`,
      durationMinutes: 60,
      type: 'he'
    })
  });
  assert.equal(updRes.status, 200);

  const r2 = await fetch(rangeUrl, { headers });
  const j2 = await r2.json();
  const emp2 = j2.data.find((e) => String(e.employeeId) === LEGAJO_2525);
  assert.equal(Number(emp2.overtimeHours), baselineHours + 1, 'tras editar a 60 min, el total debe reflejar +1hs sobre el base');

  // Baja
  const delRes = await fetch(`${BASE_URL}/delete/manual/${addJson.id}`, { method: 'DELETE', headers });
  assert.equal(delRes.status, 200);
  insertedManualIds.pop();

  const r3 = await fetch(rangeUrl, { headers });
  const j3 = await r3.json();
  const emp3 = j3.data.find((e) => String(e.employeeId) === LEGAJO_2525);
  assert.equal(Number(emp3.overtimeHours), baselineHours, 'tras borrar la entrada manual, el total vuelve al valor base');
});
