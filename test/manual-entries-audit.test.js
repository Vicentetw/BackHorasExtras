// Auditoria de cargas manuales + aislamiento entre empresas de ManualEntries.
// Ver auditLog.js y migrations/20260927_manual_entries_exclusions_audit.sql.
//
// QUE SE PRUEBA ACA Y POR QUE
// ---------------------------
// 1. Que toda carga/edicion/borrado a mano de horas extra o de una
//    licencia deje registrado QUIEN lo hizo y COMO ESTABA ANTES. Es lo que
//    permite responder un reclamo del estilo "yo nunca pedi esa licencia" o
//    "esas horas no las autorizo nadie". Sin log, la respuesta seria "en la
//    base figura asi" y punto.
// 2. Que `ManualEntries` respete la empresa. Hasta la migracion 20260927 esa
//    tabla NO tenia tenant_id y ninguno de sus 4 endpoints validaba nada: un
//    administrador de la empresa A podia cargarle horas extra a un empleado
//    de la empresa B, o borrarle las suyas, con solo mandar/adivinar su
//    USERID de reloj (que es secuencial). Los tests de cross-tenant de abajo
//    fallan contra el codigo anterior a esa migracion.
//
// Tenants descartables propios (999974/999975), NUNCA AVP. USERIDs de reloj
// descartables (8890040+), fuera de cualquier rango real.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999974;
const TENANT_B = 999975;
const UID_A = 'test-manual-entries-audit-a';
const USERID_A = 8890040;
const USERID_B = 8890041;

let headersA;
let appUserAId;
let entryBId;      // entrada manual de la empresa B, para probar cruces
let exclusionBId;  // exclusion de la empresa B, idem

async function cleanup() {
  // Los logs van PRIMERO: `performed_by` tiene foreign key contra app_users,
  // y `created_by` tambien, asi que no se puede borrar el usuario de prueba
  // mientras queden filas apuntandole.
  await db.query('DELETE FROM manual_entry_log WHERE user_id IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM user_exclusion_log WHERE user_id IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM ManualEntries WHERE userId IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM userexclusions WHERE userId IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM user_employee_map WHERE USERID IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM users WHERE USERID IN (?, ?)', [USERID_A, USERID_B]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
}

before(async () => {
  for (const [id, name, code] of [
    [TENANT_A, 'Tenant Manual Audit A (test)', 'tenant-manual-audit-a-test'],
    [TENANT_B, 'Tenant Manual Audit B (test)', 'tenant-manual-audit-b-test']
  ]) {
    await db.query(
      `INSERT INTO tenants (id, name, code) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [id, name, code]
    );
  }

  headersA = await getTestAuthHeaders(UID_A, {
    isSuperadmin: false,
    tenantId: TENANT_A,
    permissions: ['attendance:read', 'attendance:create', 'attendance:update', 'attendance:delete',
                  'exclusions:read', 'exclusions:create', 'exclusions:update', 'exclusions:delete']
  });
  const [[appUserA]] = await db.query('SELECT id FROM app_users WHERE firebase_uid = ?', [UID_A]);
  appUserAId = appUserA.id;

  await cleanup();

  const [empA] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)', [900740, 'Empleado Manual Audit A', TENANT_A]);
  const [empB] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)', [900741, 'Empleado Manual Audit B', TENANT_B]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_A, TENANT_A, '900740', 'Empleado Manual Audit A']);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID_B, TENANT_B, '900741', 'Empleado Manual Audit B']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_A, TENANT_A, empA.insertId, 'manual']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID_B, TENANT_B, empB.insertId, 'manual']);

  // Datos ya cargados de la empresa B, que la empresa A no deberia poder ver
  // ni tocar por ningun camino.
  const [entryB] = await db.query(
    `INSERT INTO ManualEntries (tenant_id, userId, startDatetime, endDatetime, durationMinutes, type, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [TENANT_B, USERID_B, '2099-03-01 18:00:00', '2099-03-01 20:00:00', 120, 'overtime', 'HE de otra empresa (test)']
  );
  entryBId = entryB.insertId;

  const [excB] = await db.query(
    `INSERT INTO userexclusions (userId, tenant_id, excDate, reason, type) VALUES (?, ?, ?, ?, 'FULL_DAY')`,
    [USERID_B, TENANT_B, '2099-03-05', 'Licencia de otra empresa (test)']
  );
  exclusionBId = excB.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]);
  await closeDb();
});

// ---------------------------------------------------------------------------
// ManualEntries -- el ciclo completo deja rastro
// ---------------------------------------------------------------------------

test('alta de horas extra manuales: guarda empresa y autor, y deja una fila "created" en el log', async () => {
  const res = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: USERID_A,
      startDatetime: '2099-03-10 18:00:00',
      endDatetime: '2099-03-10 20:00:00',
      durationMinutes: 120,
      type: 'overtime',
      note: 'HE cargada a mano'
    })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));

  const [[entry]] = await db.query('SELECT * FROM ManualEntries WHERE id = ?', [json.id]);
  assert.equal(entry.tenant_id, TENANT_A, 'la entrada debe quedar asociada a la empresa de quien la cargo');
  assert.equal(entry.created_by, appUserAId, 'debe quedar registrado quien la cargo');

  const [logRows] = await db.query('SELECT * FROM manual_entry_log WHERE entry_id = ?', [json.id]);
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].action, 'created');
  assert.equal(logRows[0].tenant_id, TENANT_A);
  assert.equal(logRows[0].performed_by, appUserAId);
  assert.equal(logRows[0].duration_minutes, 120);
  assert.equal(logRows[0].previous_data, null, 'en un alta no hay estado anterior que guardar');
});

test('edicion: el log conserva cuanto decia ANTES, que es lo que el UPDATE pisa', async () => {
  const [[entry]] = await db.query(
    'SELECT id FROM ManualEntries WHERE userId = ? AND DATE(startDatetime) = ?',
    [USERID_A, '2099-03-10']
  );

  const res = await fetch(`${BASE_URL}/update/manual/${entry.id}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDatetime: '2099-03-10 18:00:00',
      endDatetime: '2099-03-10 22:00:00',
      durationMinutes: 240,
      type: 'overtime',
      note: 'HE ampliada a 4 horas'
    })
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

  const [[updated]] = await db.query('SELECT durationMinutes, updated_by, updatedAt FROM ManualEntries WHERE id = ?', [entry.id]);
  assert.equal(updated.durationMinutes, 240);
  assert.equal(updated.updated_by, appUserAId);
  assert.ok(updated.updatedAt, 'debe quedar la fecha de la modificacion');

  const [[logRow]] = await db.query(
    `SELECT * FROM manual_entry_log WHERE entry_id = ? AND action = 'updated'`,
    [entry.id]
  );
  assert.ok(logRow, 'debe existir una fila de log de la edicion');
  assert.equal(logRow.duration_minutes, 240, 'el log guarda como quedo');
  // Esto es el corazon del asunto: sin previous_data, nadie podria demostrar
  // despues que originalmente eran 2 horas y no 4.
  assert.equal(logRow.previous_data.durationMinutes, 120, 'el log debe conservar cuanto decia antes');
  assert.equal(logRow.previous_data.note, 'HE cargada a mano');
});

test('borrado: la entrada desaparece pero el rastro completo queda en el log', async () => {
  const [[entry]] = await db.query(
    'SELECT id FROM ManualEntries WHERE userId = ? AND DATE(startDatetime) = ?',
    [USERID_A, '2099-03-10']
  );

  const res = await fetch(`${BASE_URL}/delete/manual/${entry.id}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 200);

  const [remaining] = await db.query('SELECT id FROM ManualEntries WHERE id = ?', [entry.id]);
  assert.equal(remaining.length, 0, 'la entrada debe estar borrada de verdad');

  const [logRows] = await db.query(
    'SELECT action, duration_minutes FROM manual_entry_log WHERE entry_id = ? ORDER BY id',
    [entry.id]
  );
  assert.deepEqual(logRows.map((r) => r.action), ['created', 'updated', 'deleted'],
    'el historial completo del registro debe sobrevivir al borrado');
  assert.equal(logRows[2].duration_minutes, 240, 'el borrado guarda cuanto tenia al momento de borrarse');
});

// ---------------------------------------------------------------------------
// ManualEntries -- aislamiento entre empresas (el agujero que se tapo)
// ---------------------------------------------------------------------------

test('no se pueden cargar horas extra a un empleado de OTRA empresa', async () => {
  const res = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: USERID_B,
      startDatetime: '2099-03-11 18:00:00',
      endDatetime: '2099-03-11 20:00:00',
      durationMinutes: 120,
      type: 'overtime'
    })
  });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT id FROM ManualEntries WHERE userId = ? AND DATE(startDatetime) = ?', [USERID_B, '2099-03-11']);
  assert.equal(rows.length, 0, 'no debe haberse creado nada en la otra empresa');
});

test('no se puede editar una entrada manual de OTRA empresa', async () => {
  const res = await fetch(`${BASE_URL}/update/manual/${entryBId}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDatetime: '2099-03-01 18:00:00',
      endDatetime: '2099-03-01 23:00:00',
      durationMinutes: 300,
      type: 'overtime'
    })
  });
  assert.equal(res.status, 404);
  const [[row]] = await db.query('SELECT durationMinutes FROM ManualEntries WHERE id = ?', [entryBId]);
  assert.equal(row.durationMinutes, 120, 'la entrada de la otra empresa no debe haberse modificado');
});

test('no se puede borrar una entrada manual de OTRA empresa', async () => {
  const res = await fetch(`${BASE_URL}/delete/manual/${entryBId}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 404);
  const [rows] = await db.query('SELECT id FROM ManualEntries WHERE id = ?', [entryBId]);
  assert.equal(rows.length, 1, 'la entrada de la otra empresa debe seguir existiendo');
});

test('GET /config/manual-entries no expone las entradas de OTRA empresa', async () => {
  const res = await fetch(`${BASE_URL}/config/manual-entries?userId=${USERID_B}&date=2099-03-01`, { headers: headersA });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 0, 'no debe devolver la entrada de la otra empresa');
});

// ---------------------------------------------------------------------------
// userexclusions -- licencias y justificaciones
// ---------------------------------------------------------------------------

test('alta de una licencia: queda registrado quien la cargo', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_A, excDate: '2099-03-20', reason: 'Vacaciones', type: 'FULL_DAY' })
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

  const [[exc]] = await db.query('SELECT id, created_by FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_A, '2099-03-20']);
  assert.equal(exc.created_by, appUserAId);

  const [[logRow]] = await db.query('SELECT * FROM user_exclusion_log WHERE exclusion_id = ?', [exc.id]);
  assert.equal(logRow.action, 'created');
  assert.equal(logRow.reason, 'Vacaciones');
  assert.equal(logRow.tenant_id, TENANT_A);
  assert.equal(logRow.performed_by, appUserAId);
});

test('edicion de una licencia: el log conserva el motivo anterior', async () => {
  const [[exc]] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_A, '2099-03-20']);

  const res = await fetch(`${BASE_URL}/config/user-exclusions/${exc.id}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Licencia por enfermedad', type: 'FULL_DAY' })
  });
  assert.equal(res.status, 200);

  const [[updated]] = await db.query('SELECT reason, updated_by FROM userexclusions WHERE id = ?', [exc.id]);
  assert.equal(updated.reason, 'Licencia por enfermedad');
  assert.equal(updated.updated_by, appUserAId);

  const [[logRow]] = await db.query(
    `SELECT * FROM user_exclusion_log WHERE exclusion_id = ? AND action = 'updated'`,
    [exc.id]
  );
  assert.equal(logRow.reason, 'Licencia por enfermedad');
  assert.equal(logRow.previous_data.reason, 'Vacaciones', 'debe quedar registrado que antes decia "Vacaciones"');
});

test('borrado de una licencia: el log sobrevive', async () => {
  const [[exc]] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_A, '2099-03-20']);

  const res = await fetch(`${BASE_URL}/config/user-exclusions/${exc.id}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 200);

  const [rows] = await db.query('SELECT id FROM userexclusions WHERE id = ?', [exc.id]);
  assert.equal(rows.length, 0);

  const [logRows] = await db.query(
    'SELECT action FROM user_exclusion_log WHERE exclusion_id = ? ORDER BY id',
    [exc.id]
  );
  assert.deepEqual(logRows.map((r) => r.action), ['created', 'updated', 'deleted']);
});

test('alta por rango: una fila de log por cada dia creado', async () => {
  const res = await fetch(`${BASE_URL}/config/user-exclusions/range`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_A, dateFrom: '2099-04-01', dateTo: '2099-04-03', reason: 'Vacaciones de abril' })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.created, 3);

  const [logRows] = await db.query(
    `SELECT exc_date FROM user_exclusion_log
     WHERE user_id = ? AND action = 'created' AND exc_date BETWEEN ? AND ?
     ORDER BY exc_date`,
    [USERID_A, '2099-04-01', '2099-04-03']
  );
  assert.equal(logRows.length, 3, 'cada dia del rango debe tener su propia fila de auditoria');
});

test('toggle incluir/excluir: registra el alta y la baja por separado', async () => {
  const excludeRes = await fetch(`${BASE_URL}/config/toggle-user-exclusion`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_A, excDate: '2099-05-01', exclude: true, reason: 'Franco' })
  });
  assert.equal(excludeRes.status, 200, JSON.stringify(await excludeRes.clone().json()));

  const includeRes = await fetch(`${BASE_URL}/config/toggle-user-exclusion`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USERID_A, excDate: '2099-05-01', exclude: false })
  });
  assert.equal(includeRes.status, 200);

  const [rows] = await db.query('SELECT id FROM userexclusions WHERE userId = ? AND excDate = ?', [USERID_A, '2099-05-01']);
  assert.equal(rows.length, 0, 'la exclusion debe haberse quitado');

  const [logRows] = await db.query(
    `SELECT action, reason FROM user_exclusion_log WHERE user_id = ? AND exc_date = ? ORDER BY id`,
    [USERID_A, '2099-05-01']
  );
  assert.deepEqual(logRows.map((r) => r.action), ['created', 'deleted']);
  assert.equal(logRows[0].reason, 'Franco');
});

test('un intento fallido contra OTRA empresa no escribe nada en el log', async () => {
  const [[before]] = await db.query('SELECT COUNT(*) AS n FROM user_exclusion_log WHERE exclusion_id = ?', [exclusionBId]);

  const res = await fetch(`${BASE_URL}/config/user-exclusions/${exclusionBId}`, { method: 'DELETE', headers: headersA });
  assert.equal(res.status, 404);

  const [[after_]] = await db.query('SELECT COUNT(*) AS n FROM user_exclusion_log WHERE exclusion_id = ?', [exclusionBId]);
  assert.equal(after_.n, before.n, 'un 404 no debe dejar rastro de auditoria: no paso nada');
  const [rows] = await db.query('SELECT id FROM userexclusions WHERE id = ?', [exclusionBId]);
  assert.equal(rows.length, 1, 'la licencia de la otra empresa debe seguir existiendo');
});
