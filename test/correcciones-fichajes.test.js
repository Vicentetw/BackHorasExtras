// /api/correcciones-fichajes (etapa G): el camino completo contra el backend
// local. Diseño: CORRECCIONES_FICHAJES.md. Los casos finos de la
// transformación están en correcciones-fichajes-transformacion.test.js.
//
// Requiere el backend local (puerto 3000) y la migración
// 20261027_correcciones_fichajes en la base local. Empresas descartables
// propias (999941/999942), NUNCA AVP. Datos inventados.
//
// EL DÍA DE PRUEBA (2026-02-10)
//   Reloj .30 -- S (como Santi 01/10):
//     06:54:59 llega · 6 12:04:02 · 12:04:08 · 5 12:05:06 · 12:05:12
//     5 12:09:22 · 12:09:28 · 5 15:06:08 · 15:06:14 · 16:00:00
//   Reloj .33 -- A y B (como 2544 y 2446 el 13/10, el caso en que omitir la
//   llegada de A le cambia el resultado a B):
//     B 07:04:33 · A 11:24:23 · A 13:41:18 · 9 13:41:24 · A 13:41:28
//     B 13:41:37 · 9 13:41:45 · B 13:41:52 · 10 15:30:46 · A 15:30:49
//     10 16:50:09 · B 16:50:17
//   C (2026-02-11): un fichaje sin reloj identificado.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { setAppSetting } = require('../motor-laboral/repositories/appSettingsRepository');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TA = 999941;
const TB = 999942;
const UID_ADMIN = 'test-correcciones-admin';
const UID_SIN = 'test-correcciones-sin-permiso';
const UID_B = 'test-correcciones-otra-empresa';
const DIA = '2026-02-10';
const L = { S: 901001, A: 901002, B: 901003, C: 901004 };
const U = { S: 8891001, A: 8891002, B: 8891003, C: 8891004 };
const MARC = { 6: ['PARTICULAR', 'SALIDA'], 5: ['PARTICULAR', 'REGRESO'], 9: ['HE', 'SALIDA'], 10: ['HE', 'REGRESO'] };

let hAdmin, hSin, hB;

async function limpiar() {
  await db.query('DELETE FROM fichajes_correcciones WHERE tenant_id IN (?, ?)', [TA, TB]);
  await db.query('DELETE FROM marker_correction_log WHERE tenant_id IN (?, ?)', [TA, TB]).catch(() => {});
  await db.query('DELETE FROM marker_corrections WHERE tenant_id IN (?, ?)', [TA, TB]);
  await db.query('DELETE FROM overtime_period_closings WHERE tenant_id IN (?, ?)', [TA, TB]).catch(() => {});
  for (const t of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id IN (?, ?)`, [TA, TB]);
  }
}
const fichar = (userId, hora, ip, dia = DIA) =>
  db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?)', [userId, TA, `${dia} ${hora}`, ip]);
async function idDe(userId, hora, dia = DIA) {
  const [[r]] = await db.query('SELECT id FROM Checkins WHERE tenant_id = ? AND USERID = ? AND CHECKTIME = ?', [TA, userId, `${dia} ${hora}`]);
  return r.id;
}
const get = async (h, url) => { const r = await fetch(BASE + url, { headers: h }); return { status: r.status, body: await r.json() }; };
const post = async (h, url, body) => {
  const r = await fetch(BASE + url, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const vistaPrevia = (checkinId, accion, marcadorUserId) =>
  get(hAdmin, `/api/correcciones-fichajes/vista-previa?checkinId=${checkinId}&accion=${accion}${marcadorUserId ? `&marcadorUserId=${marcadorUserId}` : ''}`);
async function corregir(checkinId, accion, extra = {}) {
  const vp = await vistaPrevia(checkinId, accion, extra.marcadorUserId);
  assert.equal(vp.status, 200, JSON.stringify(vp.body));
  return post(hAdmin, '/api/correcciones-fichajes', { checkinId, accion, motivo: 'Prueba de corrección', comprobante: vp.body.comprobante, ...extra });
}
async function salidas(legajo) {
  const r = await get(hAdmin, `/movements-range?from=${DIA}&to=${DIA}&category=PARTICULAR`);
  assert.equal(r.status, 200);
  return r.body.rows.filter((x) => String(x.employeeId) === String(legajo)).map((x) => `${x.timeOut.slice(11)}→${x.timeIn.slice(11)}`);
}
async function controlDeCheckins() {
  const [[r]] = await db.query(
    'SELECT COUNT(*) AS n, SUM(id) AS s, SUM(USERID) AS u, MAX(CHECKTIME) AS m, GROUP_CONCAT(MACHINE_IP ORDER BY id) AS ips FROM Checkins WHERE tenant_id = ?', [TA]);
  return JSON.stringify(r);
}

before(async () => {
  const [[t]] = await db.query("SHOW TABLES LIKE 'fichajes_correcciones'").then(([x]) => [x]);
  if (!t) throw new Error('Falta correr la migración 20261027_correcciones_fichajes en la base local');
  for (const [id, n] of [[TA, 'Correcciones A (test)'], [TB, 'Correcciones B (test)']]) {
    await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [id, n, `correcciones-${id}-test`]);
  }
  hAdmin = await getTestAuthHeaders(UID_ADMIN, { isSuperadmin: false, tenantId: TA,
    permissions: ['attendance:read', 'attendance:update', 'employees:read', 'fichajes:read', 'fichajes:update'] });
  hSin = await getTestAuthHeaders(UID_SIN, { isSuperadmin: false, tenantId: TA, permissions: ['attendance:read', 'attendance:update'] });
  hB = await getTestAuthHeaders(UID_B, { isSuperadmin: false, tenantId: TB, permissions: ['attendance:read', 'fichajes:read', 'fichajes:update'] });
  await limpiar();
  for (const k of Object.keys(L)) {
    const [e] = await db.query(
      "INSERT INTO employees (employee_id, nombre, tenant_id, fecha_alta, exclude_from_report, activo) VALUES (?, ?, ?, '2020-01-01', 0, 1)", [L[k], `Persona ${k}`, TA]);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [U[k], TA, String(L[k]), `Persona ${k}`]);
    await db.query("INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')", [U[k], TA, e.insertId]);
  }
  for (const [n, [cat, dir]] of Object.entries(MARC)) {
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [Number(n), TA, n, `Marcador ${n}`]);
    await db.query('INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [Number(n), TA, n, `Marcador ${n}`, cat, dir]);
  }
  for (const [u, h] of [[U.S, '06:54:59'], [6, '12:04:02'], [U.S, '12:04:08'], [5, '12:05:06'], [U.S, '12:05:12'], [5, '12:09:22'],
    [U.S, '12:09:28'], [5, '15:06:08'], [U.S, '15:06:14'], [U.S, '16:00:00']]) await fichar(u, h, '.30');
  for (const [u, h] of [[U.B, '07:04:33'], [U.A, '11:24:23'], [U.A, '13:41:18'], [9, '13:41:24'], [U.A, '13:41:28'], [U.B, '13:41:37'],
    [9, '13:41:45'], [U.B, '13:41:52'], [10, '15:30:46'], [U.A, '15:30:49'], [10, '16:50:09'], [U.B, '16:50:17']]) await fichar(u, h, '.33');
  await fichar(U.C, '10:00:00', null, '2026-02-11');
  // Ventanas de la empresa como las de AVP (las del caso real).
  for (const [k, v] of [['markerMaxGapSeconds', '25'], ['markerBounceSeconds', '20']]) {
    await setAppSetting(k, TA, v, db);
  }
});

after(async () => {
  await limpiar();
  await db.query('DELETE FROM app_settings WHERE tenant_id IN (?, ?)', [TA, TB]);
  for (const u of [UID_ADMIN, UID_SIN, UID_B]) await deleteTestUser(u);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [TA, TB]);
  await closeDb();
});

let salidasOriginalesS;
let control;

test('sin permiso "Fichajes": 403 en todo', async () => {
  salidasOriginalesS = await salidas(L.S);
  control = await controlDeCheckins();
  assert.deepEqual(salidasOriginalesS, ['12:04:08→12:05:12']);
  const id = await idDe(U.S, '12:05:12');
  assert.equal((await get(hSin, '/api/correcciones-fichajes')).status, 403);
  assert.equal((await get(hSin, `/api/correcciones-fichajes/vista-previa?checkinId=${id}&accion=OMITIR`)).status, 403);
  assert.equal((await post(hSin, '/api/correcciones-fichajes', { checkinId: id, accion: 'OMITIR', motivo: 'x' })).status, 403);
});

test('sin vista previa (o con un comprobante inventado) no se puede confirmar', async () => {
  const id = await idDe(U.S, '12:05:12');
  const r1 = await post(hAdmin, '/api/correcciones-fichajes', { checkinId: id, accion: 'OMITIR', motivo: 'Prueba sin vista previa' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.codigo, 'SIN_VISTA_PREVIA');
  const r2 = await post(hAdmin, '/api/correcciones-fichajes', { checkinId: id, accion: 'OMITIR', motivo: 'Prueba inventada', comprobante: 'abc.def' });
  assert.equal(r2.body.codigo, 'SIN_VISTA_PREVIA');
});

test('el motivo es obligatorio', async () => {
  const id = await idDe(U.S, '12:05:12');
  const vp = await vistaPrevia(id, 'OMITIR');
  const r = await post(hAdmin, '/api/correcciones-fichajes', { checkinId: id, accion: 'OMITIR', motivo: '  ', comprobante: vp.body.comprobante });
  assert.equal(r.status, 400);
});

test('no se corrige un marcador ni un fichaje sin reloj identificado', async () => {
  const marcador = await vistaPrevia(await idDe(6, '12:04:02'), 'OMITIR');
  assert.equal(marcador.status, 400);
  assert.equal(marcador.body.codigo, 'NO_ES_DE_PERSONA');
  const sinReloj = await vistaPrevia(await idDe(U.C, '10:00:00', '2026-02-11'), 'OMITIR');
  assert.equal(sinReloj.status, 200);
  assert.match(sinReloj.body.bloqueos.join(' '), /reloj identificado/);
  assert.equal(sinReloj.body.comprobante, null, 'bloqueada: no hay comprobante para confirmar');
});

test('un comprobante viejo no sirve si el resultado cambió (otra corrección en el medio)', async () => {
  const id05 = await idDe(U.S, '12:05:12');
  const viejo = await vistaPrevia(id05, 'OMITIR');
  assert.equal(viejo.status, 200);
  // Otra corrección del mismo día cambia lo que haría omitir 12:05.
  assert.equal((await corregir(await idDe(U.S, '12:09:28'), 'OMITIR')).status, 201);
  const r = await post(hAdmin, '/api/correcciones-fichajes', { checkinId: id05, accion: 'OMITIR', motivo: 'Prueba comprobante viejo', comprobante: viejo.body.comprobante });
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'CAMBIO');
});

test('S (como Santi): omitir 12:05 y 12:09 deja la salida real 12:04 → 15:06, y nada se oculta', async () => {
  const r = await corregir(await idDe(U.S, '12:05:12'), 'OMITIR');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.vistaPrevia.afectaAOtros, false);
  assert.deepEqual(await salidas(L.S), ['12:04:08→15:06:14']);
  // Presentismo: el día dice qué fichajes están corregidos, con motivo y quién.
  const det = await get(hAdmin, `/attendance-range?from=${DIA}&to=${DIA}&employeeId=${L.S}`);
  const dia = det.body.data.find((x) => String(x.employeeId) === String(L.S)).days.find((d) => d.date === DIA);
  assert.deepEqual(dia.fichajesCorregidos.map((c) => `${c.hora} ${c.accion}`).sort(), ['12:05:12 OMITIR', '12:09:28 OMITIR']);
  assert.ok(!dia.checkins.includes('12:05:12'), 'para las horas, el omitido no cuenta');
  // Fichajes del día: el omitido se ve, marcado.
  const fd = await get(hAdmin, `/api/fichajes-del-dia?fecha=${DIA}&employeeId=${L.S}`);
  const omitidos = fd.body.empleados[String(L.S)].filter((x) => x.base === 'Omitido');
  assert.deepEqual(omitidos.map((x) => x.hora), ['12:05', '12:09']);
  assert.equal(omitidos[0].correccion.motivo, 'Prueba de corrección');
});

test('L2b: "Corregir marcador" ya no asigna un marcador a otra persona (solo lo anula)', async () => {
  const r = await post(hAdmin, '/marker-corrections', {
    markerUserId: 9, markerAt: `${DIA} 13:41:24`, fromEmployeeId: L.B, toEmployeeId: L.A, reason: 'Prueba L2b',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.codigo, 'SOLO_ANULAR');
});

test('omitir la llegada de A le cambia el resultado a B: se avisa y pide segunda confirmación', async () => {
  const id = await idDe(U.A, '11:24:23');
  const vp = await vistaPrevia(id, 'OMITIR');
  assert.equal(vp.status, 200, JSON.stringify(vp.body));
  assert.equal(vp.body.afectaAOtros, true);
  assert.deepEqual(vp.body.otrosAfectados.map((x) => x.legajo), [String(L.B)]);
  const deB = vp.body.cambios.find((c) => c.legajo === String(L.B));
  assert.ok(deB.movimientosDelDia.agregados.length, 'muestra qué le cambia a B ese día');
  const sin = await post(hAdmin, '/api/correcciones-fichajes', { checkinId: id, accion: 'OMITIR', motivo: 'Prueba otros', comprobante: vp.body.comprobante });
  assert.equal(sin.status, 409);
  assert.equal(sin.body.codigo, 'CONFIRMAR_OTROS');
  const con = await post(hAdmin, '/api/correcciones-fichajes', { checkinId: id, accion: 'OMITIR', motivo: 'Prueba otros', comprobante: vp.body.comprobante, confirmoOtros: true });
  assert.equal(con.status, 201);
  const [[fila]] = await db.query('SELECT afecta_a_otros FROM fichajes_correcciones WHERE id = ?', [con.body.id]);
  assert.equal(fila.afecta_a_otros, 1, 'queda guardado que se confirmó sabiendo');
});

test('una sola corrección activa por fichaje', async () => {
  const vp = await vistaPrevia(await idDe(U.S, '12:05:12'), 'QUITAR_MARCADOR');
  assert.equal(vp.status, 409);
  assert.equal(vp.body.codigo, 'YA_CORREGIDO');
});

test('cambiar el marcador: el elegido queda con ese fichaje; no si el marcador se apretó en el mismo segundo', async () => {
  const id = await idDe(U.S, '16:00:00');
  const vp = await vistaPrevia(id, 'CAMBIAR_MARCADOR', 6);
  assert.equal(vp.status, 200, JSON.stringify(vp.body));
  assert.deepEqual(vp.body.bloqueos, []);
  assert.ok(vp.body.cambios.some((c) => c.legajo === String(L.S) && c.salidas.agregadas.length), 'aparece una salida desde las 16:00');
  await fichar(9, '16:00:00', '.31');
  const mismoSegundo = await vistaPrevia(id, 'CAMBIAR_MARCADOR', 9);
  assert.match(mismoSegundo.body.bloqueos.join(' '), /mismo segundo/);
  await db.query("DELETE FROM Checkins WHERE tenant_id = ? AND USERID = 9 AND CHECKTIME = ?", [TA, `${DIA} 16:00:00`]);
});

test('mes cerrado: se avisa en qué cierre se paga; si no hay dónde pagarlo, se bloquea', async () => {
  const id = await idDe(U.S, '15:06:14');
  await db.query("INSERT INTO overtime_period_closings (tenant_id, periodo, accion) VALUES (?, '2026-02', 'CERRAR')", [TA]);
  const uno = await vistaPrevia(id, 'OMITIR');
  assert.deepEqual(uno.body.cierres.cerrados, ['2026-02']);
  assert.deepEqual(uno.body.cierres.ajusteEn, { '2026-02': '2026-03' });
  assert.deepEqual(uno.body.bloqueos, []);
  for (const p of ['2026-03', '2026-04', '2026-05']) {
    await db.query("INSERT INTO overtime_period_closings (tenant_id, periodo, accion) VALUES (?, ?, 'CERRAR')", [TA, p]);
  }
  const todos = await vistaPrevia(id, 'OMITIR');
  assert.match(todos.body.bloqueos.join(' '), /cerrado en Liquidación/);
  assert.equal(todos.body.comprobante, null);
  await db.query('DELETE FROM overtime_period_closings WHERE tenant_id = ?', [TA]);
});

test('otra empresa no ve ni corrige nada de esta', async () => {
  const lista = await get(hB, '/api/correcciones-fichajes?estado=todas');
  assert.equal(lista.status, 200);
  assert.equal(lista.body.total, 0);
  const vp = await get(hB, `/api/correcciones-fichajes/vista-previa?checkinId=${await idDe(U.S, '16:00:00')}&accion=OMITIR`);
  assert.equal(vp.status, 404);
});

test('historial y lista con filtros y paginación', async () => {
  const todas = await get(hAdmin, '/api/correcciones-fichajes?estado=todas&porPagina=2&pagina=1');
  assert.equal(todas.body.total, 3);
  assert.equal(todas.body.filas.length, 2);
  const deS = await get(hAdmin, `/api/correcciones-fichajes?legajo=${L.S}`);
  assert.equal(deS.body.total, 2);
  assert.ok(deS.body.filas[0].por, 'dice quién la hizo');
  assert.ok(deS.body.filas[0].en, 'y cuándo');
  assert.equal(deS.body.filas[0].motivo, 'Prueba de corrección');
});

test('deshacer: con vista previa y motivo; todo vuelve exactamente a como estaba', async () => {
  const [activas] = await db.query('SELECT id FROM fichajes_correcciones WHERE tenant_id = ? AND deshecha_at IS NULL ORDER BY id DESC', [TA]);
  for (const { id } of activas) {
    const vp = await get(hAdmin, `/api/correcciones-fichajes/${id}/deshacer/vista-previa`);
    assert.equal(vp.status, 200, JSON.stringify(vp.body));
    const r = await post(hAdmin, `/api/correcciones-fichajes/${id}/deshacer`, { motivo: 'Prueba deshacer', comprobante: vp.body.comprobante, confirmoOtros: vp.body.afectaAOtros });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.deepEqual(await salidas(L.S), salidasOriginalesS);
  const historial = await get(hAdmin, `/api/correcciones-fichajes/fichaje/${await idDe(U.S, '12:05:12')}`);
  assert.equal(historial.body.historial.length, 1);
  assert.equal(historial.body.historial[0].deshecha, true, 'la corrección deshecha queda en el historial');
  assert.equal(historial.body.historial[0].motivoDeshacer, 'Prueba deshacer');
});

test('corrección huérfana (el fichaje ya no es el mismo): no se aplica y se marca', async () => {
  const id = await idDe(U.S, '12:05:12');
  await db.query(
    `INSERT INTO fichajes_correcciones (tenant_id, checkin_id, checkin_userid, checkin_time, checkin_machine_ip, employee_id, accion, motivo)
     VALUES (?, ?, ?, ?, '.30', ?, 'OMITIR', 'Prueba huérfana')`, [TA, id, U.S, `${DIA} 12:05:13`, L.S]);
  assert.deepEqual(await salidas(L.S), salidasOriginalesS);
  const lista = await get(hAdmin, '/api/correcciones-fichajes');
  assert.equal(lista.body.filas[0].huerfana, true);
  await db.query('DELETE FROM fichajes_correcciones WHERE tenant_id = ? AND motivo = ?', [TA, 'Prueba huérfana']);
});

test('ninguna fila de Checkins se tocó', async () => {
  assert.equal(await controlDeCheckins(), control);
});
