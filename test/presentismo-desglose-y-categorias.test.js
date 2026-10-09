// P1 (totales de Presentismo que suman) y P5 (plantilla/convenio sugeridos
// por categoría), 2026-10-08.
//
// El primer test es puro. Los de categorías requieren el backend local
// corriendo (puerto 3000) y la migración 20261016 aplicada en la base local.
// Tenants descartables propios (999915/999916), NUNCA AVP.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { desgloseDelDia } = require('../motor-laboral/services/attendanceService');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999915;
const B = 999916;
let hA; let hB; let catA; let catB; let tplA; let tplB; let convA; let regA; let convB;

const fila = (status, extra = {}) => ({ status, activo: true, totalCheckins: 0, fueraDeHorario: null, ...extra });

test('desglose: solo activos, cada uno en un grupo, y las partes suman el total', () => {
  const filas = [
    fila('OnTime', { totalCheckins: 2 }), fila('OnTime', { totalCheckins: 2, fueraDeHorario: { tipo: 'x' } }),
    fila('Late', { totalCheckins: 2 }), fila('LateJustified', { totalCheckins: 2 }),
    fila('Absent'), fila('PartialAbsence', { totalCheckins: 1 }), fila('Excused'),
    fila('Campaign', { campaignCountsAs: 'excusado' }), fila('Campaign', { campaignCountsAs: 'trabajado' }),
    fila('WorkedHoliday', { totalCheckins: 2 }), fila('HolidayAbsent'), fila('NonWorkDay'),
    // P3: activo sin ningún horario.
    fila('NoSchedule'),
    // Inactivos: no cuentan; uno sin fichar (Inactive), uno un domingo (NonWorkDay), uno que fichó.
    fila('Inactive', { activo: false }), fila('NonWorkDay', { activo: false }), fila('OnTime', { activo: false, totalCheckins: 2 }),
  ];
  const d = desgloseDelDia(filas);
  const suma = d.aTiempo + d.tarde + d.tardeJustificada + d.ausente + d.ausenciaParcial + d.excusado + d.campana + d.feriado + d.noLaborable + d.sinHorario;
  assert.equal(d.total, 13);
  assert.equal(suma, d.total, 'las partes suman el total');
  assert.deepEqual([d.aTiempo, d.campana, d.feriado, d.noLaborable, d.sinHorario], [2, 2, 2, 1, 1]);
  assert.equal(d.fueraDeHorario, 1, 'aviso aparte: no se suma');
  assert.deepEqual([d.inactivos, d.inactivosQueFicharon], [3, 1]);
  // Un backend que no manda "activo" (filas viejas): se toman como activos.
  assert.equal(desgloseDelDia([{ status: 'OnTime' }]).total, 1);
});

async function cleanup() {
  for (const t of [A, B]) {
    await db.query('DELETE FROM employee_categories WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM labor_convention_regimes WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM labor_conventions WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

before(async () => {
  for (const [id, code] of [[A, 'sugerencias-a'], [B, 'sugerencias-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  await cleanup();
  hA = await getTestAuthHeaders('test-sugerencias-a', { isSuperadmin: false, tenantId: A, permissions: ['employees:read', 'employees:update'] });
  hB = await getTestAuthHeaders('test-sugerencias-b', { isSuperadmin: false, tenantId: B, permissions: ['employees:read', 'employees:update'] });
  catA = (await db.query("INSERT INTO employee_categories (tenant_id, name, active) VALUES (?, 'Serenos (test)', 1)", [A]))[0].insertId;
  catB = (await db.query("INSERT INTO employee_categories (tenant_id, name, active) VALUES (?, 'Serenos (test)', 1)", [B]))[0].insertId;
  tplA = (await db.query("INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Sereno (test)', 'FIXED', 1, 0)", [A]))[0].insertId;
  tplB = (await db.query("INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Sereno (test)', 'FIXED', 1, 0)", [B]))[0].insertId;
  convA = (await db.query("INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio A (test)', 1)", [A]))[0].insertId;
  convB = (await db.query("INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio B (test)', 1)", [B]))[0].insertId;
  regA = (await db.query("INSERT INTO labor_convention_regimes (tenant_id, convention_id, name, active) VALUES (?, ?, 'Semanal (test)', 1)", [A, convA]))[0].insertId;
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-sugerencias-a');
  await deleteTestUser('test-sugerencias-b');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

const guardar = (h, id, body) => fetch(`${BASE_URL}/api/employee-categories/${id}/sugerencias`, {
  method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('sugerencias de la categoría: se guardan y vuelven en el listado', async () => {
  const r = await guardar(hA, catA, { plantilla_sugerida_id: tplA, convenio_sugerido_id: convA, regimen_sugerido_id: regA });
  assert.equal(r.status, 200);
  const lista = await (await fetch(`${BASE_URL}/api/employee-categories`, { headers: hA })).json();
  const c = lista.categories.find((x) => x.id === catA);
  assert.deepEqual([c.plantilla_sugerida_id, c.convenio_sugerido_id, c.regimen_sugerido_id], [tplA, convA, regA]);
  // Sacarlas.
  assert.equal((await guardar(hA, catA, { plantilla_sugerida_id: null, convenio_sugerido_id: null })).status, 200);
  const otra = (await (await fetch(`${BASE_URL}/api/employee-categories`, { headers: hA })).json()).categories.find((x) => x.id === catA);
  assert.deepEqual([otra.plantilla_sugerida_id, otra.convenio_sugerido_id, otra.regimen_sugerido_id], [null, null, null]);
});

test('alta de empleado: guarda la categoría (antes la ignoraba) y rechaza una de otra empresa', async () => {
  const h = await getTestAuthHeaders('test-sugerencias-alta', { isSuperadmin: false, tenantId: A, permissions: ['employees:create', 'employees:update'] });
  try {
    const alta = (body) => fetch(`${BASE_URL}/api/employees`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await alta({ employee_id: 901916, nombre: 'Con categoría (test)', category_id: catA });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    const [[e]] = await db.query('SELECT category_id FROM employees WHERE id = ?', [id]);
    assert.equal(e.category_id, catA);
    assert.equal((await alta({ employee_id: 901917, nombre: 'Categoría ajena (test)', category_id: catB })).status, 400);
    // Editar con una categoría de otra empresa: tampoco.
    const ed = await fetch(`${BASE_URL}/api/employees/${id}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: 901916, nombre: 'Con categoría (test)', category_id: catB }) });
    assert.equal(ed.status, 400);
  } finally {
    await db.query('DELETE FROM employees WHERE tenant_id = ? AND employee_id IN (901916, 901917)', [A]);
    await deleteTestUser('test-sugerencias-alta');
  }
});

test('aislamiento: no se puede sugerir algo de otra empresa ni tocar una categoría ajena', async () => {
  assert.equal((await guardar(hA, catA, { plantilla_sugerida_id: tplB })).status, 400, 'plantilla de otra empresa');
  assert.equal((await guardar(hA, catA, { convenio_sugerido_id: convB })).status, 400, 'convenio de otra empresa');
  assert.equal((await guardar(hA, catA, { convenio_sugerido_id: convA, regimen_sugerido_id: 99999999 })).status, 400, 'régimen que no es del convenio');
  assert.equal((await guardar(hB, catA, { plantilla_sugerida_id: null })).status, 404, 'categoría de otra empresa');
});
