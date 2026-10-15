// E2 (2026-10-15): justificar una salida particular con un motivo. Pedido del
// dueño: donde se presenta certificado (médico, donar sangre...), esas horas
// NO se descuentan y aparecen justificadas; en otras empresas sí. Lo decide
// cada MOTIVO ("consume la bolsa"). Requiere el backend local y la migración 20261020.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { darHorarioDeEmpresa, quitarHorarioDeEmpresa } = require('../test-helpers/horarioDeEmpresa');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999977;
const B = 999978;
const UID_A = 'test-justif-salidas-a';
const UID_B = 'test-justif-salidas-b';
const LEGAJO = 977001;
const USERID = 9977001;
const M_SALIDA = 9977002;
const M_REGRESO = 9977003;
const LUNES = '2026-05-11';   // sale 10:00, vuelve 11:00 (60 min)
const VIERNES = '2026-05-15'; // entra tarde 09:00 con el marcador de permiso
let hA; let hB; let medico; let tramite; let motivoDeB;

const pedir = (h, m, url, body) => fetch(BASE_URL + url, { method: m, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const salidas = async () => (await pedir(hA, 'GET', '/movements-range?from=2026-05-01&to=2026-05-31&category=PARTICULAR&groupBy=month')).json();
const filaDe = (r, fecha) => r.rows.find((x) => x.date === fecha && String(x.employeeId) === String(LEGAJO));
const resumen = (r) => r.summary.find((s) => String(s.employeeId) === String(LEGAJO));
const detalle = async () => (await (await pedir(hA, 'GET', `/attendance-range?from=2026-05-01&to=2026-05-31&employeeId=${LEGAJO}`)).json()).data[0];
const diaria = async (f) => (await (await pedir(hA, 'GET', `/api/labor-engine/attendance/${f}`)).json()).attendance.find((a) => String(a.employeeId) === String(LEGAJO));
const item = (fila) => ({ legajo: String(LEGAJO), fecha: fila.date, tipo: fila.autorizacion.tipo, hora: fila.autorizacion.hora });

before(async () => {
  for (const [id, code] of [[A, 'justif-salidas-a'], [B, 'justif-salidas-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  hA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: A });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: B });
  await darHorarioDeEmpresa(db, A);
  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, activo, exclude_from_report) VALUES (?, 'Certificado Test', ?, '2020-01-01', 1, 0)`, [LEGAJO, A]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID, A, String(LEGAJO), 'Certificado Test']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID, A, emp.insertId, 'test']);
  await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, '5', 'Marcador Salida'), (?, ?, '6', 'Marcador Regreso')`, [M_SALIDA, A, M_REGRESO, A]);
  await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES
    (?, ?, '5', 'Marcador Salida', 'PARTICULAR', 'SALIDA', 1), (?, ?, '6', 'Marcador Regreso', 'PARTICULAR', 'REGRESO', 1)`, [M_SALIDA, A, M_REGRESO, A]);
  const fichar = (uid, cuando) => db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [uid, A, cuando]);
  await fichar(USERID, `${LUNES} 06:58:00`);
  await fichar(M_SALIDA, `${LUNES} 09:59:55`); await fichar(USERID, `${LUNES} 10:00:00`);
  await fichar(M_REGRESO, `${LUNES} 10:59:55`); await fichar(USERID, `${LUNES} 11:00:00`);
  await fichar(USERID, `${LUNES} 13:41:00`);
  await fichar(M_REGRESO, `${VIERNES} 08:59:55`); await fichar(USERID, `${VIERNES} 09:00:00`);
  await fichar(USERID, `${VIERNES} 13:41:00`);
  // Motivos: uno que NO consume la bolsa (con certificado) y uno que sí.
  const crear = async (h, code, desc, extra) => (await (await pedir(h, 'POST', '/api/event-types', { code, descripcion: desc, ...extra })).json()).id;
  medico = await crear(hA, 'MEDICO_CERT_T', 'Médico con certificado (test)', { consume_bolsa_particular: false, pide_comprobante: true });
  tramite = await crear(hA, 'TRAMITE_T', 'Trámite personal (test)', {});
  motivoDeB = await crear(hB, 'OTRO_T', 'Motivo de otra empresa (test)', {});
  // Tope de salidas particulares: 150 minutos por mes. En mayo suman 180: los
  // 60 de la salida del lunes + 120 de la entrada con permiso del viernes
  // (de 07:00, su hora de entrada, a 09:00).
  await pedir(hA, 'POST', '/config/particular-exit-limit', { particularExitMonthlyLimitMinutes: 150 });
});

after(async () => {
  await db.query('DELETE FROM salidas_justificaciones WHERE tenant_id IN (?, ?)', [A, B]).catch(() => {});
  await db.query('DELETE FROM salidas_autorizaciones WHERE tenant_id IN (?, ?)', [A, B]).catch(() => {});
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [A, B]);
  await db.query('DELETE FROM event_types WHERE tenant_id IN (?, ?)', [A, B]);
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [A]);
  await quitarHorarioDeEmpresa(db, A);
  for (const uid of [UID_A, UID_B]) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('los motivos guardan "consume la bolsa" y "pide comprobante" (por defecto: consume, no pide)', async () => {
  const lista = (await (await pedir(hA, 'GET', '/api/event-types')).json()).eventTypes;
  const m = lista.find((x) => x.id === medico);
  const t = lista.find((x) => x.id === tramite);
  assert.deepEqual([m.consume_bolsa_particular, m.pide_comprobante], [0, 1]);
  assert.deepEqual([t.consume_bolsa_particular, t.pide_comprobante], [1, 0], 'por defecto: como siempre');
});

test('sin justificar: 180 min superan el tope de 150', async () => {
  const r = await salidas();
  assert.equal(filaDe(r, LUNES).justificacion, undefined);
  assert.equal(resumen(r).totalMinutes, 180);
  assert.equal(resumen(r).overLimit, true);
});

test('justificada con "Médico con certificado": aparece justificada y NO cuenta para el tope', async () => {
  const lunes = filaDe(await salidas(), LUNES);
  const j = await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(lunes)], eventTypeId: medico, nota: 'Certificado entregado' });
  assert.equal(j.status, 200, await j.clone().text());
  const r = await salidas();
  const f = filaDe(r, LUNES);
  assert.equal(f.justificacion.motivo, 'Médico con certificado (test)');
  assert.equal(f.justificacion.consume, false);
  assert.equal(f.justificacion.pideComprobante, true);
  assert.equal(f.justificacion.por, `${UID_A}@test.local`);
  assert.equal(resumen(r).minutosJustificadosSinConsumir, 60);
  assert.equal(resumen(r).totalMinutes, 180, 'el total se sigue mostrando');
  assert.equal(resumen(r).overLimit, false, 'pero los 60 justificados no cuentan: 120 <= 150');
});

test('justificada con un motivo que SÍ consume: vuelve a contar', async () => {
  const lunes = filaDe(await salidas(), LUNES);
  await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(lunes)], eventTypeId: tramite });
  const r = await salidas();
  assert.equal(filaDe(r, LUNES).justificacion.consume, true);
  assert.equal(resumen(r).overLimit, true);
});

test('la entrada tarde con permiso justificada es tardanza justificada con ese motivo (detalle y vista diaria)', async () => {
  const viernes = filaDe(await salidas(), VIERNES);
  assert.equal((await detalle()).days.find((d) => d.date === VIERNES).status, 'Late', 'antes: Tarde');
  await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(viernes)], eventTypeId: medico });
  const fila = await detalle();
  const dia = fila.days.find((d) => d.date === VIERNES);
  assert.equal(dia.status, 'LateJustified');
  assert.equal(dia.eventTypeDescripcion, 'Médico con certificado (test)');
  assert.equal(Number(fila.personalLeaveHours), 0, 'con certificado no se descuenta de la licencia personal');
  assert.equal((await diaria(VIERNES)).status, 'LateJustified', 'la vista diaria dice lo mismo');
  // Con un motivo que consume, el tiempo SÍ se descuenta.
  await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(viernes)], eventTypeId: tramite });
  assert.equal(Number((await detalle()).personalLeaveHours) > 0, true);
});

test('quitar la justificación: vuelve a como estaba', async () => {
  const viernes = filaDe(await salidas(), VIERNES);
  assert.equal((await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(viernes)], eventTypeId: null })).status, 200);
  assert.equal(filaDe(await salidas(), VIERNES).justificacion, undefined);
  assert.equal((await detalle()).days.find((d) => d.date === VIERNES).status, 'Late');
});

test('si la empresa exige autorización, justificar también la deja autorizada', async () => {
  await pedir(hA, 'PUT', '/config/salidas-autorizacion', { requiere: true });
  const viernes = filaDe(await salidas(), VIERNES);
  assert.equal(viernes.autorizacion.estado, 'pendiente');
  await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(viernes)], eventTypeId: medico, nota: 'turno' });
  const a = filaDe(await salidas(), VIERNES).autorizacion;
  assert.equal(a.estado, 'autorizada');
  assert.match(a.nota, /Justificada: Médico con certificado \(test\) · turno/);
});

test('no se puede usar un motivo de otra empresa, ni tocar salidas de otra empresa', async () => {
  const lunes = filaDe(await salidas(), LUNES);
  assert.equal((await pedir(hA, 'POST', '/salidas/justificaciones', { items: [item(lunes)], eventTypeId: motivoDeB })).status, 404);
  assert.equal((await pedir(hB, 'POST', '/salidas/justificaciones', { items: [item(lunes)], eventTypeId: motivoDeB })).status, 404);
});
