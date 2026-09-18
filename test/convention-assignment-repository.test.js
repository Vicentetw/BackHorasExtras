// Etapa 9 del plan "Motor de reglas de asistencia configurable" --
// requiere DB real (mismo patron que scheduleRepository), NO requiere el
// backend levantado (no pega a ningun endpoint HTTP).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { findActiveAssignment, findActiveAssignmentsForEmployees } = require('../motor-laboral/repositories/conventionAssignmentRepository');

const TENANT_ID = 999967;

let db;
let employeeWithoutConventionId;
let employeeWithConventionId;
let employeeWithChangeId;
let employeeWithCategoryChangeId;
let conventionAId;
let conventionBId;

before(async () => {
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306
  });

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Convenios (test)', 'tenant-convenios-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [convA] = await db.query(`INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio A (test)', 1)`, [TENANT_ID]);
  conventionAId = convA.insertId;
  const [convB] = await db.query(`INSERT INTO labor_conventions (tenant_id, name, active) VALUES (?, 'Convenio B (test)', 1)`, [TENANT_ID]);
  conventionBId = convB.insertId;

  const [empSinConvenio] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (999967001, 'Sin Convenio (test)', ?, 0)`, [TENANT_ID]);
  employeeWithoutConventionId = empSinConvenio.insertId;

  const [empConConvenio] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (999967002, 'Con Convenio (test)', ?, 0)`, [TENANT_ID]);
  employeeWithConventionId = empConConvenio.insertId;
  await db.query(
    `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', NULL)`,
    [employeeWithConventionId, TENANT_ID, conventionAId]
  );

  const [empCambio] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (999967003, 'Cambio De Convenio (test)', ?, 0)`, [TENANT_ID]);
  employeeWithChangeId = empCambio.insertId;
  await db.query(
    `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-01-01', '2026-06-30')`,
    [employeeWithChangeId, TENANT_ID, conventionAId]
  );
  await db.query(
    `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from, valid_to) VALUES (?, ?, ?, '2026-07-01', NULL)`,
    [employeeWithChangeId, TENANT_ID, conventionBId]
  );

  // Etapa 13 ("cambio de categoria: 01/07"): MISMO convenio, category_id
  // distinto antes/despues del corte -- category_id ya viaja en la fila
  // (columna reservada desde la Etapa 9, sin tabla ni logica de tasas
  // propia todavia), asi que el mismo mecanismo de vigencia alcanza para
  // resolver "que categoria tenia este empleado en tal fecha" sin cambios.
  const [empCambioCategoria] = await db.query(
    `INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report) VALUES (999967004, 'Cambio De Categoria (test)', ?, 0)`, [TENANT_ID]);
  employeeWithCategoryChangeId = empCambioCategoria.insertId;
  await db.query(
    `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, category_id, valid_from, valid_to) VALUES (?, ?, ?, 1, '2026-01-01', '2026-06-30')`,
    [employeeWithCategoryChangeId, TENANT_ID, conventionAId]
  );
  await db.query(
    `INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, category_id, valid_from, valid_to) VALUES (?, ?, ?, 2, '2026-07-01', NULL)`,
    [employeeWithCategoryChangeId, TENANT_ID, conventionAId]
  );
});

after(async () => {
  await db.query('DELETE FROM employee_convention_assignments WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM labor_conventions WHERE tenant_id = ?', [TENANT_ID]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
});

test('empleado sin ninguna asignacion -> null (sigue usando su plantilla directamente, opt-in)', async () => {
  const result = await findActiveAssignment(employeeWithoutConventionId, '2026-06-15', db);
  assert.equal(result, null);
});

test('empleado con una asignacion vigente sin fecha de fin -> la devuelve para cualquier fecha posterior a valid_from', async () => {
  const result = await findActiveAssignment(employeeWithConventionId, '2026-08-01', db);
  assert.ok(result);
  assert.equal(result.convention_id, conventionAId);
});

test('empleado con CAMBIO de convenio a mitad de año: el calculo historico usa el convenio vigente en la fecha pedida, no el actual', async () => {
  const inJune = await findActiveAssignment(employeeWithChangeId, '2026-06-15', db);
  assert.equal(inJune.convention_id, conventionAId, 'junio debe resolver al convenio A (vigente en esa fecha)');

  const inJuly = await findActiveAssignment(employeeWithChangeId, '2026-07-15', db);
  assert.equal(inJuly.convention_id, conventionBId, 'julio debe resolver al convenio B (vigente en esa fecha)');

  const beforeAnyAssignment = await findActiveAssignment(employeeWithChangeId, '2025-12-31', db);
  assert.equal(beforeAnyAssignment, null, 'antes de cualquier asignacion, no hay convenio aplicable');
});

test('cambio de categoria a mitad de año (mismo convenio): el calculo historico usa la categoria vigente en la fecha pedida', async () => {
  const inJune = await findActiveAssignment(employeeWithCategoryChangeId, '2026-06-15', db);
  assert.equal(inJune.category_id, 1);

  const inJuly = await findActiveAssignment(employeeWithCategoryChangeId, '2026-07-15', db);
  assert.equal(inJuly.category_id, 2);
});

test('findActiveAssignmentsForEmployees resuelve varios empleados de una sola consulta', async () => {
  const map = await findActiveAssignmentsForEmployees(
    [employeeWithoutConventionId, employeeWithConventionId, employeeWithChangeId],
    '2026-08-01',
    db
  );
  assert.equal(map.has(employeeWithoutConventionId), false);
  assert.equal(map.get(employeeWithConventionId).convention_id, conventionAId);
  assert.equal(map.get(employeeWithChangeId).convention_id, conventionBId);
});
