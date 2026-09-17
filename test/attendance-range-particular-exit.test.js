// Pedido real: "diferenciar bien... salida particular, que estan en
// salidas" -- el calendario de Presentismo (/attendance-range) no
// distinguia nunca un dia con salida particular, esa info solo se veia en
// la pantalla de Salidas (/movements-range). Se agrega hasParticularExit
// por dia, calculado con el mismo motor (detectMovements) que ya usa
// Salidas, acotado a una salida+regreso completos el mismo dia.
//
// Requiere que el backend local este corriendo (node horasdedica2.js,
// puerto 3000) contra la misma base.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const db = require('../db');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-attendance-range-particular-exit';
const TENANT_ID = 999965;
const BADGE = 999965001;
const USERID = 999965001;
const MARKER_SALIDA_USERID = 999965002;
const MARKER_REGRESO_USERID = 999965003;
const DATE_WITH_EXIT = '2026-05-11'; // lunes
const DATE_WITHOUT_EXIT = '2026-05-12'; // martes

let headers;

before(async () => {
  headers = await getTestAuthHeaders(TEST_UID);

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Salida Particular (test)', 'tenant-salida-particular-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report) VALUES (?, 'Salida Particular Test', ?, '2020-01-01', 0)`,
    [BADGE, TENANT_ID]
  );
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Salida Particular Test')`, [USERID, TENANT_ID, String(BADGE)]);
  await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [USERID, TENANT_ID, empResult.insertId]);

  // Badges marcadores (SALIDA/REGRESO de PARTICULAR) -- necesitan su propia
  // fila en `users` (su USERID debe poder aparecer como Checkins.USERID)
  // ademas de la fila en `specialusers` que los declara como marcador.
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '5', 'Marcador Salida')`, [MARKER_SALIDA_USERID, TENANT_ID]);
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '6', 'Marcador Regreso')`, [MARKER_REGRESO_USERID, TENANT_ID]);
  await db.query(
    `INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, '5', 'Marcador Salida', 'PARTICULAR', 'SALIDA', 1)`,
    [MARKER_SALIDA_USERID, TENANT_ID]
  );
  await db.query(
    `INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, '6', 'Marcador Regreso', 'PARTICULAR', 'REGRESO', 1)`,
    [MARKER_REGRESO_USERID, TENANT_ID]
  );

  // Dia CON salida particular: entrada normal, marcador SALIDA + fichaje
  // propio (abre), marcador REGRESO + fichaje propio (cierra), salida normal.
  await db.query(
    `INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES
       (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    [
      USERID, TENANT_ID, `${DATE_WITH_EXIT} 07:00:00`,
      MARKER_SALIDA_USERID, TENANT_ID, `${DATE_WITH_EXIT} 12:00:00`,
      USERID, TENANT_ID, `${DATE_WITH_EXIT} 12:00:10`,
      MARKER_REGRESO_USERID, TENANT_ID, `${DATE_WITH_EXIT} 14:00:00`,
      USERID, TENANT_ID, `${DATE_WITH_EXIT} 14:00:10`,
      USERID, TENANT_ID, `${DATE_WITH_EXIT} 17:00:00`,
    ]
  );

  // Dia SIN salida particular: entrada y salida normales nada mas.
  await db.query(`INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?), (?, ?, ?)`, [
    USERID, TENANT_ID, `${DATE_WITHOUT_EXIT} 07:00:00`,
    USERID, TENANT_ID, `${DATE_WITHOUT_EXIT} 17:00:00`,
  ]);
});

after(async () => {
  await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]);
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/attendance-range: marca hasParticularExit=true el dia que tuvo una salida particular completa', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${DATE_WITH_EXIT}&to=${DATE_WITH_EXIT}&employeeId=${BADGE}&tenantId=${TENANT_ID}`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  const row = json.data.find((e) => String(e.employeeId) === String(BADGE));
  assert.ok(row, 'el empleado debe aparecer en el reporte');
  const day = row.days.find((d) => d.date === DATE_WITH_EXIT);
  assert.ok(day, 'el dia debe aparecer en el detalle');
  assert.equal(day.hasParticularExit, true);
});

test('/attendance-range: hasParticularExit=false un dia sin salida particular', async () => {
  const res = await fetch(`${BASE_URL}/attendance-range?from=${DATE_WITHOUT_EXIT}&to=${DATE_WITHOUT_EXIT}&employeeId=${BADGE}&tenantId=${TENANT_ID}`, { headers });
  const json = await res.json();
  const row = json.data.find((e) => String(e.employeeId) === String(BADGE));
  const day = row.days.find((d) => d.date === DATE_WITHOUT_EXIT);
  assert.equal(day.hasParticularExit, false);
});
