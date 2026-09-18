// Etapa 14 del plan "Motor de reglas de asistencia configurable" --
// corrige el HALLAZGO #3 de la auditoria. Requiere DB real (mismo patron
// que scheduleRepository/conventionAssignmentRepository), NO requiere el
// backend levantado.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { findForTemplates, archiveCurrentConfigIfChanged } = require('../motor-laboral/repositories/templateConfigHistoryRepository');

const TENANT_ID = 999966;

let db;
let templateId;

before(async () => {
  // dateStrings:true -- mismo criterio que el pool compartido db.js (que
  // es el que de verdad usan admin.js/horasdedica.js en produccion): sin
  // esto, las columnas DATE vuelven como objetos Date de JS en vez de
  // 'YYYY-MM-DD', y la comparacion de string que usa el resolver
  // (resolveHistoricalToleranceFields) no aplica.
  db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    dateStrings: true
  });

  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Historial Config (test)', 'tenant-historial-config-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );

  const [tpl] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, tolerancia_entrada_minutos, created_at)
     VALUES (?, 'Plantilla Historial (test)', 'FIXED', 1, 0, 10, '2026-01-01 00:00:00')`,
    [TENANT_ID]
  );
  templateId = tpl.insertId;
});

after(async () => {
  await db.query('DELETE FROM work_schedule_template_config_history WHERE template_id = ?', [templateId]);
  await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [templateId]);
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await db.end();
});

test('sin cambios (mismos valores): no archiva nada', async () => {
  const [[current]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [templateId]);
  await archiveCurrentConfigIfChanged(current, { tolerancia_entrada_minutos: 10, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null }, '2026-07-01', db);
  const rows = await findForTemplates([templateId], db);
  assert.equal(rows.length, 0);
});

test('cambio real de tolerancia: archiva el estado ANTERIOR con valid_to = el dia antes del cambio, valid_from = fecha de creacion (primer cambio)', async () => {
  const [[current]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [templateId]);
  await archiveCurrentConfigIfChanged(current, { tolerancia_entrada_minutos: 20, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null }, '2026-07-01', db);

  const rows = await findForTemplates([templateId], db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tolerancia_entrada_minutos, 10, 'archiva el valor VIEJO (10), no el nuevo');
  assert.equal(rows[0].valid_from, '2026-01-01', 'arranca en la fecha de creacion -- es el primer cambio');
  assert.equal(rows[0].valid_to, '2026-06-30', 'el dia antes de que el cambio (01/07) entre en vigencia');
});

test('SEGUNDO cambio: el nuevo snapshot arranca justo donde termino el anterior (sin huecos ni superposicion)', async () => {
  // Simula que la plantilla ya quedo en 20 desde el 01/07 (test anterior);
  // ahora se actualiza a mano para reflejar eso y se hace un SEGUNDO cambio.
  await db.query('UPDATE work_schedule_templates SET tolerancia_entrada_minutos = 20 WHERE id = ?', [templateId]);
  const [[current]] = await db.query('SELECT * FROM work_schedule_templates WHERE id = ?', [templateId]);
  await archiveCurrentConfigIfChanged(current, { tolerancia_entrada_minutos: 30, tolerancia_salida_anticipada_minutos: null, politica_llegada_anticipada: null, politica_salida_posterior: null }, '2026-10-01', db);

  const rows = (await findForTemplates([templateId], db)).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].tolerancia_entrada_minutos, 20);
  assert.equal(rows[1].valid_from, '2026-07-01', 'arranca justo el dia siguiente a donde termino el snapshot anterior');
  assert.equal(rows[1].valid_to, '2026-09-30');
});
