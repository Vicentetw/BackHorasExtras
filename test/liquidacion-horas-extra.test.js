// Informe de liquidacion y cierre de mes de horas extra (B5). Ver
// HORAS_EXTRA_REGIMENES.md y la migracion 20261008.
//
// Dos personas hacen 3 h extra por dia (marcadores 9/10, 15:00 a 18:00) de
// lunes a viernes, en enero (05 al 09) y en febrero (02 al 06) de 2026:
//   CON: regimen con tope ANUAL de 20 h, excedente NO_COMPUTAR.
//   SIN: nada asignado (horas extra de siempre).
// Enero da 15 h a cada una. Febrero, para CON, depende de si enero esta
// CERRADO: cerrado, le quedan 5 h de tope (20 - 15); abierto, el tope anual
// solo ve febrero (limitacion documentada: por eso existe el cierre).
//
// Requiere el backend local corriendo. Tenants descartables (999981/999982).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { mesAnterior, mesesAntes, ultimoDia } = require('../routes/liquidacionHorasExtra');
const { calcularPeriodo } = require('../motor-laboral/services/horasExtraRegimen');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999981;
const OTRA = 999982;
const UID = 'test-liquidacion';
const UID_OTRA = 'test-liquidacion-otra';
const CON = { legajo: 900891, userId: 8890191, reloj: '10.0.2.1' };
const SIN = { legajo: 900892, userId: 8890192, reloj: '10.0.2.2' };
const M9 = 8890193;
const M10 = 8890194;
const ENERO = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const FEBRERO = ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06'];

let h, hOtra, conInterno;

const liq = async (periodo, extra = '', headers = h) => {
  const r = await fetch(`${URL}/api/liquidacion-horas-extra?periodo=${periodo}&tenantId=${T}${extra}`, { headers });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
};
const post = (ruta, body, headers = h) => fetch(`${URL}/api/liquidacion-horas-extra${ruta}?tenantId=${T}`, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const de = (informe, p) => informe.filas.find((f) => f.legajo === p.legajo);

async function cleanup() {
  for (const t of [T, OTRA]) {
    await db.query('DELETE FROM overtime_period_adjustments WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_period_results WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_period_closings WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_excess_approvals WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM day_type_overtime_rules WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_convention_assignments WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM labor_conventions WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM employee_work_calendars WHERE tenant_id = ?', [t]);
    const [tpls] = await db.query('SELECT id FROM work_schedule_templates WHERE tenant_id = ?', [t]);
    for (const { id } of tpls) await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [id]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
    for (const x of ['specialusers', 'Checkins', 'user_employee_map', 'users', 'employees']) {
      await db.query(`DELETE FROM ${x} WHERE tenant_id = ?`, [t]);
    }
  }
}

async function horasExtra(emp, dias, i) {
  const s = (dia, hhmm, seg) => `${dia} ${hhmm}:${String(seg + i * 2).padStart(2, '0')}`;
  for (const dia of dias) {
    for (const [userId, cuando] of [
      [emp.userId, s(dia, '06:55', 0)],
      [M9, s(dia, '14:59', 55)], [emp.userId, s(dia, '15:00', 0)],
      [M10, s(dia, '17:59', 55)], [emp.userId, s(dia, '18:00', 0)],
    ]) {
      await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES (?, ?, ?, ?)', [userId, T, cuando, emp.reloj]);
    }
  }
}

before(async () => {
  for (const [id, n] of [[T, 'Liquidacion (test)'], [OTRA, 'Liquidacion otra (test)']]) {
    await db.query(`INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`, [id, n, `liquidacion-${id}-test`]);
  }
  h = await getTestAuthHeaders(UID);
  hOtra = await getTestAuthHeaders(UID_OTRA, { isSuperadmin: false, tenantId: OTRA, permissions: ['attendance:read', 'attendance:update'] });
  await cleanup();

  const [tpl] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, 'Lunes a viernes 7-14 (test)', 'FIXED', 1, 0, 'legacy')`, [T]);
  for (let dow = 1; dow <= 5; dow++) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Jornada', '07:00:00', '14:00:00', 'WORK', 1)`, [tpl.insertId, dow]);
  }
  const ids = {};
  for (const emp of [CON, SIN]) {
    const [e] = await db.query(`INSERT INTO employees (employee_id, nombre, tenant_id, activo, fecha_alta, exclude_from_report) VALUES (?, ?, ?, 1, '2020-01-01', 0)`, [emp.legajo, `Liq ${emp.legajo}`, T]);
    ids[emp.legajo] = e.insertId;
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)`, [emp.userId, T, String(emp.legajo), `Liq ${emp.legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [emp.userId, T, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2025-01-01', NULL)`, [e.insertId, T, tpl.insertId]);
  }
  conInterno = ids[CON.legajo];
  for (const [uid, badge, dir] of [[M9, '9', 'SALIDA'], [M10, '10', 'REGRESO']]) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')`, [uid, T, badge]);
    await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador', 'HE', ?, 1)`, [uid, T, badge, dir]);
  }
  for (const [i, emp] of [CON, SIN].entries()) await horasExtra(emp, [...ENERO, ...FEBRERO], i);

  const [c] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Convenio (test)')`, [T]);
  await db.query(`INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from) VALUES (?, ?, ?, '2025-01-01')`, [conInterno, T, c.insertId]);
  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_anio_minutos, politica_excedente) VALUES (?, ?, '2025-01-01', 1200, 'NO_COMPUTAR')`, [T, c.insertId]);
  await db.query(`INSERT INTO day_type_overtime_rules (tenant_id, convention_id, day_type, trigger_type, classification_type, rate) VALUES (NULL, ?, 'WORKDAY', 'AFTER_SCHEDULE', 'EXTRA', 50)`, [c.insertId]);
});

after(async () => {
  await db.query('DELETE r FROM day_type_overtime_rules r JOIN labor_conventions c ON c.id = r.convention_id WHERE c.tenant_id = ?', [T]);
  await cleanup();
  await deleteTestUser(UID);
  await deleteTestUser(UID_OTRA);
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

test('funciones puras: mes anterior, ultimo dia, y el tope anual arranca con lo ya cerrado', () => {
  assert.equal(mesAnterior('2026-03'), '2026-02');
  assert.equal(mesAnterior('2026-01'), null, 'enero no tiene anterior dentro del año');
  assert.equal(ultimoDia('2026-02'), '2026-02-28');
  assert.equal(ultimoDia('2028-02'), '2028-02-29');
  assert.deepEqual(mesesAntes('2026-02', 3), ['2026-01', '2025-12', '2025-11'], 'en febrero se revisa hasta noviembre del año anterior');
  const plantilla = { bloques: [{ tipo: 'WORK', desde: 420, hasta: 840 }], cuentanDesde: null };
  const dias = ['2026-02-02', '2026-02-03'].map((fecha) => ({ fecha, tipoDeDia: 'WORKDAY', intervalo: { inicio: 900, fin: 1080 }, plantilla }));
  const base = {
    dias, politicaDe: () => ({ topes: { anio: 1200 }, politica: 'NO_COMPUTAR' }),
    reglasDe: () => [{ day_type: 'WORKDAY', classification_type: 'EXTRA', rate: 50 }],
    autorizacionDe: () => null, aprobadosDe: () => 0,
  };
  assert.equal(calcularPeriodo(base).computables, 360, 'sin meses cerrados: 6 h, entran en el tope');
  const r = calcularPeriodo({ ...base, computadoAntesDe: (mes) => (mes === '2026-02' ? 900 : 0) });
  assert.equal(r.computables, 300, 'con 15 h ya cerradas en enero quedan 5 h de tope');
  assert.equal(r.excedente, 60);
});

test('informe en vivo: coincide al minuto con Presentismo, con y sin regimen', async () => {
  const inf = await liq('2026-01');
  assert.equal(inf.estado, 'ABIERTO');
  const pres = await (await fetch(`${URL}/attendance-range?from=2026-01-01&to=2026-01-31&tenantId=${T}`, { headers: h })).json();
  for (const p of [CON, SIN]) {
    const fila = pres.data.find((e) => String(e.employeeId) === String(p.legajo));
    assert.equal(de(inf, p).aLiquidar, Math.round(Number(fila.overtimeHours) * 60), `legajo ${p.legajo}`);
  }
  assert.equal(de(inf, CON).aLiquidar, 900);
  assert.equal(de(inf, CON).conRegimen, true);
  assert.equal(de(inf, CON).convenio, 'Convenio (test)');
  assert.deepEqual(de(inf, CON).porRecargo, { '50%': 900 });
  assert.equal(de(inf, SIN).aLiquidar, 900);
  assert.equal(de(inf, SIN).conRegimen, false);
  assert.equal(inf.totales.aLiquidar, 1800);
});

test('no se cierra un mes que no termino', async () => {
  const ahora = new Date();
  const esteMes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  assert.equal((await post('/cierres', { periodo: esteMes })).status, 400);
  assert.equal((await post('/cierres', { periodo: '2026-13' })).status, 400);
});

test('cerrar enero: queda la foto, y febrero descuenta enero del tope anual', async () => {
  // Antes de cerrar enero, febrero solo "ve" febrero: 15 h entran en 20.
  assert.equal(de(await liq('2026-02'), CON).computables, 900);

  const r = await post('/cierres', { periodo: '2026-01' });
  assert.equal(r.status, 201, await r.clone().text());
  assert.equal((await r.json()).personas, 2);
  assert.equal((await post('/cierres', { periodo: '2026-01' })).status, 409, 'dos veces no');

  const enero = await liq('2026-01');
  assert.equal(enero.estado, 'CERRADO');
  assert.ok(enero.cierre.fecha);
  assert.equal(de(enero, CON).aLiquidar, 900);

  const feb = de(await liq('2026-02'), CON);
  assert.equal(feb.computables, 300, '20 h de tope anual - 15 h cerradas en enero');
  assert.equal(feb.excedente, 600);
  assert.equal(de(await liq('2026-02'), SIN).aLiquidar, 900, 'sin regimen no cambia');
});

test('corregir un mes cerrado: la foto no cambia y la diferencia se paga al mes siguiente', async () => {
  await horasExtra(SIN, ['2026-01-12'], 1); // aparece un dia mas de HE en enero (+3 h)
  const enero = await liq('2026-01', '&comparar=1');
  assert.equal(de(enero, SIN).aLiquidar, 900, 'lo cerrado queda como se liquido');
  assert.deepEqual(enero.diferencias, [{ legajo: SIN.legajo, nombre: `Liq ${SIN.legajo}`, cerrado: 900, hoy: 1080 }]);

  const feb = await liq('2026-02');
  assert.equal(de(feb, SIN).aLiquidar, 900, 'lo propio de febrero no cambia');
  assert.equal(de(feb, SIN).ajuste, 180);
  assert.deepEqual(de(feb, SIN).ajustes, [{ periodo: '2026-01', minutos: 180 }]);
  assert.equal(de(feb, SIN).aPagar, 1080);
  assert.equal(de(feb, CON).ajuste, 0, 'a quien no se le corrigio nada, sin ajuste');
  assert.equal(feb.totales.ajuste, 180);
});

test('orden dentro del año: no se cierra marzo con febrero abierto, ni se reabre enero con febrero cerrado', async () => {
  const marzo = await post('/cierres', { periodo: '2026-03' });
  assert.equal(marzo.status, 409);
  assert.match((await marzo.json()).error, /2026-02/);

  const feb = await post('/cierres', { periodo: '2026-02' });
  assert.equal(feb.status, 201);
  assert.equal((await feb.json()).ajustes, 1, 'el ajuste de enero queda pagado en febrero');
  assert.equal((await post('/cierres/reabrir', { periodo: '2026-01', motivo: 'x' })).status, 409, 'febrero depende de enero');
  assert.equal((await post('/cierres/reabrir', { periodo: '2026-02' })).status, 400, 'sin motivo no');
});

test('un mes cerrado no acepta aprobaciones de excedente', async () => {
  const r = await fetch(`${URL}/api/regimen-horas-extra/aprobaciones?tenantId=${T}`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: conInterno, periodo: '2026-02', minutos: 60, motivo: 'jefe de obra' }),
  });
  assert.equal(r.status, 409);
});

test('un ajuste pagado no se vuelve a pagar, y si la correccion se deshace se descuenta', async () => {
  assert.deepEqual((await liq('2026-01', '&comparar=1')).diferencias, [], 'enero ya quedo saldado con el ajuste de febrero');
  const febCerrado = await liq('2026-02');
  assert.equal(febCerrado.estado, 'CERRADO');
  assert.equal(de(febCerrado, SIN).ajuste, 180, 'el ajuste pagado queda en la foto de febrero');
  assert.equal(de(febCerrado, SIN).aPagar, 1080);
  assert.equal(de(await liq('2026-03'), SIN)?.ajuste ?? 0, 0, 'marzo no lo vuelve a pagar');

  // Se descubre que el dia agregado estaba mal: se borra.
  await db.query(`DELETE FROM Checkins WHERE tenant_id = ? AND CHECKTIME BETWEEN '2026-01-12 00:00:00' AND '2026-01-12 23:59:59'`, [T]);
  const marzo = de(await liq('2026-03'), SIN);
  assert.equal(marzo.ajuste, -180, 'se descuenta lo que se pago de mas');
  assert.deepEqual(marzo.ajustes, [{ periodo: '2026-01', minutos: -180 }]);
  assert.equal(marzo.aPagar, -180);
});

test('otra empresa no ve ni toca los cierres ajenos', async () => {
  const r = await fetch(`${URL}/api/liquidacion-horas-extra?periodo=2026-01`, { headers: hOtra });
  const inf = await r.json();
  assert.equal(inf.estado, 'ABIERTO');
  assert.equal(inf.filas.length, 0);
  const re = await fetch(`${URL}/api/liquidacion-horas-extra/cierres/reabrir`, {
    method: 'POST', headers: { ...hOtra, 'Content-Type': 'application/json' }, body: JSON.stringify({ periodo: '2026-02', motivo: 'x' }),
  });
  assert.equal(re.status, 409, 'para la otra empresa febrero no esta cerrado');
  assert.equal((await (await fetch(`${URL}/api/liquidacion-horas-extra/cierres`, { headers: hOtra })).json()).cierres.length, 0);
});

test('reabrir en orden inverso deja el historial completo y el mes vuelve al calculo en vivo', async () => {
  assert.equal((await post('/cierres/reabrir', { periodo: '2026-02', motivo: 'faltaba una licencia' })).status, 201);
  assert.equal((await post('/cierres/reabrir', { periodo: '2026-01', motivo: 'fichaje corregido' })).status, 201);
  const enero = await liq('2026-01');
  assert.equal(enero.estado, 'REABIERTO');
  assert.equal(de(enero, SIN).aLiquidar, 900, 'en vivo: el dia agregado ya se borro');
  const { cierres } = await (await fetch(`${URL}/api/liquidacion-horas-extra/cierres?anio=2026&tenantId=${T}`, { headers: h })).json();
  assert.deepEqual(cierres.map((c) => `${c.periodo} ${c.accion}`), ['2026-01 REABRIR', '2026-02 REABRIR', '2026-02 CERRAR', '2026-01 CERRAR']);
  assert.equal(cierres[0].motivo, 'fichaje corregido');
});
