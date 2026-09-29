// Regimenes dentro de un convenio (migracion 20261007): herencia de reglas y
// topes (regimen > convenio > empresa), API y aislamiento por empresa.
// Requiere el backend local corriendo. Tenants descartables (999983/999984).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { cargarConfiguracion } = require('../motor-laboral/repositories/regimenHorasExtraRepository');
const { resolveOvertimeRate } = require('../motor-laboral/services/dayTypeRuleResolver');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN = `${URL}/api/labor-engine/admin`;
const HE = `${URL}/api/regimen-horas-extra`;
const T = 999983;
const OTRA = 999984;
const PERMISOS = ['schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete', 'attendance:read'];
let h, hOtra, conv, convOtro, chofer, administrativo, sinRegimen;

const pedir = (metodo, url, body, headers = h) => fetch(url, {
  method: metodo, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

async function cleanup() {
  await db.query('DELETE FROM day_type_overtime_rules WHERE convention_id IN (SELECT id FROM labor_conventions WHERE tenant_id IN (?, ?))', [T, OTRA]);
  for (const t of ['overtime_regime_policies', 'day_type_overtime_rules', 'employee_convention_assignments',
    'labor_convention_regimes', 'labor_conventions', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id IN (?, ?)`, [T, OTRA]);
  }
}

before(async () => {
  for (const id of [T, OTRA]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, `Regimenes ${id} (test)`, `regimenes-${id}-test`]);
  }
  h = await getTestAuthHeaders('test-regimenes', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  hOtra = await getTestAuthHeaders('test-regimenes-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  await cleanup();
  const [c] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Camioneros (test)')`, [T]);
  const [c2] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Comercio (test)')`, [T]);
  conv = c.insertId; convOtro = c2.insertId;
  const ids = [];
  for (const [legajo, nombre] of [[900881, 'Chofer (test)'], [900882, 'Administrativo (test)'], [900883, 'Sin regimen (test)']]) {
    const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (?, ?, ?, 1)`, [legajo, nombre, T]);
    ids.push(e.insertId);
  }
  [chofer, administrativo, sinRegimen] = ids;
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-regimenes');
  await deleteTestUser('test-regimenes-otra');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

let conHE, soloRegistra;

test('regimenes: se crean dentro del convenio; nombre unico por convenio; otra empresa no los ve', async () => {
  const r1 = await pedir('POST', `${ADMIN}/conventions/${conv}/regimes`, { name: 'Con horas extra' });
  assert.equal(r1.status, 201, await r1.clone().text());
  conHE = (await r1.json()).id;
  soloRegistra = (await (await pedir('POST', `${ADMIN}/conventions/${conv}/regimes`, { name: 'Solo se registra' })).json()).id;
  assert.equal((await pedir('POST', `${ADMIN}/conventions/${conv}/regimes`, { name: 'Con horas extra' })).status, 409);
  assert.equal((await pedir('POST', `${ADMIN}/conventions/${conv}/regimes`, { name: '  ' })).status, 400);

  const lista = await (await pedir('GET', `${ADMIN}/conventions/${conv}/regimes`)).json();
  assert.deepEqual(lista.map((r) => r.name), ['Con horas extra', 'Solo se registra']);

  assert.equal((await pedir('GET', `${ADMIN}/conventions/${conv}/regimes`, null, hOtra)).status, 404);
  assert.equal((await pedir('POST', `${ADMIN}/conventions/${conv}/regimes`, { name: 'x' }, hOtra)).status, 404);
  assert.equal((await pedir('PUT', `${ADMIN}/regimes/${conHE}`, { name: 'robado' }, hOtra)).status, 404);
  assert.equal((await pedir('DELETE', `${ADMIN}/regimes/${conHE}`, null, hOtra)).status, 404);
});

test('encuadramiento, reglas y topes: el regimen tiene que ser de ESE convenio', async () => {
  const mal = await pedir('POST', `${ADMIN}/employees/${chofer}/convention-assignments`, { convention_id: convOtro, regime_id: conHE, valid_from: '2026-01-01' });
  assert.equal(mal.status, 400);
  for (const [emp, regime_id] of [[chofer, conHE], [administrativo, soloRegistra], [sinRegimen, null]]) {
    const r = await pedir('POST', `${ADMIN}/employees/${emp}/convention-assignments`, { convention_id: conv, regime_id, valid_from: '2026-01-01' });
    assert.equal(r.status, 201, await r.clone().text());
  }
  const [asig] = await (await pedir('GET', `${ADMIN}/employees/${chofer}/convention-assignments`)).json();
  assert.equal(asig.regime_id, conHE);

  assert.equal((await pedir('POST', `${ADMIN}/day-type-rules`, { convention_id: convOtro, regime_id: conHE, day_type: 'SATURDAY', trigger_type: 'ALL_DAY' })).status, 400);
  assert.equal((await pedir('POST', `${ADMIN}/day-type-rules`, { regime_id: conHE, day_type: 'SATURDAY', trigger_type: 'ALL_DAY' })).status, 400);
  assert.equal((await pedir('POST', `${HE}/politicas`, { conventionId: convOtro, regimeId: conHE, vigenteDesde: '2026-01-01' })).status, 404);
  assert.equal((await pedir('POST', `${HE}/politicas`, { conventionId: conv, regimeId: conHE, vigenteDesde: '2026-01-01' }, hOtra)).status, 404);

  // Convenio: sabado y domingo al 50 %, 30 h/mes. Regimen "solo se registra":
  // cambia SOLO el sabado y los topes; el domingo lo hereda del convenio.
  for (const body of [
    { convention_id: conv, day_type: 'SATURDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 50 },
    { convention_id: conv, day_type: 'SUNDAY', trigger_type: 'ALL_DAY', classification_type: 'EXTRA', rate: 50 },
    { convention_id: conv, regime_id: soloRegistra, day_type: 'SATURDAY', trigger_type: 'ALL_DAY', classification_type: 'REGISTRAR' },
  ]) {
    const r = await pedir('POST', `${ADMIN}/day-type-rules`, body);
    assert.equal(r.status, 201, await r.clone().text());
  }
  assert.equal((await pedir('POST', `${HE}/politicas`, { conventionId: conv, vigenteDesde: '2026-01-01', topeMesMinutos: 1800 })).status, 201);
  assert.equal((await pedir('POST', `${HE}/politicas`, { conventionId: conv, regimeId: conHE, vigenteDesde: '2026-01-01', topeMesMinutos: 2400 })).status, 201);
  // La del regimen convive con la del convenio en la misma fecha; repetida, no.
  assert.equal((await pedir('POST', `${HE}/politicas`, { conventionId: conv, regimeId: conHE, vigenteDesde: '2026-01-01' })).status, 409);
  const { politicas } = await (await pedir('GET', `${HE}/politicas`)).json();
  assert.ok(politicas.some((p) => p.regimen_interno === 'Con horas extra'));
});

test('calculo: gana lo mas especifico (regimen > convenio > empresa), por tipo de dia', async () => {
  const cfg = await cargarConfiguracion(db, T, { empleados: [chofer, administrativo, sinRegimen], desde: '2026-09-01', hasta: '2026-09-30' });
  const f = '2026-09-12';
  const enc = (e) => cfg.encuadreDe(e, f);
  assert.deepEqual(enc(chofer), { conventionId: conv, regimeId: conHE });
  assert.equal(cfg.regimenDe(chofer, f), conv, 'regimenDe sigue devolviendo el convenio');

  const tope = (e) => cfg.politicaPara(enc(e).conventionId, f, enc(e).regimeId).topes.mes;
  assert.equal(tope(chofer), 2400, 'el regimen con topes propios');
  assert.equal(tope(administrativo), 1800, 'regimen sin topes propios: hereda los del convenio');
  assert.equal(tope(sinRegimen), 1800);

  const reglas = (e) => Object.fromEntries(cfg.reglasDe(enc(e).conventionId, enc(e).regimeId).map((r) => [r.day_type, r.classification_type]));
  assert.deepEqual(reglas(administrativo), { SATURDAY: 'REGISTRAR', SUNDAY: 'EXTRA' }, 'cambia el sabado, hereda el domingo');
  assert.deepEqual(reglas(chofer), { SATURDAY: 'EXTRA', SUNDAY: 'EXTRA' });
  assert.deepEqual(reglas(sinRegimen), { SATURDAY: 'EXTRA', SUNDAY: 'EXTRA' }, 'la regla de un regimen no alcanza a los demas');
});

test('motor anterior: la regla del regimen es mas especifica que la del convenio', () => {
  const base = { day_type: 'SATURDAY', trigger_type: 'ALL_DAY', active: 1 };
  const reglas = [
    { ...base, tenant_id: 1, rate: 10 },
    { ...base, convention_id: 5, rate: 50 },
    { ...base, convention_id: 5, regime_id: 7, rate: 0, classification_type: 'REGISTRAR' },
  ];
  assert.equal(resolveOvertimeRate(reglas, { dayType: 'SATURDAY', trigger: 'ALL_DAY' }).classificationType, 'REGISTRAR');
  assert.equal(resolveOvertimeRate(reglas.slice(0, 2), { dayType: 'SATURDAY', trigger: 'ALL_DAY' }).rate, 50);
  // La plantilla sigue ganando sobre todo lo demas.
  assert.equal(resolveOvertimeRate([...reglas, { ...base, template_id: 3, rate: 100 }], { dayType: 'SATURDAY', trigger: 'ALL_DAY' }).rate, 100);
});

test('un regimen en uso no se borra (se desactiva); uno sin uso si', async () => {
  assert.equal((await pedir('DELETE', `${ADMIN}/regimes/${soloRegistra}`)).status, 409);
  const [r] = await (await pedir('POST', `${ADMIN}/conventions/${conv}/regimes`, { name: 'Temporal' })).json().then((x) => [x]);
  assert.equal((await pedir('PUT', `${ADMIN}/regimes/${r.id}`, { name: 'Temporal 2', active: false })).status, 200);
  assert.equal((await pedir('DELETE', `${ADMIN}/regimes/${r.id}`)).status, 200);
});
