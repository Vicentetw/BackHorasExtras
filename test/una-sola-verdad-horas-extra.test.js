// UNA SOLA VERDAD de horas extra (2026-10-18). Pedido del dueño: "cómo vas a
// tener dos informes distintos cuando se utiliza para pagar". Para la misma
// persona y el mismo período, TODAS las pantallas tienen que dar lo mismo:
//   - el listado de la empresa (Presentismo, Horas extra por régimen),
//   - el detalle de la persona (calendario, portal) y la SUMA de sus días,
//   - una quincena o una semana = su parte del mes (los topes del mes se
//     reparten sobre el mes entero),
//   - Liquidación (en vivo),
//   - Días a revisar (los minutos de cada día),
//   - la vista previa de un cambio = lo que pasa al guardarlo.
// Con régimen (mínimo propio y tope mensual que NO computa el excedente), sin
// régimen, plantilla de horario partido y la vieja "fuente" del régimen
// guardada distinto (ya no se usa: punto F).
//
// Requiere el backend local corriendo. Tenants descartables 999983 / 999982.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999983;
const OTRA = 999982;
const PERMISOS = ['attendance:read', 'attendance:create', 'attendance:update', 'schedules:read', 'schedules:update'];
let h, hOtra;
// Septiembre 2026: días hábiles (lunes a viernes).
const HABILES = [];
for (let d = 1; d <= 30; d++) {
  const f = `2026-09-${String(d).padStart(2, '0')}`;
  const dow = new Date(`${f}T12:00:00`).getDay();
  if (dow >= 1 && dow <= 5) HABILES.push(f);
}
// Horario partido 8 a 12 y 16 a 20. Cada persona sale a una hora fija:
const PERS = {
  hora: { legajo: 983001, salida: '21:00' }, // 60 min por día -> régimen con tope mensual de 300
  poca: { legajo: 983002, salida: '20:20' }, // 20 min por día -> bajo el mínimo (30) de su régimen
};
const SIN_REGIMEN = { legajo: 982001, salida: '21:00' };

async function cleanup() {
  for (const t of [T, OTRA]) {
    await db.query("DELETE FROM app_settings WHERE tenant_id = ? AND name IN ('overtimeMethod','overtimeCountEarlyArrival','overtimeMinimumMinutes')", [t]);
    await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM employee_convention_assignments WHERE tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM labor_conventions WHERE tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE c FROM employee_work_calendars c JOIN employees e ON e.id = c.employee_id WHERE e.tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates w ON w.id = b.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

async function empresa(t, personas) {
  const [tp] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, overtime_cutoff_time) VALUES (?, 'Partido 8-12 y 16-20 (test)', 'FIXED', 1, 1, '13:00:00')`, [t]);
  for (let dow = 1; dow <= 5; dow++) {
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Mañana', '08:00:00', '12:00:00', 'WORK', 1)`, [tp.insertId, dow]);
    await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Tarde', '16:00:00', '20:00:00', 'WORK', 1)`, [tp.insertId, dow]);
  }
  const ids = {};
  for (const p of personas) {
    const [e] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report, activo) VALUES (?, ?, ?, 0, 1)', [p.legajo, `L${p.legajo} (test)`, t]);
    ids[p.legajo] = e.insertId;
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [p.legajo, t, String(p.legajo), `L${p.legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [p.legajo, t, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [e.insertId, t, tp.insertId]);
    for (const dia of HABILES) {
      for (const hora of ['08:00', '12:00', '16:00', p.salida]) {
        await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [p.legajo, t, `${dia} ${hora}:00`]);
      }
    }
  }
  // "Lo que supera el horario": cualquier reloj, sin teclas.
  await db.query("INSERT INTO app_settings (name, tenant_id, value) VALUES ('overtimeMethod', ?, 'EXCESO')", [t]);
  return ids;
}

before(async () => {
  for (const t of [T, OTRA]) await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [t, `Una verdad ${t} (test)`, `una-verdad-${t}-test`]);
  h = await getTestAuthHeaders('test-una-verdad', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  hOtra = await getTestAuthHeaders('test-una-verdad-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  await cleanup();
  const ids = await empresa(T, Object.values(PERS));
  await empresa(OTRA, [SIN_REGIMEN]);
  // Régimen de la empresa T: mínimo 30 min, tope 300 min por mes, lo que pasa
  // el tope NO se computa. La "fuente" vieja guardada como "solo marcadores":
  // ya no se usa (punto F), y como nadie marca, si se usara daría 0.
  const [c] = await db.query(`INSERT INTO labor_conventions (tenant_id, name) VALUES (?, 'Convenio una verdad (test)')`, [T]);
  for (const id of Object.values(ids)) {
    await db.query(`INSERT INTO employee_convention_assignments (employee_id, tenant_id, convention_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [id, T, c.insertId]);
  }
  await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos, politica_excedente, minimo_minutos, fuente)
                  VALUES (?, ?, '2026-01-01', 300, 'NO_COMPUTAR', 30, 'MARCADORES')`, [T, c.insertId]);
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-una-verdad');
  await deleteTestUser('test-una-verdad-otra');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

const pedir = async (ruta, headers = h, metodo = 'GET', body) => {
  const r = await fetch(URL + ruta, { method: metodo, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(r.status, 200, `${ruta}: ${r.status}`);
  return r.json();
};
const rango = (from, to, extra = '', headers = h) => pedir(`/attendance-range?from=${from}&to=${to}${extra}`, headers);
const fila = (j, legajo) => j.data.find((x) => String(x.employeeId) === String(legajo));
const minutos = (row) => row.overtimeMinutes;

test('el día ya viene recortado por la plantilla: solo lo de después de las 20 (nunca la jornada de 16 a 20)', async () => {
  const d = (await rango('2026-09-01', '2026-09-30', `&employeeId=${SIN_REGIMEN.legajo}`, hOtra)).data[0].days.find((x) => x.date === HABILES[0]);
  assert.equal(d.overtimeMinutes, 60);
});

test('listado = detalle = suma de los días del calendario (con y sin régimen)', async () => {
  for (const [legajo, headers] of [[PERS.hora.legajo, h], [PERS.poca.legajo, h], [SIN_REGIMEN.legajo, hOtra]]) {
    const listado = fila(await rango('2026-09-01', '2026-09-30', '', headers), legajo);
    const detalle = (await rango('2026-09-01', '2026-09-30', `&employeeId=${legajo}`, headers)).data[0];
    const suma = detalle.days.reduce((a, d) => a + (d.overtimeMinutes || 0), 0);
    assert.equal(minutos(listado), minutos(detalle), `listado vs detalle ${legajo}`);
    assert.equal(suma, minutos(detalle), `suma de días vs total ${legajo}`);
    assert.equal(Number(listado.overtimeHours), Number((minutos(listado) / 60).toFixed(2)));
  }
});

test('régimen: el tope mensual (300) y el mínimo (30) se ven igual en el total y en cada día', async () => {
  const det = (await rango('2026-09-01', '2026-09-30', `&employeeId=${PERS.hora.legajo}`)).data[0];
  assert.equal(minutos(det), 300, '5 días de 60 entran en el tope; el resto no se computa');
  assert.equal(det.regimenHorasExtra.reales, 60 * HABILES.length);
  assert.equal(det.regimenHorasExtra.excedente, 60 * HABILES.length - 300);
  const conHE = det.days.filter((d) => d.overtimeMinutes > 0).map((d) => d.date);
  assert.deepEqual(conHE, HABILES.slice(0, 5), 'los primeros 5 días hábiles, en orden');
  const poca = (await rango('2026-09-01', '2026-09-30', `&employeeId=${PERS.poca.legajo}`)).data[0];
  assert.equal(minutos(poca), 0);
  const d = poca.days.find((x) => x.date === HABILES[0]);
  assert.deepEqual([d.overtimeMinutes, d.overtimeBelowMinimumMinutes, d.overtimeMinimumMinutes], [0, 20, 30], 'el calendario dice por qué no suma');
});

test('punto F: la "fuente" vieja del régimen ya no cambia nada (cuenta lo mismo que Presentismo)', async () => {
  const det = (await rango('2026-09-01', '2026-09-30', `&employeeId=${PERS.hora.legajo}`)).data[0];
  assert.ok(det.regimenHorasExtra.reales > 0, 'con "solo marcadores" y sin marcas daría 0');
});

test('quincenas y semanas = su parte del mes (el tope se reparte sobre el mes entero)', async () => {
  const mes = await rango('2026-09-01', '2026-09-30');
  const q1 = await rango('2026-09-01', '2026-09-15');
  const q2 = await rango('2026-09-16', '2026-09-30');
  for (const p of Object.values(PERS)) {
    assert.equal(minutos(fila(q1, p.legajo)) + minutos(fila(q2, p.legajo)), minutos(fila(mes, p.legajo)), `quincenas ${p.legajo}`);
  }
  // La 2da quincena de quien ya llenó el tope en la 1ra: 0 (pedida sola, antes "no llegaba" al tope y daba 60 por día).
  assert.equal(minutos(fila(q2, PERS.hora.legajo)), 0);
  const det = (await rango('2026-09-01', '2026-09-30', `&employeeId=${PERS.hora.legajo}`)).data[0];
  const semana = await rango('2026-09-07', '2026-09-13');
  const enElMes = det.days.filter((d) => d.date >= '2026-09-07' && d.date <= '2026-09-13').reduce((a, d) => a + d.overtimeMinutes, 0);
  assert.equal(minutos(fila(semana, PERS.hora.legajo)), enElMes, 'semana = esos días del mes');
});

test('Liquidación (en vivo) = Presentismo, al minuto', async () => {
  const liq = await pedir('/api/liquidacion-horas-extra?periodo=2026-09');
  const mes = await rango('2026-09-01', '2026-09-30');
  for (const p of Object.values(PERS)) {
    const f = liq.filas.find((x) => String(x.legajo) === String(p.legajo));
    assert.equal(f ? f.aLiquidar : 0, minutos(fila(mes, p.legajo)), `liquidación ${p.legajo}`);
  }
});

test('Días a revisar: un día que el régimen no cuenta (bajo su mínimo) no aparece', async () => {
  const j = await pedir('/api/horas-extra-revisar?from=2026-09-01&to=2026-09-30');
  assert.ok(!j.dias.some((d) => String(d.legajo) === String(PERS.poca.legajo)));
});

test('vista previa = lo que pasa al guardar (mínimo de la empresa): no toca a quien tiene mínimo propio', async () => {
  const prev = await pedir(`/config/minimo-horas-extra/impacto?minutos=90&from=2026-09-01&to=2026-09-30`, hOtra);
  assert.equal(prev.dias, HABILES.length, 'sin régimen: todos sus días de 60 dejarían de contar');
  assert.equal(prev.minutosQueDejanDeContar, 60 * HABILES.length);
  const antes = minutos(fila(await rango('2026-09-01', '2026-09-30', '', hOtra), SIN_REGIMEN.legajo));
  await pedir('/config/minimo-horas-extra', hOtra, 'POST', { minutos: 90 });
  const despues = minutos(fila(await rango('2026-09-01', '2026-09-30', '', hOtra), SIN_REGIMEN.legajo));
  assert.equal(antes - despues, prev.minutosQueDejanDeContar, 'la vista previa dijo exactamente lo que pasó');
  await pedir('/config/minimo-horas-extra', hOtra, 'POST', { minutos: '' });
  // En la empresa con régimen, quien tiene mínimo propio (30) no cambia.
  const prevT = await pedir(`/config/minimo-horas-extra/impacto?minutos=90&from=2026-09-01&to=2026-09-30`);
  assert.equal(prevT.dias, 0);
});

test('vista previa del método = lo que pasa al guardarlo', async () => {
  const prev = await pedir(`/api/config-horas-extra/impacto?metodo=MARCAS&from=2026-09-01&to=2026-09-30`, hOtra);
  assert.equal(prev.minutosHoy - prev.minutosCon, 60 * HABILES.length, 'solo marcas y nadie marca: todo deja de contar');
  await pedir('/api/config-horas-extra/empresa', hOtra, 'POST', { metodo: 'MARCAS', contarLlegadaAnticipada: false });
  assert.equal(minutos(fila(await rango('2026-09-01', '2026-09-30', '', hOtra), SIN_REGIMEN.legajo)), 0);
  await pedir('/api/config-horas-extra/empresa', hOtra, 'POST', { metodo: 'EXCESO', contarLlegadaAnticipada: false });
  assert.equal(minutos(fila(await rango('2026-09-01', '2026-09-30', '', hOtra), SIN_REGIMEN.legajo)), 60 * HABILES.length);
});

test('desde afuera no se puede pedir un cálculo "simulado"', async () => {
  const normal = await rango('2026-09-01', '2026-09-30', '', hOtra);
  const truco = await rango('2026-09-01', '2026-09-30', '&simularMetodoHE=MARCAS&simularMinimoEmpresaHE=200&heDias=1&regimenDias=1', hOtra);
  assert.equal(minutos(fila(truco, SIN_REGIMEN.legajo)), minutos(fila(normal, SIN_REGIMEN.legajo)));
  assert.equal(truco.heDias, undefined);
  assert.equal(truco.regimenDias, undefined);
});
