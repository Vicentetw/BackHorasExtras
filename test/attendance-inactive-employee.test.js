// Bug real reportado: un empleado marcado como INACTIVO (baja no cargada
// formalmente) aparecía como "Ausente" en Presentismo solo por no fichar --
// eso no es una ausencia real, es esperable (ya no trabaja acá). Al mismo
// tiempo, si un empleado inactivo SI ficha, eso es una señal real a revisar
// (¿se reactivó sin avisar? ¿ficharon con su credencial por error?) -- pidió
// explícitamente un aviso para ese caso, no que se pierda la información.
//
// Cubre los 2 endpoints que alimentan /presentismo: el motor diario
// (calculateDailyAttendance) y /attendance-range (horasdedica2.js).
//
// Tenant descartable propio (999985), NUNCA AVP (id 4). USERIDs de reloj
// descartables propios (8890010+), fuera de cualquier rango real.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999985;
const UID = 'test-attendance-inactive-employee';
const USERID_ACTIVE = 8890010;
const USERID_INACTIVE = 8890011;
// Lunes fijo, sin feriados/plantillas custom para este tenant descartable --
// cae en el horario legacy por defecto (07:00-13:40, L-V laborable).
const TEST_DATE = '2026-01-05';

let headers;
let empActiveId, empInactiveId;

async function cleanup() {
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [USERID_ACTIVE, USERID_INACTIVE]);
  await db.query('DELETE FROM Checkins WHERE USERID IN (?, ?)', [USERID_ACTIVE, USERID_INACTIVE]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [USERID_ACTIVE, USERID_INACTIVE]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT]);
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Inactive Employee (test)', 'tenant-inactive-employee-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT]
  );
  headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: TENANT, permissions: ['attendance:read'] });

  await cleanup();

  const [empActiveRes] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`,
    [900500, 'Empleado Activo Test', TENANT]
  );
  empActiveId = empActiveRes.insertId;
  const [empInactiveRes] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 0)`,
    [900501, 'Empleado Inactivo Test', TENANT]
  );
  empInactiveId = empInactiveRes.insertId;

  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_ACTIVE, TENANT, String(USERID_ACTIVE), 'Empleado Activo Test']);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_INACTIVE, TENANT, String(USERID_INACTIVE), 'Empleado Inactivo Test']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_ACTIVE, TENANT, empActiveId, 'manual']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_INACTIVE, TENANT, empInactiveId, 'manual']);

  // El inactivo SI fichó ese día -- el caso que debe disparar el aviso.
  await db.query(
    'INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES (?, ?, ?, NULL, NULL)',
    [USERID_INACTIVE, TENANT, `${TEST_DATE} 07:05:00`]
  );
  // El activo NO fichó ese día -- debe seguir contando como ausente de verdad.
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]);
  await closeDb();
});

test('motor diario: activo sin fichaje sigue siendo Absent', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${TEST_DATE}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.attendance.find((a) => String(a.employeeId) === '900500');
  assert.ok(row, 'el empleado activo debe aparecer en el listado');
  assert.equal(row.status, 'Absent');
  assert.equal(row.inactiveWarning, false);
});

test('motor diario: inactivo sin fichaje NO es Absent (status Inactive, sin aviso)', async () => {
  // Vacía el checkin del inactivo para este sub-caso puntual, se reinserta despues.
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [USERID_INACTIVE]);
  try {
    const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${TEST_DATE}`, { headers });
    const json = await res.json();
    const row = json.attendance.find((a) => String(a.employeeId) === '900501');
    assert.ok(row);
    assert.notEqual(row.status, 'Absent', 'un inactivo sin fichar no debe contar como ausente');
    assert.equal(row.status, 'Inactive');
    assert.equal(row.inactiveWarning, false);
    // El empleado ACTIVO tambien esta en este tenant y no fichó ese día --
    // debe seguir contando (1). Si el inactivo tambien contara, séria 2.
    assert.equal(json.summary.absent, 1, 'el inactivo sin fichar no debe sumarse al resumen de ausentes (solo el activo debe contar)');
  } finally {
    await db.query(
      'INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES (?, ?, ?, NULL, NULL)',
      [USERID_INACTIVE, TENANT, `${TEST_DATE} 07:05:00`]
    );
  }
});

test('motor diario: inactivo QUE FICHÓ mantiene su status real + aviso', async () => {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${TEST_DATE}`, { headers });
  const json = await res.json();
  const row = json.attendance.find((a) => String(a.employeeId) === '900501');
  assert.ok(row);
  assert.equal(row.status, 'OnTime', 'fichó a horario -- el status real no debe ocultarse, solo agregarse el aviso');
  assert.equal(row.inactiveWarning, true);
});

test('/attendance-range: activo sin fichaje cuenta como absent, inactivo sin fichaje no', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${TEST_DATE}&to=${TEST_DATE}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const rowActive = json.data.find((r) => String(r.employeeId) === '900500');
  const rowInactive = json.data.find((r) => String(r.employeeId) === '900501');
  assert.ok(rowActive);
  assert.ok(rowInactive);
  assert.equal(rowActive.absent, 1);
  assert.equal(rowInactive.absent, 0, 'el inactivo fichó ese día -- no aplica "sin fichaje" en este caso, pero tampoco debe contar como ausente');
  assert.equal(rowInactive.inactiveWarningDays, 1, 'el día que fichó estando inactivo debe contarse como aviso');
});

test('/attendance-range?employeeId=X expone inactiveWarning en el detalle día por día', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${TEST_DATE}&to=${TEST_DATE}&employeeId=900501`, { headers });
  const json = await res.json();
  const row = json.data.find((r) => String(r.employeeId) === '900501');
  assert.ok(row);
  const day = row.days.find((d) => d.date === TEST_DATE);
  assert.ok(day);
  assert.notEqual(day.status, 'Absent');
  assert.equal(day.inactiveWarning, true);
});
