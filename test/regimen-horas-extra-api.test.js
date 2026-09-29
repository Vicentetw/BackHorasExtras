// /api/regimen-horas-extra (B4): validaciones, autor y aislamiento por empresa.
// Requiere el backend local corriendo. Tenants descartables (999998/999999).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE = `${process.env.TEST_BASE_URL || 'http://localhost:3000'}/api/regimen-horas-extra`;
const T = 999998;
const OTRA = 999999;
const PERMISOS = ['schedules:read', 'schedules:update', 'attendance:read', 'attendance:update'];
let h, hOtra, emp, conv;

const post = (ruta, body, headers = h) => fetch(`${BASE}${ruta}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = async (ruta, headers = h) => (await fetch(`${BASE}${ruta}`, { headers })).json();

async function cleanup() {
  for (const t of ['overtime_excess_approvals', 'employee_overtime_authorizations', 'overtime_regime_policies', 'labor_conventions', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id IN (?, ?)`, [T, OTRA]);
  }
}

before(async () => {
  for (const id of [T, OTRA]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, `Regimen API ${id} (test)`, `regimen-api-${id}-test`]);
  }
  h = await getTestAuthHeaders('test-regimen-api', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  hOtra = await getTestAuthHeaders('test-regimen-api-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  await cleanup();
  const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (900871, 'Regimen API (test)', ?, 1)`, [T]);
  emp = e.insertId;
  const [c] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Horas extra (test)')`, [T]);
  conv = c.insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-regimen-api');
  await deleteTestUser('test-regimen-api-otra');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

test('politica: se crea con autor; valida minutos y fecha; una por fecha', async () => {
  assert.equal((await post('/politicas', { conventionId: conv, vigenteDesde: '2026-01-01', topeMesMinutos: -5 })).status, 400);
  assert.equal((await post('/politicas', { conventionId: conv, topeMesMinutos: 2400 })).status, 400);
  const ok = await post('/politicas', { conventionId: conv, vigenteDesde: '2026-01-01', topeMesMinutos: 2400, politicaExcedente: 'NO_COMPUTAR' });
  assert.equal(ok.status, 201, await ok.text());
  assert.equal((await post('/politicas', { conventionId: conv, vigenteDesde: '2026-01-01' })).status, 409);
  const { politicas } = await get('/politicas');
  assert.equal(politicas[0].tope_mes_minutos, 2400);
  assert.ok(politicas[0].created_by_email);
});

test('otra empresa no ve ni usa el regimen ajeno', async () => {
  assert.equal((await get('/politicas', hOtra)).politicas.length, 0);
  assert.equal((await post('/politicas', { conventionId: conv, vigenteDesde: '2026-02-01' }, hOtra)).status, 404);
  assert.equal((await post('/autorizaciones', { employeeId: emp, vigenteDesde: '2026-09-01', topeMesMinutos: 3600, motivo: 'x' }, hOtra)).status, 404);
  assert.equal((await post('/aprobaciones', { employeeId: emp, periodo: '2026-09', minutos: 60, motivo: 'x' }, hOtra)).status, 404);
});

test('autorizacion individual: motivo y al menos un tope obligatorios', async () => {
  assert.equal((await post('/autorizaciones', { employeeId: emp, vigenteDesde: '2026-09-01', topeMesMinutos: 3600 })).status, 400);
  assert.equal((await post('/autorizaciones', { employeeId: emp, vigenteDesde: '2026-09-01', motivo: 'obra' })).status, 400);
  assert.equal((await post('/autorizaciones', { employeeId: emp, vigenteDesde: '2026-09-01', topeMesMinutos: 3600, motivo: 'obra de emergencia' })).status, 201);
  const { autorizaciones } = await get(`/autorizaciones?employeeId=${emp}`);
  assert.equal(autorizaciones[0].tope_mes_minutos, 3600);
});

test('aprobacion de excedente: periodo AAAA-MM, minutos positivos y motivo', async () => {
  assert.equal((await post('/aprobaciones', { employeeId: emp, periodo: '2026-9', minutos: 60, motivo: 'x' })).status, 400);
  assert.equal((await post('/aprobaciones', { employeeId: emp, periodo: '2026-09', minutos: 0, motivo: 'x' })).status, 400);
  assert.equal((await post('/aprobaciones', { employeeId: emp, periodo: '2026-09', minutos: 300, motivo: 'aprobado por el jefe de obra' })).status, 201);
  const { aprobaciones } = await get(`/aprobaciones?employeeId=${emp}&periodo=2026-09`);
  assert.equal(aprobaciones[0].minutos, 300);
  // Por legajo (lo que usa Presentismo) da lo mismo.
  const porLegajo = await get('/aprobaciones?legajo=900871&periodo=2026-09');
  assert.equal(porLegajo.aprobaciones[0].minutos, 300);
  assert.equal((await post('/aprobaciones', { legajo: 900871, periodo: '2026-09', minutos: 60, motivo: 'por legajo' })).status, 201);
});
