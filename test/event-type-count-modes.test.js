// Integracion end-to-end de la modalidad de descuento por motivo (dias
// corridos vs habiles, con vigencia por fecha) contra un servidor real
// corriendo (BASE_URL) y la base configurada por MYSQL_ADDON_* -- mismo
// patron que employee-capacity.test.js. La aritmetica dia-por-dia ya esta
// probada a fondo en leave-days-calculations.test.js (funcion pura); esto
// verifica el cableado real: permisos, guardado, y que preview-dias y el
// guardado real (POST) usen EXACTAMENTE el mismo calculo.
//
// Tenant descartable propio (999996), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT = 999996;
const UID_SUPERADMIN = 'test-count-modes-superadmin';
const UID_ADMIN = 'test-count-modes-admin'; // tiene settings:update
const UID_STAFF = 'test-count-modes-staff'; // NO tiene settings:update

let headersSuperadmin;
let headersAdmin;
let headersStaff;
let eventTypeId;
let employeeId;

async function json(res) {
  const body = await res.json();
  return { status: res.status, body };
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Modalidad (test)', 'tenant-modalidad-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT]
  );

  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
  headersAdmin = await getTestAuthHeaders(UID_ADMIN, {
    isSuperadmin: false,
    tenantId: TENANT,
    permissions: ['leaves:read', 'leaves:create', 'leaves:update', 'exclusions:read', 'settings:update'],
  });
  headersStaff = await getTestAuthHeaders(UID_STAFF, {
    isSuperadmin: false,
    tenantId: TENANT,
    permissions: ['leaves:read', 'leaves:create', 'leaves:update', 'exclusions:read'], // sin settings:update
  });

  const [etResult] = await db.query(
    `INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'TEST_HABIL', 'Motivo de prueba (test)', 1)`,
    [TENANT]
  );
  eventTypeId = etResult.insertId;

  const [empResult] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id) VALUES (999996, 'Empleado Prueba Modalidad', ?)`,
    [TENANT]
  );
  employeeId = empResult.insertId;
});

after(async () => {
  await db.query(`DELETE FROM employee_events WHERE employee_id = ?`, [employeeId]).catch(() => {});
  await db.query(`DELETE FROM event_type_count_modes WHERE event_type_id = ?`, [eventTypeId]).catch(() => {});
  await db.query(`DELETE FROM employees WHERE tenant_id = ?`, [TENANT]).catch(() => {});
  await db.query(`DELETE FROM event_types WHERE tenant_id = ?`, [TENANT]).catch(() => {});
  await Promise.all([deleteTestUser(UID_SUPERADMIN), deleteTestUser(UID_ADMIN), deleteTestUser(UID_STAFF)]);
  await db.query(`DELETE FROM app_users WHERE tenant_id = ?`, [TENANT]).catch(() => {});
  await db.query(`DELETE FROM tenants WHERE id = ?`, [TENANT]).catch(() => {});
  await closeDb();
});

test('sin ninguna vigencia, preview-dias cuenta corridos (comportamiento de siempre)', async () => {
  // Lun 05 a Dom 11 de enero 2026 -- semana completa, incluido fin de semana.
  const res = await fetch(
    `${BASE_URL}/api/employee-events/preview-dias?eventTypeId=${eventTypeId}&from=2026-01-05&to=2026-01-11`,
    { headers: headersAdmin }
  );
  const { status, body } = await json(res);
  assert.equal(status, 200);
  assert.equal(body.dias, 7);
});

test('un usuario SIN settings:update no puede agregar una vigencia (403)', async () => {
  const res = await fetch(`${BASE_URL}/api/event-types/${eventTypeId}/count-modes`, {
    method: 'POST',
    headers: { ...headersStaff, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo: 'habiles', vigenteDesde: '2020-01-01' }),
  });
  assert.equal(res.status, 403);
});

test('un admin de empresa (settings:update) SI puede agregar una vigencia', async () => {
  const res = await fetch(`${BASE_URL}/api/event-types/${eventTypeId}/count-modes`, {
    method: 'POST',
    headers: { ...headersAdmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo: 'habiles', vigenteDesde: '2020-01-01' }),
  });
  const { status, body } = await json(res);
  assert.equal(status, 200);
  assert.ok(body.id);
});

test('agregar la MISMA fecha de vigencia otra vez da 409 (ya existe)', async () => {
  const res = await fetch(`${BASE_URL}/api/event-types/${eventTypeId}/count-modes`, {
    method: 'POST',
    headers: { ...headersAdmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo: 'corridos', vigenteDesde: '2020-01-01' }),
  });
  assert.equal(res.status, 409);
});

test('GET count-modes devuelve la vigencia recien creada, con quien la cargo', async () => {
  const res = await fetch(`${BASE_URL}/api/event-types/${eventTypeId}/count-modes`, { headers: headersAdmin });
  const { status, body } = await json(res);
  assert.equal(status, 200);
  assert.equal(body.modos.length, 1);
  assert.equal(body.modos[0].modo, 'habiles');
  assert.equal(body.modos[0].vigente_desde, '2020-01-01');
  assert.equal(body.modos[0].created_by_email, `${UID_ADMIN}@test.local`);
});

test('con la vigencia ya cargada, preview-dias pasa a excluir el fin de semana', async () => {
  const res = await fetch(
    `${BASE_URL}/api/employee-events/preview-dias?eventTypeId=${eventTypeId}&from=2026-01-05&to=2026-01-11`,
    { headers: headersAdmin }
  );
  const { status, body } = await json(res);
  assert.equal(status, 200);
  assert.equal(body.dias, 5); // lun a vie
});

test('POST /employee-events sin mandar "dias" usa el MISMO calculo que el preview (no diffDaysInclusive)', async () => {
  const res = await fetch(`${BASE_URL}/api/employee-events`, {
    method: 'POST',
    headers: { ...headersAdmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId,
      eventTypeId,
      fechaDesde: '2026-01-05',
      fechaHasta: '2026-01-11',
      // sin "dias" a proposito -- que lo calcule el backend.
    }),
  });
  const { status, body } = await json(res);
  assert.equal(status, 200);
  assert.equal(body.dias, 5); // habil, mismo resultado que el preview de arriba

  const [[row]] = await db.query('SELECT dias FROM employee_events WHERE id = ?', [body.id]);
  assert.equal(Number(row.dias), 5);
});
