// "Fichó teniendo una licencia cargada" -- aviso para corregir.
//
// Pedido real (2026-09-28): si alguien esta de vacaciones, enfermo, de
// comision o lo que sea, y aun asi ficha, Presentismo tiene que mostrar el
// fichaje (estuvo) y ademas una marca de que tiene una licencia cargada, para
// que alguien corrija lo que este mal: la licencia o el fichaje.
//
// Lo que se prueba, en la vista diaria y en la mensual:
//   - el dia con fichaje se evalua como siempre (presente/tarde), NO "Excusado";
//   - lleva leaveConflict con el motivo de la licencia;
//   - un dia de licencia SIN fichaje sigue "Excusado", sin aviso;
//   - alguien sin licencia que ficha no lleva aviso (nada cambia);
//   - una EXCEPCION de dia completo (userexclusions, no una licencia):
//     sin fichaje cuenta como Excusado; con fichaje manda el fichaje, y no
//     hay aviso (una excepcion con fichaje es normal: justifica una
//     tardanza). Antes esto solo lo cubria un test de caracterizacion
//     sobre datos reales (attendance-daily, 29/06 de Perrotta), que dejo de
//     probarlo cuando esos datos cambiaron.
//
// Requiere el backend local corriendo contra la misma base.
// Tenant descartable propio (999936), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const db = require('../db');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-leave-conflict';
const TENANT = 999936;
const DE_VACACIONES = 8001;
const SIN_LICENCIA = 8002;
const CON_EXCEPCION = 8003;
const DIA_QUE_FICHO = '2026-05-13'; // miercoles, en medio de sus vacaciones
const DIA_QUE_NO_FICHO = '2026-05-12';

let headers;

async function diario(fecha, legajo) {
  const res = await fetch(`${BASE_URL}/api/labor-engine/attendance/${fecha}?tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  return { fila: json.attendance.find((a) => String(a.employeeId) === String(legajo)), summary: json.summary };
}

async function mensual(legajo) {
  const res = await fetch(`${BASE_URL}/attendance-range?from=2026-05-11&to=2026-05-15&employeeId=${legajo}&tenantId=${TENANT}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((e) => String(e.employeeId) === String(legajo));
  return { row, dia: (fecha) => row.days.find((d) => d.date === fecha) };
}

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Licencia y fichaje (test)', 'tenant-leave-conflict-test') ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT]
  );
  const [et] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'TEST_VAC', 'Vacaciones (test)', 1)`, [TENANT]);

  for (const legajo of [DE_VACACIONES, SIN_LICENCIA, CON_EXCEPCION]) {
    const [emp] = await db.query(
      `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, ?, ?, '2020-01-01', 0)`,
      [legajo, `Empleado ${legajo}`, TENANT]
    );
    const userId = TENANT * 1000 + (legajo % 1000);
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`, [userId, TENANT, String(legajo), `Empleado ${legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [userId, TENANT, emp.insertId]);
    await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`, [
      userId, TENANT, `${DIA_QUE_FICHO} 07:00:00`,
      userId, TENANT, `${DIA_QUE_FICHO} 14:00:00`,
    ]);
    if (legajo === DE_VACACIONES) {
      await db.query(
        `INSERT INTO employee_events (employee_id, fecha_desde, fecha_hasta, dias, observaciones, event_type_id) VALUES (?, '2026-05-11', '2026-05-15', 5, 'vacaciones (test)', ?)`,
        [emp.insertId, et.insertId]
      );
    }
    if (legajo === CON_EXCEPCION) {
      for (const dia of [DIA_QUE_NO_FICHO, DIA_QUE_FICHO]) {
        await db.query(
          `INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, 'articulo 55 (test)', 'FULL_DAY')`,
          [userId, TENANT, dia]
        );
      }
    }
  }
});

after(async () => {
  await db.query('DELETE ee FROM employee_events ee JOIN employees e ON e.id = ee.employee_id WHERE e.tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM event_types WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT]);
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('vista diaria: de vacaciones pero fichó -> se ve el fichaje (presente) con el aviso del motivo', async () => {
  const { fila, summary } = await diario(DIA_QUE_FICHO, DE_VACACIONES);
  assert.notEqual(fila.status, 'Excused', 'el fichaje manda: estuvo');
  assert.ok(['OnTime', 'Late'].includes(fila.status), fila.status);
  assert.equal(fila.firstCheckin.slice(11, 16), '07:00');
  assert.deepEqual(fila.leaveConflict, { descripcion: 'Vacaciones (test)' });
  assert.equal(summary.leaveConflicts, 1);
});

test('vista diaria: de vacaciones y sin fichar -> Excusado, sin aviso (como siempre)', async () => {
  const { fila } = await diario(DIA_QUE_NO_FICHO, DE_VACACIONES);
  assert.equal(fila.status, 'Excused');
  assert.equal(fila.leaveConflict, null);
});

test('vista diaria: sin licencia y fichó -> sin aviso (nada cambia)', async () => {
  const { fila } = await diario(DIA_QUE_FICHO, SIN_LICENCIA);
  assert.equal(fila.leaveConflict, null);
});

test('vista mensual: el dia que fichó lleva el aviso y el empleado cuenta 1 dia a revisar', async () => {
  const { row, dia } = await mensual(DE_VACACIONES);
  assert.deepEqual(dia(DIA_QUE_FICHO).leaveConflict, { descripcion: 'Vacaciones (test)' });
  assert.notEqual(dia(DIA_QUE_FICHO).status, 'Excused');
  assert.equal(dia(DIA_QUE_NO_FICHO).status, 'Excused');
  assert.equal(row.leaveConflictDays, 1);
});

test('vista mensual: sin licencia -> 0 dias a revisar', async () => {
  const { row, dia } = await mensual(SIN_LICENCIA);
  assert.equal(row.leaveConflictDays, 0);
  assert.equal(dia(DIA_QUE_FICHO).leaveConflict, null);
});

test('vista diaria: excepcion de dia completo y sin fichar -> Excusado', async () => {
  const { fila } = await diario(DIA_QUE_NO_FICHO, CON_EXCEPCION);
  assert.equal(fila.status, 'Excused');
  assert.equal(fila.exclusion.type, 'FULL_DAY');
});

test('vista diaria: excepcion de dia completo pero fichó -> manda el fichaje, sin aviso', async () => {
  const { fila } = await diario(DIA_QUE_FICHO, CON_EXCEPCION);
  assert.ok(['OnTime', 'Late'].includes(fila.status), fila.status);
  assert.equal(fila.leaveConflict, null, 'una excepcion con fichaje es normal: no se avisa');
});
