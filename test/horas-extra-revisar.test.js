// "Días a revisar" de horas extra (routes/horasExtraRevisar.js).
// Requiere el backend local corriendo. Tenant descartable 999986.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { clasificar, UMBRAL_MINUTOS_ESTIMADAS } = require('../routes/horasExtraRevisar');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999986;
const DIA = '2026-09-07'; // lunes
const UID = 'test-horas-extra-revisar';
let h, templateId;
const legajos = { estimada: 986001, corta: 986002, regreso: 986003, omitida: 986004, conMarcador: 986005 };
const MARC = { ofSalida: 986904, ofRegreso: 986903, heIni: 986909, heFin: 986910 };

async function cleanup() {
  await db.query('DELETE FROM horas_extra_revisiones WHERE tenant_id = ?', [T]).catch(() => {});
  await db.query('DELETE FROM ManualEntries WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM specialusers WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [T]);
  await db.query('DELETE FROM users WHERE tenant_id = ?', [T]);
  await db.query('DELETE c FROM employee_work_calendars c JOIN employees e ON e.id = c.employee_id WHERE e.tenant_id = ?', [T]);
  await db.query('DELETE FROM employees WHERE tenant_id = ?', [T]);
  await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates w ON w.id = b.template_id WHERE w.tenant_id = ?', [T]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [T]);
}

const fichar = (userId, hora) => db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [userId, T, `${DIA} ${hora}`]);

before(async () => {
  await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [T, 'Revisar HE (test)', 'revisar-he-test']);
  h = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: T, permissions: ['attendance:read', 'attendance:create', 'attendance:delete', 'horas_extra:update'] });
  await cleanup();
  // Lunes 7 a 14, horas extra desde las 15:00.
  const [t] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, overtime_cutoff_time) VALUES (?, 'HE desde 15 (test)', 'FIXED', 1, 1, '15:00:00')`, [T]);
  templateId = t.insertId;
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '07:00:00', '14:00:00', 'WORK', 1)`, [templateId]);
  for (const [n, legajo] of Object.entries(legajos)) {
    const [e] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report, activo) VALUES (?, ?, ?, 0, 1)', [legajo, `${n} (test)`, T]);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [legajo, T, String(legajo), n]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [legajo, T, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [e.insertId, T, templateId]);
  }
  for (const [uid, cat, dir] of [[MARC.ofSalida, 'OFICIAL', 'SALIDA'], [MARC.ofRegreso, 'OFICIAL', 'REGRESO'], [MARC.heIni, 'HE', 'SALIDA'], [MARC.heFin, 'HE', 'REGRESO']]) {
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [uid, T, String(uid), `Marcador ${cat} ${dir}`]);
    await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', ?, ?, 1)`, [uid, T, String(uid), cat, dir]);
  }
  // D: sin marcador de inicio, se va 17:40 -> estimada 15:00-17:40 (160 min).
  await fichar(legajos.estimada, '07:05:00'); await fichar(legajos.estimada, '17:40:00');
  // Estimada corta (15:20 -> 20 min): no entra en la lista.
  await fichar(legajos.corta, '07:05:00'); await fichar(legajos.corta, '15:20:00');
  // C: salida oficial 08:42 y regreso oficial 18:01 -> el estimado lo cuenta como HE.
  await fichar(legajos.regreso, '07:05:00');
  await fichar(MARC.ofSalida, '08:41:55'); await fichar(legajos.regreso, '08:42:00');
  await fichar(MARC.ofRegreso, '18:00:55'); await fichar(legajos.regreso, '18:01:00');
  // Igual que la estimada, pero ya revisada: se omitió.
  await fichar(legajos.omitida, '07:05:00'); await fichar(legajos.omitida, '17:40:00');
  await db.query(`INSERT INTO ManualEntries (tenant_id, userId, startDatetime, endDatetime, durationMinutes, type, note) VALUES (?, ?, ?, ?, 0, 'omit', 'test')`,
    [T, legajos.omitida, `${DIA} 00:00:00`, `${DIA} 00:00:00`]);
  // Con marcadores 9 y 10: horas extra reales, no se revisan.
  await fichar(legajos.conMarcador, '07:05:00');
  await fichar(MARC.heIni, '14:59:55'); await fichar(legajos.conMarcador, '15:00:00');
  await fichar(MARC.heFin, '17:59:55'); await fichar(legajos.conMarcador, '18:00:00');
});

after(async () => {
  await cleanup();
  await deleteTestUser(UID);
  await db.query('DELETE FROM tenants WHERE id = ?', [T]);
  await closeDb();
});

test('clasificar (pura): regreso no-HE como último fichaje; estimada larga; estimada corta afuera', () => {
  const f = (hora, tipos = [], base = 'Intermedio') => ({ hora, base, tipos });
  assert.equal(clasificar({ minutos: 181, aRevisar: true }, [f('06:49'), f('08:42', [{ categoria: 'OFICIAL', rol: 'salida' }]), f('18:01', [{ categoria: 'OFICIAL', rol: 'regreso' }])]).tipo, 'regreso_contado');
  assert.equal(clasificar({ minutos: 160, aRevisar: true, desde: '15:00', hasta: '17:40' }, [f('07:05'), f('17:40')]).tipo, 'estimada');
  assert.equal(clasificar({ minutos: UMBRAL_MINUTOS_ESTIMADAS, aRevisar: true }, [f('07:05'), f('15:30')]), null);
  // Un regreso de HE (marcador 10) no es "regreso contado": es su fin real.
  assert.equal(clasificar({ minutos: 20, aRevisar: false }, [f('07:05'), f('17:00', [{ categoria: 'HE', rol: 'regreso' }])]), null);
  // Una lectura repetida al final no cuenta como el último fichaje.
  assert.equal(clasificar({ minutos: 181, aRevisar: true }, [f('07:00'), f('18:01', [{ categoria: 'OFICIAL', rol: 'regreso' }]), f('18:01', [], 'Repetido')]).tipo, 'regreso_contado');
});

test('lista de septiembre: trae la estimada larga y el regreso; no la corta ni la de marcadores; la omitida como revisada', async () => {
  const r = await fetch(`${URL}/api/horas-extra-revisar?from=2026-09-01&to=2026-09-30`, { headers: h });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  const de = (l) => j.dias.find((d) => d.legajo === String(l));
  assert.equal(de(legajos.estimada).tipo, 'estimada');
  assert.equal(de(legajos.estimada).minutos, 160);
  assert.match(de(legajos.estimada).explicacion, /desde 15:00 hasta 17:40/);
  assert.equal(de(legajos.regreso).tipo, 'regreso_contado');
  assert.match(de(legajos.regreso).explicacion, /regreso oficial/);
  assert.equal(de(legajos.corta), undefined, 'menos del umbral');
  assert.equal(de(legajos.conMarcador), undefined, 'con marcador no es estimada');
  assert.equal(de(legajos.omitida).revisado, true);
  assert.equal(j.pendientes, 2);
  // Ordenado: pendientes primero, de más a menos horas.
  assert.deepEqual(j.dias.map((d) => d.legajo), [String(legajos.regreso), String(legajos.estimada), String(legajos.omitida)]);
});

test('la lista no cambia lo que devuelve Presentismo', async () => {
  const sin = await (await fetch(`${URL}/attendance-range?from=2026-09-01&to=2026-09-30`, { headers: h })).json();
  assert.equal(sin.diasARevisar, undefined);
  const fila = sin.data.find((x) => String(x.employeeId) === String(legajos.estimada));
  assert.equal(Number(fila.overtimeHours), Number((160 / 60).toFixed(2)));
});

test('validaciones: fechas obligatorias y período máximo', async () => {
  assert.equal((await fetch(`${URL}/api/horas-extra-revisar?from=2026-09-01`, { headers: h })).status, 400);
  assert.equal((await fetch(`${URL}/api/horas-extra-revisar?from=2026-01-01&to=2026-06-30`, { headers: h })).status, 400);
});

const lista = async () => (await (await fetch(`${URL}/api/horas-extra-revisar?from=2026-09-01&to=2026-09-30`, { headers: h })).json());
const enviar = (metodo, ruta, body) => fetch(URL + ruta, { method: metodo, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('"Está bien": queda revisado con quién y cuándo; si los minutos cambian, vuelve a pendiente; se puede deshacer', async () => {
  const r = await enviar('POST', '/api/horas-extra-revisar/aceptar', { legajo: String(legajos.estimada), fecha: DIA, minutos: 160 });
  assert.equal(r.status, 200, await r.clone().text());
  let d = (await lista()).dias.find((x) => x.legajo === String(legajos.estimada));
  assert.equal(d.revisado, true);
  assert.equal(d.revision.decision, 'aceptado');
  assert.match(d.revision.por, /@test\.local$/);
  // Aceptado con otros minutos (como si hubieran llegado fichajes nuevos): pendiente otra vez.
  await enviar('POST', '/api/horas-extra-revisar/aceptar', { legajo: String(legajos.estimada), fecha: DIA, minutos: 100 });
  d = (await lista()).dias.find((x) => x.legajo === String(legajos.estimada));
  assert.equal(d.revisado, false);
  assert.equal(d.cambioDesdeRevision, 100);
  // Deshacer.
  await enviar('POST', '/api/horas-extra-revisar/aceptar', { legajo: String(legajos.estimada), fecha: DIA, minutos: 160 });
  assert.equal((await enviar('DELETE', `/api/horas-extra-revisar/aceptar?legajo=${legajos.estimada}&fecha=${DIA}`)).status, 200);
  d = (await lista()).dias.find((x) => x.legajo === String(legajos.estimada));
  assert.equal(d.revisado, false);
  assert.equal(d.cambioDesdeRevision, null);
});

test('"Está bien" no cambia las horas extra de Presentismo', async () => {
  await enviar('POST', '/api/horas-extra-revisar/aceptar', { legajo: String(legajos.estimada), fecha: DIA, minutos: 160 });
  const j = await (await fetch(`${URL}/attendance-range?from=2026-09-01&to=2026-09-30`, { headers: h })).json();
  const fila = j.data.find((x) => String(x.employeeId) === String(legajos.estimada));
  assert.equal(Number(fila.overtimeHours), Number((160 / 60).toFixed(2)));
});

test('la lista trae lo necesario para "No corresponde" (omitir) y deshacerlo', async () => {
  const d = (await lista()).dias.find((x) => x.legajo === String(legajos.omitida));
  assert.equal(d.revision.decision, 'omitido');
  assert.ok(d.omitEntryId, 'id del omitir, para deshacer');
  assert.equal(d.userId, legajos.omitida);
});

test('"Está bien" de un legajo de otra empresa: 404', async () => {
  assert.equal((await enviar('POST', '/api/horas-extra-revisar/aceptar', { legajo: '1', fecha: DIA, minutos: 10 })).status, 404);
});
