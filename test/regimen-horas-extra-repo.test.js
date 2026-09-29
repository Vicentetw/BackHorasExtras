// Lectura de la configuracion del regimen de horas extra (B1), contra la base.
// Tenants descartables propios (999995/999996), NUNCA AVP. No usa el servidor.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { cargarConfiguracion } = require('../motor-laboral/repositories/regimenHorasExtraRepository');

const T = 999995;
const OTRA = 999996;
let chineli, admin, regimenHE, regimenAdmin;

async function cleanup() {
  for (const t of [T, OTRA]) {
    await db.query('DELETE FROM overtime_excess_approvals WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_overtime_authorizations WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM day_type_overtime_rules WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_convention_assignments WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM labor_conventions WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
  }
}

before(async () => {
  for (const id of [T, OTRA]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, `Regimen HE ${id} (test)`, `regimen-he-${id}-test`]);
  }
  await cleanup();
  const [e1] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (900851, 'Chineli (test)', ?, 1)`, [T]);
  const [e2] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo) VALUES (900852, 'Administrativo (test)', ?, 1)`, [T]);
  chineli = e1.insertId; admin = e2.insertId;
  const [c1] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Horas extra (test)')`, [T]);
  const [c2] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Administrativo (test)')`, [T]);
  regimenHE = c1.insertId; regimenAdmin = c2.insertId;

  // Chineli pasa al regimen de horas extra recien el 01/09.
  await db.query(`INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', '2026-08-31'), (?, ?, ?, '2026-09-01', NULL)`,
    [chineli, T, regimenAdmin, chineli, T, regimenHE]);
  await db.query(`INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [admin, T, regimenAdmin]);

  // Empresa: 30 h/mes avisando. Regimen HE: 40 h/mes sin computar el excedente.
  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos, politica_excedente) VALUES (?, NULL, '2020-01-01', 1800, 'AVISAR')`, [T]);
  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos, tope_dia_minutos, politica_excedente, minimo_minutos) VALUES (?, ?, '2026-01-01', 2400, 180, 'NO_COMPUTAR', 30)`, [T, regimenHE]);
  // Chineli autorizado a 60 h/mes desde el 15/09.
  await db.query(`INSERT INTO employee_overtime_authorizations (tenant_id, employee_id, tope_mes_minutos, vigente_desde, motivo) VALUES (?, ?, 3600, '2026-09-15', 'obra de emergencia')`, [T, chineli]);
  await db.query(`INSERT INTO overtime_excess_approvals (tenant_id, employee_id, periodo, minutos, motivo) VALUES (?, ?, '2026-09', 300, 'aprobado por jefe'), (?, ?, '2026-09', 120, 'segunda aprobacion')`, [T, chineli, T, chineli]);
  await db.query(`INSERT INTO day_type_overtime_rules (tenant_id, convention_id, day_type, trigger_type, classification_type, rate) VALUES (?, ?, 'SATURDAY', 'AFTER_SCHEDULE', 'EXTRA', 50), (?, ?, 'SATURDAY', 'AFTER_SCHEDULE', 'REGISTRAR', NULL)`,
    [T, regimenHE, T, regimenAdmin]);

  // Otra empresa con su propia politica: no se tiene que mezclar.
  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos) VALUES (?, NULL, '2020-01-01', 99)`, [OTRA]);
});

after(async () => {
  await cleanup();
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await db.end();
});

test('el regimen de la persona sale de su asignacion vigente en cada fecha', async () => {
  const c = await cargarConfiguracion(db, T, { empleados: [chineli, admin], desde: '2026-08-01', hasta: '2026-09-30' });
  assert.equal(c.regimenDe(chineli, '2026-08-20'), regimenAdmin);
  assert.equal(c.regimenDe(chineli, '2026-09-02'), regimenHE);
  assert.equal(c.hayConfiguracion, true);
});

test('politica: la del regimen si tiene; si no, la de la empresa', async () => {
  const c = await cargarConfiguracion(db, T, { empleados: [chineli, admin], desde: '2026-09-01', hasta: '2026-09-30' });
  const he = c.politicaPara(regimenHE, '2026-09-10');
  assert.deepEqual(he.topes, { dia: 180, mes: 2400, anio: null });
  assert.equal(he.politica, 'NO_COMPUTAR');
  assert.equal(he.minimo, 30);
  const empresa = c.politicaPara(regimenAdmin, '2026-09-10');
  assert.equal(empresa.topes.mes, 1800, 'el regimen Administrativo no tiene politica propia: usa la de la empresa');
  assert.equal(empresa.politica, 'AVISAR');
});

test('autorizacion individual segun la fecha, y aprobaciones sumadas por mes', async () => {
  const c = await cargarConfiguracion(db, T, { empleados: [chineli], desde: '2026-09-01', hasta: '2026-09-30' });
  assert.equal(c.autorizacionPara(chineli, '2026-09-10'), null, 'antes del 15/09 no tenia');
  assert.equal(c.autorizacionPara(chineli, '2026-09-20').mes, 3600);
  assert.equal(c.aprobadosEn(chineli, '2026-09'), 420);
  assert.equal(c.aprobadosEn(chineli, '2026-10'), 0);
});

test('reglas por tipo de dia del regimen de cada uno', async () => {
  const c = await cargarConfiguracion(db, T, { empleados: [chineli, admin], desde: '2026-09-01', hasta: '2026-09-30' });
  assert.equal(c.reglasDe(regimenHE)[0].classification_type, 'EXTRA');
  assert.equal(c.reglasDe(regimenAdmin)[0].classification_type, 'REGISTRAR');
});

test('una empresa no ve la configuracion de otra, y sin configuracion hayConfiguracion es false', async () => {
  const otra = await cargarConfiguracion(db, OTRA, { empleados: [chineli], desde: '2026-09-01', hasta: '2026-09-30' });
  assert.equal(otra.regimenDe(chineli, '2026-09-10'), null, 'la asignacion de Chineli es de la otra empresa');
  assert.equal(otra.politicaPara(null, '2026-09-10').topes.mes, 99);
  const nada = await cargarConfiguracion(db, 424242, { empleados: [], desde: '2026-09-01', hasta: '2026-09-30' });
  assert.equal(nada.hayConfiguracion, false);
});
