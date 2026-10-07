// Aislamiento entre empresas en el motor laboral (auditoria 2026-10-07,
// hallazgos A, B y C). Antes de este arreglo, un admin de la empresa B podia:
//   A) leer, crear, cambiar y borrar los bloques de horario de las plantillas
//      de la empresa A (comprobado en vivo: borro 21 bloques de otra empresa);
//   B) ver la lista de empleados de TODAS las empresas;
//   C) cambiarle la categoria a empleados de otra empresa.
// Cada prueba controla las dos caras: la empresa duena SI puede (para que el
// test no pase "en verde" sin probar nada) y la otra NO.
//
// Requiere el backend local corriendo (node horasdedica.js, puerto 3000).
// Tenants descartables propios (999947/999948), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999947;
const B = 999948;
const UID_A = 'test-aislamiento-motor-a';
const UID_B = 'test-aislamiento-motor-b';
const API = `${BASE_URL}/api/labor-engine/admin`;

let hA; let hB;
let plantilla; let bloque; let empleadoA; let empleadoB; let categoriaA; let categoriaB;

const pedir = (url, h, method = 'GET', body) => fetch(url, {
  method, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const BLOQUE = { day_of_week: 1, name: 'cambiado', start_time: '01:00', end_time: '02:00', type: 'WORK', active: 1 };

async function cleanup() {
  await db.query('DELETE sb FROM shift_blocks sb JOIN work_schedule_templates w ON w.id = sb.template_id WHERE w.tenant_id IN (?, ?)', [A, B]);
  for (const t of ['work_schedule_templates', 'employees', 'employee_categories']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id IN (?, ?)`, [A, B]);
  }
}

before(async () => {
  for (const [id, code] of [[A, 'aisl-motor-a'], [B, 'aisl-motor-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await cleanup();
  hA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: A });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: B });
  const [t] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Plantilla de A (test)', 'fixed', 1, 1)`, [A]);
  plantilla = t.insertId;
  const [b] = await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Bloque de A', '07:00:00', '14:00:00', 'WORK', 1)`, [plantilla]);
  bloque = b.insertId;
  const [ca] = await db.query('INSERT INTO employee_categories (tenant_id, name) VALUES (?, ?)', [A, 'Categoria A (test)']);
  categoriaA = ca.insertId;
  const [cb] = await db.query('INSERT INTO employee_categories (tenant_id, name) VALUES (?, ?)', [B, 'Categoria B (test)']);
  categoriaB = cb.insertId;
  const [ea] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, activo, category_id) VALUES (901301, 'Empleado de A (test)', ?, '2020-01-01', 1, ?)`, [A, categoriaA]);
  empleadoA = ea.insertId;
  const [eb] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, activo, category_id) VALUES (901302, 'Empleado de B (test)', ?, '2020-01-01', 1, ?)`, [B, categoriaB]);
  empleadoB = eb.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID_A);
  await deleteTestUser(UID_B);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

const bloqueEnLaBase = async () => {
  const [[r]] = await db.query("SELECT block_name, TIME_FORMAT(start_time, '%H:%i') AS desde FROM shift_blocks WHERE id = ?", [bloque]);
  return r ? { ...r } : null;
};

test('A. la empresa duena ve los bloques de su plantilla; otra empresa recibe 404', async () => {
  const propio = await pedir(`${API}/templates/${plantilla}/blocks`, hA);
  assert.equal(propio.status, 200);
  assert.equal((await propio.json()).length, 1);
  assert.equal((await pedir(`${API}/templates/${plantilla}/blocks`, hB)).status, 404);
});

test('A. otra empresa no puede cambiar, borrar ni agregar bloques; la duena si', async () => {
  assert.equal((await pedir(`${API}/blocks/${bloque}`, hB, 'PUT', BLOQUE)).status, 404);
  assert.equal((await pedir(`${API}/blocks/${bloque}`, hB, 'DELETE')).status, 404);
  assert.equal((await pedir(`${API}/templates/${plantilla}/blocks`, hB, 'POST', BLOQUE)).status, 404);
  assert.deepEqual(await bloqueEnLaBase(), { block_name: 'Bloque de A', desde: '07:00' }, 'el bloque de A sigue intacto');
  const [[n]] = await db.query('SELECT COUNT(*) AS n FROM shift_blocks WHERE template_id = ?', [plantilla]);
  assert.equal(n.n, 1, 'no se agrego ningun bloque');

  assert.equal((await pedir(`${API}/blocks/${bloque}`, hA, 'PUT', BLOQUE)).status, 200);
  assert.deepEqual(await bloqueEnLaBase(), { block_name: 'cambiado', desde: '01:00' }, 'la duena si puede');
});

test('B. la lista de empleados del motor solo trae los de la propia empresa', async () => {
  const deB = await (await pedir(`${API}/employees`, hB)).json();
  assert.ok(deB.some((e) => e.employee_id === empleadoB), 'B ve a su empleado');
  assert.ok(!deB.some((e) => e.employee_id === empleadoA), 'B no ve al empleado de A');
  const deA = await (await pedir(`${API}/employees`, hA)).json();
  assert.ok(deA.some((e) => e.employee_id === empleadoA));
  assert.ok(!deA.some((e) => e.employee_id === empleadoB));
});

test('C. otra empresa no puede cambiarle la categoria a un empleado ajeno, ni usar una categoria ajena', async () => {
  const r = await pedir(`${API}/employees/bulk-set-categoria`, hB, 'POST', { employeeIds: [empleadoA], categoryId: categoriaB });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).affectedRows, 0, 'no toca empleados de otra empresa');
  const [[ea]] = await db.query('SELECT category_id FROM employees WHERE id = ?', [empleadoA]);
  assert.equal(ea.category_id, categoriaA);

  assert.equal((await pedir(`${API}/employees/bulk-set-categoria`, hB, 'POST', { employeeIds: [empleadoB], categoryId: categoriaA })).status, 404,
    'una categoria de otra empresa no existe para B');

  const propio = await pedir(`${API}/employees/bulk-set-categoria`, hA, 'POST', { employeeIds: [empleadoA], categoryId: categoriaA });
  assert.equal((await propio.json()).affectedRows, 1, 'la duena si puede');
});
