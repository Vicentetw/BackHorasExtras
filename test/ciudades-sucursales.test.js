// Pedido real: todo empleado debe tener ciudad y sucursal asignadas
// (surgio investigando por que el motor de asistencia no puede detectar
// turnos que cruzan medianoche para una empresa sin Plantillas -- ver
// migrations/20260917_ciudades_sucursales.sql). Cubre el CRUD de ambos
// catalogos (mismo patron que employee_categories), el aislamiento por
// tenant, que sucursal exija una ciudad valida, y que el alta/edicion de
// empleado ahora rechace faltando cualquiera de los dos.
//
// Tenants descartables propios (999945/999946), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TENANT_A = 999945;
const TENANT_B = 999946; // solo para el chequeo de aislamiento
const UID_A = 'test-ciudades-sucursales-a';
const UID_B = 'test-ciudades-sucursales-b';
const UID_SUPERADMIN = 'test-ciudades-sucursales-superadmin';

const UID_HOLIDAYS_ONLY = 'test-ciudades-sucursales-holidays-only';

let headersA;
let headersB;
let headersSuperadmin;
let headersHolidaysOnly;
let ciudadId;
let sucursalId;
let globalCiudadId;
let usageCiudadId;
let usageSucursalId;
let usageHolidayId;
let usageEmployeeId;

async function json(res) {
  const body = await res.json();
  return { status: res.status, body };
}

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Ciudades A (test)', 'tenant-ciudades-a-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_A]
  );
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Ciudades B (test)', 'tenant-ciudades-b-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_B]
  );
  headersA = await getTestAuthHeaders(UID_A, {
    isSuperadmin: false,
    tenantId: TENANT_A,
    // holidays:* sumado para las pruebas de "uso actual" de una ciudad
    // (cuenta feriados asignados) -- este usuario gestiona ambos catalogos.
    permissions: ['employees:read', 'employees:create', 'employees:update', 'employees:delete', 'holidays:read', 'holidays:create', 'holidays:update', 'holidays:delete'],
  });
  headersB = await getTestAuthHeaders(UID_B, {
    isSuperadmin: false,
    tenantId: TENANT_B,
    permissions: ['employees:read', 'employees:create', 'employees:update'],
  });
  headersSuperadmin = await getTestAuthHeaders(UID_SUPERADMIN, { isSuperadmin: true });
  // Rol real: alguien que solo administra Feriados, sin ningun permiso de
  // Empleados -- tiene que poder gestionar ciudades igual, ya que Feriados
  // ahora las usa para el alcance por ciudad.
  headersHolidaysOnly = await getTestAuthHeaders(UID_HOLIDAYS_ONLY, {
    isSuperadmin: false,
    tenantId: TENANT_A,
    permissions: ['holidays:read', 'holidays:create', 'holidays:update', 'holidays:delete'],
  });
});

after(async () => {
  await db.query('DELETE FROM holidays WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM employees WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM sucursales WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  await db.query('DELETE FROM ciudades WHERE tenant_id IN (?, ?)', [TENANT_A, TENANT_B]);
  if (globalCiudadId) {
    await db.query('DELETE FROM sucursales WHERE ciudad_id = ?', [globalCiudadId]);
    await db.query('DELETE FROM ciudades WHERE id = ?', [globalCiudadId]);
  }
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await deleteTestUser(UID_SUPERADMIN);
  await deleteTestUser(UID_HOLIDAYS_ONLY);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TENANT_A, TENANT_B]).catch(() => {});
  await closeDb();
});

test('POST /api/ciudades crea una ciudad para el tenant de quien pide', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/ciudades`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Rosario' }),
  }));
  assert.equal(status, 200, JSON.stringify(body));
  ciudadId = body.id;

  const { body: listBody } = await json(await fetch(`${BASE_URL}/api/ciudades`, { headers: headersA }));
  assert.ok(listBody.ciudades.some((c) => c.id === ciudadId && c.nombre === 'Rosario'));
});

test('POST /api/ciudades duplicada para el mismo tenant -> 409', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/ciudades`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Rosario' }),
  }));
  assert.equal(status, 409);
});

test('el tenant B no ve la ciudad del tenant A', async () => {
  const { body } = await json(await fetch(`${BASE_URL}/api/ciudades`, { headers: headersB }));
  assert.ok(!body.ciudades.some((c) => c.id === ciudadId));
});

test('POST /api/sucursales sin ciudad_id -> 400', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/sucursales`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Sucursal Centro' }),
  }));
  assert.equal(status, 400);
});

test('POST /api/sucursales con una ciudad de OTRO tenant -> 404 (no crea nada)', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/sucursales`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Sucursal Ajena', ciudad_id: ciudadId }),
  }));
  assert.equal(status, 404);
});

test('POST /api/sucursales crea una sucursal dentro de la ciudad', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/sucursales`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Sucursal Centro', ciudad_id: ciudadId }),
  }));
  assert.equal(status, 200, JSON.stringify(body));
  sucursalId = body.id;
});

test('GET /api/sucursales?ciudadId= filtra por ciudad', async () => {
  const { body } = await json(await fetch(`${BASE_URL}/api/sucursales?ciudadId=${ciudadId}`, { headers: headersA }));
  assert.equal(body.sucursales.length, 1);
  assert.equal(body.sucursales[0].id, sucursalId);
});

test('POST /api/employees sin ciudad_id/sucursal_id -> 200 igual (no bloquea el import masivo), pero queda NULL', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 991001, nombre: 'Sin Ciudad Test' }),
  }));
  assert.equal(status, 200, JSON.stringify(body));

  const [[row]] = await db.query('SELECT ciudad_id, sucursal_id FROM employees WHERE employee_id = 991001 AND tenant_id = ?', [TENANT_A]);
  assert.equal(row.ciudad_id, null);
  assert.equal(row.sucursal_id, null);
});

test('POST /api/employees con ciudad_id/sucursal_id -> 200, y hasActiveSchedule=false (sin plantilla asignada)', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 991002, nombre: 'Con Ciudad Test', ciudad_id: ciudadId, sucursal_id: sucursalId }),
  }));
  assert.equal(status, 200, JSON.stringify(body));

  const { body: listBody } = await json(await fetch(`${BASE_URL}/api/employees?limit=0`, { headers: headersA }));
  const row = listBody.data.find((e) => e.id === body.id);
  assert.ok(row, 'deberia aparecer en el listado');
  assert.equal(row.ciudad_id, ciudadId);
  assert.equal(row.sucursal_id, sucursalId);
  assert.equal(!!row.hasActiveSchedule, false, 'no tiene ninguna fila en employee_work_calendars todavia');
});

test('PUT /api/employees/:id vuelve a mandar ciudad_id/sucursal_id -- se actualizan bien (mismo patron que el resto de los campos)', async () => {
  const [[emp]] = await db.query('SELECT id FROM employees WHERE employee_id = 991002 AND tenant_id = ?', [TENANT_A]);

  const { status } = await json(await fetch(`${BASE_URL}/api/employees/${emp.id}`, {
    method: 'PUT',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 991002, nombre: 'Con Ciudad Test Editado', ciudad_id: ciudadId, sucursal_id: sucursalId }),
  }));
  assert.equal(status, 200);

  const [[row]] = await db.query('SELECT nombre, ciudad_id, sucursal_id FROM employees WHERE id = ?', [emp.id]);
  assert.equal(row.nombre, 'Con Ciudad Test Editado');
  assert.equal(row.ciudad_id, ciudadId);
  assert.equal(row.sucursal_id, sucursalId);
});

test('DELETE /api/ciudades/:id (soft delete) no rompe al empleado que ya la tiene asignada', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/ciudades/${ciudadId}`, {
    method: 'DELETE',
    headers: headersA,
  }));
  assert.equal(status, 200);

  const [[row]] = await db.query('SELECT ciudad_id FROM employees WHERE employee_id = 991002 AND tenant_id = ?', [TENANT_A]);
  assert.equal(row.ciudad_id, ciudadId, 'el empleado ya creado conserva la referencia aunque la ciudad se desactive');

  const { body } = await json(await fetch(`${BASE_URL}/api/ciudades`, { headers: headersA }));
  assert.ok(!body.ciudades.some((c) => c.id === ciudadId), 'una ciudad desactivada no aparece en el listado por defecto');
});

// Bug real reportado: crear una ciudad como superadmin (sin una empresa
// puntual seleccionada) tiraba 500 -- tenant_id quedaba NULL, columna era
// NOT NULL. Ver migrations/20260916_ciudades_tenant_id_nullable.sql.
test('POST /api/ciudades como superadmin (sin tenant) -> 200, queda global', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/ciudades`, {
    method: 'POST',
    headers: { ...headersSuperadmin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Ciudad Global (test)' }),
  }));
  assert.equal(status, 200, JSON.stringify(body));
  globalCiudadId = body.id;

  const [[row]] = await db.query('SELECT tenant_id FROM ciudades WHERE id = ?', [globalCiudadId]);
  assert.equal(row.tenant_id, null);
});

test('una ciudad global es visible para cualquier empresa, no solo la del que la creo', async () => {
  const { body } = await json(await fetch(`${BASE_URL}/api/ciudades`, { headers: headersB }));
  assert.ok(body.ciudades.some((c) => c.id === globalCiudadId), 'el tenant B deberia ver la ciudad global');
});

test('una empresa puede crear una sucursal propia bajo una ciudad global', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/sucursales`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Sucursal De B En Ciudad Global', ciudad_id: globalCiudadId }),
  }));
  assert.equal(status, 200, JSON.stringify(body));

  const [[row]] = await db.query('SELECT tenant_id, ciudad_id FROM sucursales WHERE id = ?', [body.id]);
  assert.equal(row.ciudad_id, globalCiudadId);
  assert.equal(row.tenant_id, TENANT_B, 'la sucursal en si sigue siendo de la empresa B, solo la ciudad es global');
});

test('PATCH /api/employees/bulk-location asigna ciudad/sucursal a varios de una, y no toca empleados de otra empresa', async () => {
  const mkEmployee = async (n) => {
    const res = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: { ...headersA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id: 992000 + n, nombre: `Bulk Location Test ${n}` }),
    });
    const json = await res.json();
    return json.id;
  };
  const emp1 = await mkEmployee(1);
  const emp2 = await mkEmployee(2);

  // Empleado de OTRA empresa -- su id se manda igual, mismo criterio de
  // seguridad que bulk-status: debe ignorarse silenciosamente (skipped),
  // no tocarse ni fallar toda la operacion.
  const empOtherRes = await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 992099, nombre: 'De Otra Empresa' }),
  });
  const empOther = (await empOtherRes.json()).id;

  const { status, body } = await json(await fetch(`${BASE_URL}/api/employees/bulk-location`, {
    method: 'PATCH',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [emp1, emp2, empOther], ciudad_id: globalCiudadId, sucursal_id: sucursalId }),
  }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.updated, 2);
  assert.equal(body.skipped, 1);

  const [rows] = await db.query('SELECT id, ciudad_id, sucursal_id FROM employees WHERE id IN (?, ?)', [emp1, emp2]);
  rows.forEach((r) => {
    assert.equal(r.ciudad_id, globalCiudadId);
    assert.equal(r.sucursal_id, sucursalId);
  });

  const [[otherRow]] = await db.query('SELECT ciudad_id FROM employees WHERE id = ?', [empOther]);
  assert.equal(otherRow.ciudad_id, null, 'el empleado de la otra empresa no debe haberse tocado');
});

// ---------------------------------------------------------------
// Permisos compartidos: un rol de solo Feriados (sin "employees:*")
// tiene que poder gestionar ciudades igual, ya que Feriados las usa para
// el alcance por ciudad (ver requireAnyPermission en appUserMiddleware.js).
// ---------------------------------------------------------------
test('un rol con SOLO permisos de holidays puede listar ciudades (sin employees:*)', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/ciudades`, { headers: headersHolidaysOnly }));
  assert.equal(status, 200);
});

test('un rol con SOLO permisos de holidays puede crear, editar y desactivar una ciudad', async () => {
  const { status: createStatus, body: createBody } = await json(await fetch(`${BASE_URL}/api/ciudades`, {
    method: 'POST',
    headers: { ...headersHolidaysOnly, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Ciudad Desde Feriados (test)' }),
  }));
  assert.equal(createStatus, 200, JSON.stringify(createBody));
  const id = createBody.id;

  const { status: putStatus } = await json(await fetch(`${BASE_URL}/api/ciudades/${id}`, {
    method: 'PUT',
    headers: { ...headersHolidaysOnly, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Ciudad Desde Feriados Editada (test)', active: true }),
  }));
  assert.equal(putStatus, 200);

  const { status: deleteStatus } = await json(await fetch(`${BASE_URL}/api/ciudades/${id}`, {
    method: 'DELETE',
    headers: headersHolidaysOnly,
  }));
  assert.equal(deleteStatus, 200);
});

test('un rol con SOLO permisos de holidays puede listar sucursales (lectura compartida)', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/sucursales`, { headers: headersHolidaysOnly }));
  assert.equal(status, 200);
});

test('un rol SIN employees ni holidays no puede gestionar ciudades', async () => {
  const headersSinNada = await getTestAuthHeaders('test-ciudades-sin-permisos', {
    isSuperadmin: false,
    tenantId: TENANT_A,
    permissions: ['matching:read'],
  });
  try {
    const { status } = await json(await fetch(`${BASE_URL}/api/ciudades`, {
      method: 'POST',
      headers: { ...headersSinNada, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'No Deberia Crearse (test)' }),
    }));
    assert.equal(status, 403);
  } finally {
    await deleteTestUser('test-ciudades-sin-permisos');
  }
});

// ---------------------------------------------------------------
// Uso actual (avisar antes de desactivar) -- GET /:id/usage
// ---------------------------------------------------------------
test('GET /api/ciudades/:id/usage cuenta empleados, sucursales y feriados asignados', async () => {
  const ciudad = await json(await fetch(`${BASE_URL}/api/ciudades`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Ciudad Con Uso (test)' }),
  }));
  usageCiudadId = ciudad.body.id;

  const sucursal = await json(await fetch(`${BASE_URL}/api/sucursales`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'Sucursal Con Uso (test)', ciudad_id: usageCiudadId }),
  }));
  usageSucursalId = sucursal.body.id;

  // Sin uso todavia.
  const before = await json(await fetch(`${BASE_URL}/api/ciudades/${usageCiudadId}/usage`, { headers: headersA }));
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.usage, { employees: 0, sucursales: 1, holidays: 0 });

  const employee = await json(await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: 993001, nombre: 'Empleado Con Uso Test', ciudad_id: usageCiudadId, sucursal_id: usageSucursalId }),
  }));
  usageEmployeeId = employee.body.id;

  const holiday = await json(await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}`, {
    method: 'POST',
    headers: { ...headersA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-11-15', name: 'Feriado Con Uso (test)', description: 'test', type: 'LOCAL', isWorkDay: false, recurring: false, ciudad_id: usageCiudadId }),
  }));
  usageHolidayId = holiday.body.id;

  const after1 = await json(await fetch(`${BASE_URL}/api/ciudades/${usageCiudadId}/usage`, { headers: headersA }));
  assert.deepEqual(after1.body.usage, { employees: 1, sucursales: 1, holidays: 1 });
});

test('GET /api/sucursales/:id/usage cuenta los empleados asignados', async () => {
  const { status, body } = await json(await fetch(`${BASE_URL}/api/sucursales/${usageSucursalId}/usage`, { headers: headersA }));
  assert.equal(status, 200);
  assert.deepEqual(body.usage, { employees: 1 });
});

test('desactivar la ciudad NO rompe al empleado/sucursal/feriado ya asignados (soft delete)', async () => {
  const { status } = await json(await fetch(`${BASE_URL}/api/ciudades/${usageCiudadId}`, {
    method: 'DELETE',
    headers: headersA,
  }));
  assert.equal(status, 200);

  const [[empRow]] = await db.query('SELECT ciudad_id FROM employees WHERE id = ?', [usageEmployeeId]);
  assert.equal(empRow.ciudad_id, usageCiudadId, 'el empleado conserva la ciudad aunque este desactivada');

  const { body: holidaysBody } = await json(await fetch(`${BASE_URL}/api/holidays?tenantId=${TENANT_A}&year=2026`, { headers: headersA }));
  const holidayRow = holidaysBody.holidays.find((h) => h.id === usageHolidayId);
  assert.ok(holidayRow, 'el feriado sigue existiendo');
  assert.equal(holidayRow.ciudad_nombre, 'Ciudad Con Uso (test)', 'el nombre de la ciudad se sigue resolviendo aunque este desactivada');
});

test('una sucursal de una ciudad desactivada NO aparece en el listado activo por defecto, pero SI con includeInactive', async () => {
  const { body: activeBody } = await json(await fetch(`${BASE_URL}/api/sucursales?ciudadId=${usageCiudadId}`, { headers: headersA }));
  assert.equal(activeBody.sucursales.length, 0, 'la ciudad esta desactivada -- sus sucursales no deberian ofrecerse para elegir');

  const { body: allBody } = await json(await fetch(`${BASE_URL}/api/sucursales?ciudadId=${usageCiudadId}&includeInactive=true`, { headers: headersA }));
  assert.equal(allBody.sucursales.length, 1, 'con includeInactive se sigue viendo, para mostrar el nombre de asignaciones existentes');
});
