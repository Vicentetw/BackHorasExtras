// Justificaciones visibles (quién, editar, quitar) y límites de llegadas
// tarde y salidas en un solo lugar (2026-10-15). Pedido del dueño probando
// la Empresa Demo: no encontraba dónde se configuraba el límite (había dos
// lugares), no podía quitar una justificación y el PDF no decía quién la
// cargó. Requiere el backend local (puerto 3000).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { darHorarioDeEmpresa, quitarHorarioDeEmpresa } = require('../test-helpers/horarioDeEmpresa');
const limites = require('../motor-laboral/services/limitesAsistencia');
const { diaParaElEmpleado, resumenParaElEmpleado } = require('../routes/miPortal');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const A = 999971;
const B = 999972;
const UID_A = 'test-justif-limites-a';
const UID_B = 'test-justif-limites-b';
const UID_LECTOR = 'test-justif-limites-lector';
const USERID = 8897101;
const LEGAJO = 971001;
let hA; let hB; let hLector; let eventTypeId; let justifId;

const pedir = (h, m, url, body) => fetch(BASE_URL + url, { method: m, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const detalle = async () => {
  const r = await pedir(hA, 'GET', `/attendance-range?from=2026-01-01&to=2026-01-31&employeeId=${LEGAJO}`);
  assert.equal(r.status, 200);
  const fila = (await r.json()).data.find((x) => String(x.employeeId) === String(LEGAJO));
  assert.ok(fila, 'la persona tiene que aparecer en el detalle');
  return fila;
};
const dia = (fila, fecha) => fila.days.find((d) => d.date === fecha);

before(async () => {
  for (const [id, code] of [[A, 'justif-limites-a'], [B, 'justif-limites-b']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, `${code} (test)`, code]);
  }
  hA = await getTestAuthHeaders(UID_A, { isSuperadmin: false, tenantId: A });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: B });
  hLector = await getTestAuthHeaders(UID_LECTOR, { isSuperadmin: false, tenantId: A, permissions: ['schedules:read', 'attendance:read'] });
  await darHorarioDeEmpresa(db, A); // 07:00-13:40 de lunes a viernes
  const [emp] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, activo) VALUES (?, 'BENÍTEZ (test)', ?, '2020-01-01', 1)`, [LEGAJO, A]);
  await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [USERID, A, String(LEGAJO), 'BENITEZ TEST']);
  await db.query('INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, ?)', [USERID, A, emp.insertId, 'manual']);
  // Lun 05: 08:46 (se justifica). Mar 06 y Mié 07: tarde sin justificar.
  const marcas = [['2026-01-05', '08:46:00'], ['2026-01-06', '07:40:00'], ['2026-01-07', '07:50:00']];
  for (const [f, h] of marcas) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, NULL), (?, ?, ?, NULL)',
      [USERID, A, `${f} ${h}`, USERID, A, `${f} 13:40:00`]);
  }
  const [et] = await db.query(`INSERT INTO event_types (tenant_id, code, descripcion, active) VALUES (?, 'SAL_PART_TEST', 'Salida particular (test)', 1)`, [A]);
  eventTypeId = et.insertId;
});

after(async () => {
  await db.query('DELETE FROM user_exclusion_log WHERE tenant_id = ?', [A]).catch(() => {});
  await db.query('DELETE FROM userexclusions WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM event_types WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM Checkins WHERE USERID = ?', [USERID]);
  await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [USERID]);
  await db.query('DELETE FROM users WHERE USERID = ?', [USERID]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [A]);
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [A, B]);
  await quitarHorarioDeEmpresa(db, A);
  for (const uid of [UID_A, UID_B, UID_LECTOR]) await deleteTestUser(uid);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [A, B]);
  await closeDb();
});

test('evaluar: cantidad y tiempo, cada uno opcional, multiplicado por meses', () => {
  const sin = limites.evaluar({ cantidad: 5, minutos: 500 }, { cantidad: 0, minutos: 0 });
  assert.equal(sin.excedido, false, 'sin límite nunca se excede');
  const cant = limites.evaluar({ cantidad: 3, minutos: 10 }, { cantidad: 2, minutos: 0 });
  assert.deepEqual([cant.excedidoCantidad, cant.excedidoMinutos, cant.excedido], [true, false, true]);
  const dosMeses = limites.evaluar({ cantidad: 3, minutos: 100 }, { cantidad: 2, minutos: 60 }, 2);
  assert.deepEqual([dosMeses.maxCantidad, dosMeses.maxMinutos, dosMeses.excedido], [4, 120, false]);
  assert.equal(limites.mesesDelRango('2026-10-01', '2026-10-31'), 1);
  assert.equal(limites.mesesDelRango('2026-10-15', '2026-11-02'), 2);
  assert.equal(limites.mesesDelRango('2025-12-01', '2026-01-31'), 2);
});

test('un solo lugar: guardar los tres límites, y los endpoints viejos ven lo mismo', async () => {
  const vacio = await (await pedir(hA, 'GET', '/config/limites-asistencia')).json();
  assert.deepEqual(vacio.limites.tardanzas, { cantidad: 0, minutos: 0 });
  const r = await pedir(hA, 'PUT', '/config/limites-asistencia', { limites: {
    tardanzas: { cantidad: 1, minutos: 30 },
    tardanzasJustificadas: { minutos: 60 },
    salidasParticulares: { cantidad: 2, minutos: 240 },
  } });
  assert.equal(r.status, 200);
  const g = (await r.json()).limites;
  assert.deepEqual(g, { tardanzas: { cantidad: 1, minutos: 30 }, tardanzasJustificadas: { cantidad: 0, minutos: 60 }, salidasParticulares: { cantidad: 2, minutos: 240 } });
  // Compatibilidad: las mismas claves de antes.
  assert.equal((await (await pedir(hA, 'GET', '/config/personal-leave-limit')).json()).personalLeaveMonthlyLimitMinutes, 60);
  assert.equal((await (await pedir(hA, 'GET', '/config/particular-exit-limit')).json()).particularExitMonthlyLimitMinutes, 240);
});

test('límites: valores inválidos, permisos y aislamiento entre empresas', async () => {
  assert.equal((await pedir(hA, 'PUT', '/config/limites-asistencia', { limites: { tardanzas: { cantidad: -1 } } })).status, 400);
  assert.equal((await pedir(hA, 'PUT', '/config/limites-asistencia', { limites: { tardanzas: { cantidad: 1.5 } } })).status, 400);
  assert.equal((await pedir(hA, 'PUT', '/config/limites-asistencia', { limites: { otraCosa: { cantidad: 1 } } })).status, 400);
  assert.equal((await pedir(hLector, 'PUT', '/config/limites-asistencia', { limites: { tardanzas: { cantidad: 9 } } })).status, 403);
  assert.equal((await pedir(hLector, 'GET', '/config/limites-asistencia')).status, 200, 'quien solo lee puede verlos');
  const deB = (await (await pedir(hB, 'GET', '/config/limites-asistencia')).json()).limites;
  assert.deepEqual(deB.tardanzas, { cantidad: 0, minutos: 0 }, 'la otra empresa no ve los límites de A');
});

test('el detalle muestra la justificación con quién la cargó, y los límites', async () => {
  const c = await pedir(hA, 'POST', '/config/user-exclusions', { userId: USERID, excDate: '2026-01-05', type: 'HALF_DAY', excTo: '08:46:00', eventTypeId, reason: 'Trámite' });
  assert.equal(c.status, 200, await c.clone().text());
  assert.equal((await c.json()).message, 'Justificación cargada', 'el mensaje habla de justificación, no de "exclusión"');
  const fila = await detalle();
  const lunes = dia(fila, '2026-01-05');
  assert.equal(lunes.status, 'LateJustified');
  assert.ok(lunes.justificacion, 'el día tiene que traer su justificación');
  justifId = lunes.justificacion.id;
  assert.equal(lunes.justificacion.motivo, 'Salida particular (test)');
  assert.equal(lunes.justificacion.hasta, '08:46');
  assert.equal(lunes.justificacion.razon, 'Trámite');
  assert.equal(lunes.justificacion.cargadaPor, `${UID_A}@test.local`);
  assert.ok(lunes.justificacion.cargadaEl);
  assert.equal(lunes.justificacion.modificadaPor, null);
  assert.equal(dia(fila, '2026-01-06').justificacion, undefined, 'un día sin justificación no trae nada');
  // Límites: 2 tardanzas sin justificar (límite 1) y 1 justificada.
  assert.equal(fila.limites.tardanzas.cantidad, 2);
  assert.equal(fila.limites.tardanzas.maxCantidad, 1);
  assert.equal(fila.limites.tardanzas.excedido, true);
  assert.equal(fila.limites.tardanzas.minutos > 0, true);
  assert.equal(fila.limites.tardanzasJustificadas.cantidad, 1);
  assert.equal(fila.limites.tardanzasJustificadas.maxMinutos, 60);
  // Lo de antes sigue igual (compatibilidad).
  assert.equal(fila.personalLeaveLimitHours, '1.00');
});

test('la tabla de toda la empresa NO trae el detalle de justificaciones', async () => {
  const r = await (await pedir(hA, 'GET', '/attendance-range?from=2026-01-01&to=2026-01-31')).json();
  const fila = r.data.find((x) => String(x.employeeId) === String(LEGAJO));
  assert.ok(fila);
  assert.equal(fila.days, undefined);
  assert.ok(fila.limites, 'los límites sí, para poder marcar en rojo');
});

test('Editar abre la justificación por su número, solo dentro de la empresa', async () => {
  const deA = await (await pedir(hA, 'GET', `/config/user-exclusions?id=${justifId}`)).json();
  assert.equal(deA.data.length, 1);
  assert.equal(deA.data[0].id, justifId);
  const deB = await (await pedir(hB, 'GET', `/config/user-exclusions?id=${justifId}`)).json();
  assert.equal(deB.data.length, 0, 'otra empresa no la ve');
  const m = await pedir(hA, 'PUT', `/config/user-exclusions/${justifId}`, { type: 'HALF_DAY', eventTypeId, excTo: '08:50:00', reason: 'Trámite (corregido)' });
  assert.equal(m.status, 200);
  const lunes = dia(await detalle(), '2026-01-05');
  assert.equal(lunes.justificacion.modificadaPor, `${UID_A}@test.local`);
  assert.equal(lunes.justificacion.hasta, '08:50');
});

test('el portal muestra que está justificado, pero NO quién lo cargó ni la nota', async () => {
  const lunes = dia(await detalle(), '2026-01-05');
  const enPortal = diaParaElEmpleado(lunes);
  assert.deepEqual(Object.keys(enPortal.justificacion).sort(), ['desde', 'diaCompleto', 'hasta', 'motivo']);
  assert.equal(enPortal.justificacion.motivo, 'Salida particular (test)');
  assert.ok(!JSON.stringify(enPortal).includes('@test.local'), 'ningún email en lo que ve el empleado');
  assert.ok(!JSON.stringify(enPortal).includes('Trámite'), 'ni la nota interna');
  const resumen = resumenParaElEmpleado(await detalle());
  assert.ok(resumen.limites.tardanzas, 'el resumen trae los límites con su nombre correcto');
});

test('Quitar: el día vuelve a "Tarde" y la justificación desaparece', async () => {
  assert.equal((await pedir(hA, 'DELETE', `/config/user-exclusions/${justifId}`)).status, 200);
  const lunes = dia(await detalle(), '2026-01-05');
  assert.equal(lunes.status, 'Late');
  assert.equal(lunes.justificacion, undefined);
});

test('la guía de Inicio sabe que los límites ya se configuraron', async () => {
  const r = await (await pedir(hA, 'GET', '/api/puesta-en-marcha')).json();
  assert.equal(r.pasos.limites.configurados, true);
  assert.equal(r.pasos.limites.hecho, true);
  const rB = await (await pedir(hB, 'GET', '/api/puesta-en-marcha')).json();
  assert.equal(rB.pasos.limites.hecho, false, 'otra empresa todavía no');
  assert.equal((await pedir(hB, 'PUT', '/api/puesta-en-marcha/manual', { paso: 'limites', hecho: true })).status, 200);
  assert.equal((await (await pedir(hB, 'GET', '/api/puesta-en-marcha')).json()).pasos.limites.hecho, true, '"No uso límites" también cuenta');
});
