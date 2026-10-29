// Cómo se cuentan las horas extra (configHorasExtra.js + excesoSobreHorario.js
// + routes/configHorasExtra.js). Requiere el backend local corriendo.
// Tenants descartables 999985 / 999984.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { calcular } = require('../motor-laboral/services/excesoSobreHorario');
const configHE = require('../motor-laboral/services/configHorasExtra');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999985;
const OTRA = 999984;
const DIA = '2026-09-07'; // lunes
const PERMISOS = ['attendance:read', 'attendance:create', 'schedules:read', 'schedules:update'];
let h, hOtra;
let plantillaT, plantillaOtra;
// Horario 08 a 17. Cada persona, un caso típico de cualquier empresa:
const CASOS = {
  almuerzo: [985001, ['08:00', '12:00', '13:00', '19:00']], // ficha el almuerzo, sale 19:00
  vuelve: [985002, ['07:00', '17:00', '18:00', '20:00']], // llega antes; sale y vuelve a la noche
  rebote: [985003, ['08:00', '08:01', '19:00']], // el reloj leyó dos veces
  falta: [985004, ['08:00', '12:00', '19:30']], // falta un fichaje
  fuera: [985005, ['18:00', '23:00']], // todo el día fuera de su horario (¿horario mal asignado?)
};
const LEG = Object.fromEntries(Object.entries(CASOS).map(([k, [l]]) => [k, l]));

async function cleanup() {
  for (const t of [T, OTRA]) {
    await db.query("DELETE FROM app_settings WHERE tenant_id = ? AND name IN ('overtimeMethod','overtimeCountEarlyArrival','overtimeAuthorizationMode','overtimeSinHabilitarAvisoMinutos')", [t]);
    await db.query('DELETE FROM plantilla_horas_extra WHERE tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE c FROM employee_work_calendars c JOIN employees e ON e.id = c.employee_id WHERE e.tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates w ON w.id = b.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

async function empresa(t, delta) {
  const [tp] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, 'Oficina 8 a 17 (test)', 'FIXED', 1, 1)`, [t]);
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '08:00:00', '17:00:00', 'WORK', 1)`, [tp.insertId]);
  for (const [legajo, horas] of Object.values(CASOS)) {
    const l = legajo + delta;
    const [e] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report, activo) VALUES (?, ?, ?, 0, 1)', [l, `L${l} (test)`, t]);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [l, t, String(l), `L${l}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [l, t, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [e.insertId, t, tp.insertId]);
    for (const hora of horas) await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [l, t, `${DIA} ${hora}:00`]);
  }
  return tp.insertId;
}

let hayTabla = true;
before(async () => {
  for (const t of [T, OTRA]) await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [t, `Config HE ${t} (test)`, `config-he-${t}-test`]);
  h = await getTestAuthHeaders('test-config-he', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  hOtra = await getTestAuthHeaders('test-config-he-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  await cleanup();
  plantillaT = await empresa(T, 0);
  plantillaOtra = await empresa(OTRA, 1000);
  try { await db.query('SELECT 1 FROM plantilla_horas_extra LIMIT 1'); } catch { hayTabla = false; }
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-config-he');
  await deleteTestUser('test-config-he-otra');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

const pedir = (metodo, ruta, body, headers = h) => fetch(URL + ruta, {
  method: metodo, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
async function dia(legajo, headers = h) {
  const j = await (await pedir('GET', `/attendance-range?from=${DIA}&to=${DIA}&employeeId=${legajo}`, null, headers)).json();
  const fila = j.data.find((x) => String(x.employeeId) === String(legajo));
  return fila.days.find((x) => x.date === DIA);
}

test('cálculo puro: lo que supera el horario no depende de cuántos fichajes haya', () => {
  const m = (x) => { const [a, b] = x.split(':').map(Number); return a * 60 + b; };
  const blocks = [{ block_type: 'WORK', start_time: '08:00:00', end_time: '17:00:00' }];
  const c = (f, o = {}) => calcular({ fichajes: f.map(m), blocks, ...o });
  assert.equal(c(['08:00', '12:00', '13:00', '19:00']).minutos, 120, 'almuerzo fichado');
  assert.equal(c(['07:00', '17:00', '18:00', '20:00']).minutos, 120, 'sale y vuelve: solo lo trabajado');
  assert.equal(c(['07:00', '17:00', '18:00', '20:00'], { contarLlegadaAnticipada: true }).minutos, 180);
  assert.equal(c(['08:00', '08:01', '19:00']).repetidosIgnorados, 1, 'rebote del reloj');
  assert.equal(c(['08:00', '12:00', '19:30']).aRevisar, true, 'falta un fichaje: a revisar');
  assert.equal(c(['08:00', '19:00'], { corte: '18:00' }).minutos, 60, 'corte de la plantilla');
  assert.equal(c(['08:00']), null, 'un solo fichaje: no se sabe');
  const fuera = c(['18:00', '23:00']);
  assert.deepEqual([fuera.minutos, fuera.aRevisar, fuera.fueraDeHorario], [300, true, true], 'todo fuera de horario');
  assert.equal(c(['08:00', '19:00']).fueraDeHorario, false);
  const noche = [{ block_type: 'WORK', start_time: '22:00:00', end_time: '06:00:00', crosses_midnight: 1 }];
  assert.equal(calcular({ fichajes: [m('22:00'), m('08:00') + 1440], blocks: noche }).minutos, 120, 'turno noche');
  assert.deepEqual(configHE.resolver({ metodo: 'EXCESO', contarLlegadaAnticipada: false }, { metodo: null, contarLlegadaAnticipada: true, minimo: 20 }),
    { metodo: 'EXCESO', contarLlegadaAnticipada: true, minimoPlantilla: 20 }, 'la plantilla gana en lo que define');
});

test('sin configurar: todo como siempre (marcas o estimado)', async () => {
  const d = await dia(LEG.vuelve);
  assert.equal(d.overtimeMinutes, 180);
  assert.equal(d.overtimeSource, 'fallback');
  const cfg = await (await pedir('GET', '/api/config-horas-extra')).json();
  assert.equal(cfg.empresa.metodo, 'MARCAS_O_ESTIMADO');
  assert.equal(cfg.autorizacion, 'all');
  assert.equal(cfg.plantillas.length, 1);
});

test('"Ver qué cambiaría" antes de guardar: compara día por día y no cambia nada', async () => {
  const j = await (await pedir('GET', `/api/config-horas-extra/impacto?metodo=EXCESO&from=${DIA}&to=${DIA}`)).json();
  // almuerzo 120 (deja de ser estimada), vuelve 180 -> 120, rebote 120 (deja de
  // ser estimada), fuera 0 -> 300 (a revisar); falta: igual.
  assert.equal(j.dias, 4);
  assert.equal(j.minutosHoy, 420);
  assert.equal(j.minutosCon, 660);
  assert.equal(j.diasQueRestan, 1);
  assert.equal(j.diasQueSuman, 1);
  assert.equal(j.aRevisarHoy, 3);
  assert.equal(j.aRevisarCon, 1);
  assert.equal((await dia(LEG.vuelve)).overtimeMinutes, 180, 'la vista previa no guarda nada');
});

test('la empresa elige "lo que supera el horario"', async () => {
  assert.equal((await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'EXCESO', contarLlegadaAnticipada: false })).status, 200);
  const v = await dia(LEG.vuelve);
  assert.deepEqual([v.overtimeMinutes, v.overtimeSource, v.overtimeNeedsVerification], [120, 'schedule', false]);
  const a = await dia(LEG.almuerzo);
  assert.deepEqual([a.overtimeMinutes, a.overtimeNeedsVerification], [120, false]);
  assert.equal((await dia(LEG.rebote)).overtimeMinutes, 120);
  const f = await dia(LEG.falta);
  assert.deepEqual([f.overtimeMinutes, f.overtimeNeedsVerification], [150, true], 'falta un fichaje: cuenta y queda a revisar');
  const fu = await dia(LEG.fuera);
  assert.deepEqual([fu.overtimeMinutes, fu.overtimeNeedsVerification, fu.overtimeOutsideSchedule], [300, true, true], 'todo fuera de horario: a revisar');
});

test('Días a revisar trae el día al que le falta un fichaje', async () => {
  const j = await (await pedir('GET', `/api/horas-extra-revisar?from=${DIA}&to=${DIA}`)).json();
  const fila = j.dias.find((x) => String(x.legajo) === String(LEG.falta));
  assert.ok(fila, JSON.stringify(j).slice(0, 300));
  assert.match(fila.explicacion, /Le falta un fichaje/);
  const fuera = j.dias.find((x) => String(x.legajo) === String(LEG.fuera));
  assert.equal(fuera && fuera.tipo, 'fuera_de_horario');
  assert.ok(!j.dias.some((x) => String(x.legajo) === String(LEG.vuelve)));
});

test('excepción de la plantilla: llegar antes cuenta y mínimo propio', async () => {
  const r = await pedir('PUT', `/api/config-horas-extra/plantillas/${plantillaT}`, { contarLlegadaAnticipada: true, minimo: 150 });
  if (!hayTabla) { assert.equal(r.status, 503); return; }
  assert.equal(r.status, 200);
  const v = await dia(LEG.vuelve);
  assert.deepEqual([v.overtimeMinutes, v.overtimeEarlyMinutes], [180, 60]);
  const a = await dia(LEG.almuerzo);
  assert.deepEqual([a.overtimeMinutes, a.overtimeBelowMinimumMinutes, a.overtimeMinimumMinutes], [0, 120, 150]);
  // Todo vacío = se quita la excepción.
  assert.equal((await pedir('PUT', `/api/config-horas-extra/plantillas/${plantillaT}`, { metodo: '', contarLlegadaAnticipada: null, minimo: '' })).status, 200);
  assert.equal((await dia(LEG.almuerzo)).overtimeMinutes, 120);
});

test('solo autorizados: quien no está autorizado no suma', async () => {
  await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'EXCESO', contarLlegadaAnticipada: false, autorizacion: 'custom' });
  await db.query('UPDATE employees SET overtime_authorized = 1 WHERE tenant_id = ?', [T]);
  await db.query('UPDATE employees SET overtime_authorized = 0 WHERE tenant_id = ? AND employee_id = ?', [T, LEG.almuerzo]);
  try {
    assert.equal((await dia(LEG.almuerzo)).overtimeMinutes, 0);
    assert.equal((await dia(LEG.vuelve)).overtimeMinutes, 120, 'los autorizados siguen igual');
    assert.equal((await (await pedir('GET', '/api/config-horas-extra')).json()).autorizacion, 'custom');
  } finally {
    await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'EXCESO', contarLlegadaAnticipada: false, autorizacion: 'all' });
  }
});

test('paso 2: marcar autorizados en lote y ver qué cambiaría antes de activar "solo autorizados"', async () => {
  // La empresa sigue en "todas las personas" (lo dejó así el test anterior).
  const lista = await (await pedir('GET', '/api/config-horas-extra/autorizados')).json();
  assert.equal(lista.length, 5);
  assert.equal(lista[0].plantilla, 'Oficina 8 a 17 (test)');
  const id = (leg) => lista.find((x) => x.legajo === String(leg)).id;
  assert.equal((await pedir('PUT', '/api/config-horas-extra/autorizados', { ids: lista.map((x) => x.id), autorizado: true })).status, 200);
  const r = await (await pedir('PUT', '/api/config-horas-extra/autorizados', { ids: [id(LEG.almuerzo)], autorizado: false })).json();
  assert.equal(r.cambiados, 1);
  const cfg = await (await pedir('GET', '/api/config-horas-extra')).json();
  assert.deepEqual(cfg.autorizados, { si: 4, total: 5 });
  // Vista previa: con "solo autorizados", almuerzo (120 min) deja de sumar.
  const j = await (await pedir('GET', `/api/config-horas-extra/impacto?autorizacion=custom&from=${DIA}&to=${DIA}`)).json();
  assert.equal(j.dias, 1);
  assert.equal(j.minutosHoy - j.minutosCon, 120);
  assert.equal(j.ejemplos[0].employeeId, String(LEG.almuerzo));
  assert.equal((await dia(LEG.almuerzo)).overtimeMinutes, 120, 'la vista previa no cambia nada');
  // Otra empresa no puede tocar a estas personas (ni las ve).
  const otra = await (await pedir('PUT', '/api/config-horas-extra/autorizados', { ids: [id(LEG.vuelve)], autorizado: false }, hOtra)).json();
  assert.equal(otra.cambiados, 0);
  assert.ok(!(await (await pedir('GET', '/api/config-horas-extra/autorizados', null, hOtra)).json()).some((x) => x.id === id(LEG.vuelve)));
  assert.equal((await pedir('PUT', '/api/config-horas-extra/autorizados', { ids: [], autorizado: true })).status, 400);
});

test('H1: horas extra sin habilitar (se ven, no se cuentan)', async () => {
  // Viene del test anterior: todos autorizados menos almuerzo (120 min).
  const ruta = `/api/config-horas-extra/sin-habilitar?from=${DIA}&to=${DIA}`;
  const todas = await (await pedir('GET', ruta)).json();
  assert.deepEqual([todas.aplica, todas.personas.length], [false, 0], 'con "Todas las personas" no hay nada que avisar');
  await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'EXCESO', contarLlegadaAnticipada: false, autorizacion: 'custom' });
  try {
    const j = await (await pedir('GET', ruta)).json();
    assert.equal(j.aplica, true);
    assert.deepEqual(j.personas.map((p) => [p.employeeId, p.minutos]), [[String(LEG.almuerzo), 120]], 'solo quien no está habilitado');
    assert.deepEqual(j.personas[0].dias, [{ fecha: DIA, minutos: 120 }]);
    const [[interno]] = await db.query('SELECT id FROM employees WHERE tenant_id = ? AND employee_id = ?', [T, LEG.almuerzo]);
    assert.equal(j.personas[0].id, interno.id, 'trae el id interno para habilitar desde la lista');
    assert.equal((await dia(LEG.almuerzo)).overtimeMinutes, 0, 'lo oficial no cambia: sigue sin contarse');
    assert.equal((await dia(LEG.vuelve)).overtimeMinutes, 120, 'los habilitados siguen igual');
    const otra = await (await pedir('GET', ruta, null, hOtra)).json();
    assert.equal(otra.personas.length, 0, 'otra empresa no ve a estas personas');
    assert.equal((await pedir('GET', '/api/config-horas-extra/sin-habilitar?from=x&to=y')).status, 400);
    // H2: tope del aviso, por empresa. Sin cargar = 2 h.
    assert.deepEqual([j.avisoMinutos, j.personas[0].superaAviso, j.superanAviso], [120, true, 1], '120 min llega al tope de 2 h');
    assert.equal((await (await pedir('GET', '/api/config-horas-extra')).json()).avisoSinHabilitarMinutos, 120);
    assert.equal((await pedir('PUT', '/api/config-horas-extra/aviso-sin-habilitar', { minutos: 121 })).status, 200);
    const j2 = await (await pedir('GET', ruta)).json();
    assert.deepEqual([j2.avisoMinutos, j2.personas[0].superaAviso, j2.superanAviso, j2.personas.length], [121, false, 0, 1],
      'bajo el tope: sigue en la lista, sin aviso');
    // H4: una sola persona (para el detalle y la ficha).
    const una = await (await pedir('GET', `${ruta}&employeeId=${LEG.almuerzo}`)).json();
    assert.deepEqual(una.personas.map((p) => [p.employeeId, p.minutos]), [[String(LEG.almuerzo), 120]]);
    const otraPersona = await (await pedir('GET', `${ruta}&employeeId=${LEG.vuelve}`)).json();
    assert.equal(otraPersona.personas.length, 0, 'una persona habilitada no tiene nada sin contar');
    assert.equal((await pedir('GET', `${ruta}&employeeId=${encodeURIComponent("1' OR 1=1")}`)).status, 400);
    for (const malo of [0, -5, 1.5, 'x', 6001, null]) {
      assert.equal((await pedir('PUT', '/api/config-horas-extra/aviso-sin-habilitar', { minutos: malo })).status, 400, `rechaza ${malo}`);
    }
    assert.equal((await (await pedir('GET', '/api/config-horas-extra', null, hOtra)).json()).avisoSinHabilitarMinutos, 120, 'otra empresa sigue con el suyo');
    assert.equal((await dia(LEG.almuerzo)).overtimeMinutes, 0, 'el aviso no cambia ningún número');
  } finally {
    await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'EXCESO', contarLlegadaAnticipada: false, autorizacion: 'all' });
  }
});

test('aislamiento: la configuración de una empresa no toca a otra', async () => {
  const v = await dia(LEG.vuelve + 1000, hOtra);
  assert.deepEqual([v.overtimeMinutes, v.overtimeSource], [180, 'fallback']);
  assert.equal((await pedir('PUT', `/api/config-horas-extra/plantillas/${plantillaOtra}`, { minimo: 10 })).status, 404, 'no puede tocar la plantilla de otra empresa');
});

test('validación y volver a lo de siempre', async () => {
  assert.equal((await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'CUALQUIERA' })).status, 400);
  assert.equal((await pedir('PUT', `/api/config-horas-extra/plantillas/${plantillaT}`, { minimo: 999 })).status, 400);
  assert.equal((await pedir('POST', '/api/config-horas-extra/empresa', { metodo: 'MARCAS_O_ESTIMADO' })).status, 200);
  assert.equal((await dia(LEG.vuelve)).overtimeMinutes, 180);
});
