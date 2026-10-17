// Mínimo de horas extra por día (motor-laboral/services/minimoHorasExtra.js).
// Requiere el backend local corriendo. Tenants descartables 999987 / 999988.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { aplicar, normalizar } = require('../motor-laboral/services/minimoHorasExtra');

const URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const T = 999987;
const OTRA = 999988;
const DIA = '2026-09-07'; // lunes
const PERMISOS = ['attendance:read', 'schedules:read', 'schedules:update'];
let h, hOtra;
const L = { corta: 987001, larga: 987002 };
const LO = { corta: 988001 };

async function cleanup() {
  for (const t of [T, OTRA]) {
    await db.query("DELETE FROM app_settings WHERE tenant_id = ? AND name = 'overtimeMinimumMinutes'", [t]);
    await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id = ?', [t]).catch(() => {});
    await db.query('DELETE FROM Checkins WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM user_employee_map WHERE tenant_id = ?', [t]);
    await db.query('DELETE FROM users WHERE tenant_id = ?', [t]);
    await db.query('DELETE c FROM employee_work_calendars c JOIN employees e ON e.id = c.employee_id WHERE e.tenant_id = ?', [t]);
    await db.query('DELETE FROM employees WHERE tenant_id = ?', [t]);
    await db.query('DELETE b FROM shift_blocks b JOIN work_schedule_templates w ON w.id = b.template_id WHERE w.tenant_id = ?', [t]);
    await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ?', [t]);
  }
}

async function empresa(t, legajos) {
  const [tp] = await db.query(`INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, overtime_cutoff_time) VALUES (?, 'HE desde 15 (test)', 'FIXED', 1, 1, '15:00:00')`, [t]);
  await db.query(`INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, 1, 'Jornada', '07:00:00', '14:00:00', 'WORK', 1)`, [tp.insertId]);
  for (const [legajo, salida] of legajos) {
    const [e] = await db.query('INSERT INTO employees (employee_id, nombre, tenant_id, exclude_from_report, activo) VALUES (?, ?, ?, 0, 1)', [legajo, `L${legajo} (test)`, t]);
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [legajo, t, String(legajo), `L${legajo}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'test')`, [legajo, t, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from) VALUES (?, ?, ?, '2026-01-01')`, [e.insertId, t, tp.insertId]);
    for (const hora of ['07:05:00', salida]) await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME) VALUES (?, ?, ?)', [legajo, t, `${DIA} ${hora}`]);
  }
}

before(async () => {
  for (const t of [T, OTRA]) await db.query('INSERT INTO tenants (id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [t, `Minimo HE ${t} (test)`, `minimo-he-${t}-test`]);
  h = await getTestAuthHeaders('test-minimo-he', { isSuperadmin: false, tenantId: T, permissions: PERMISOS });
  hOtra = await getTestAuthHeaders('test-minimo-he-otra', { isSuperadmin: false, tenantId: OTRA, permissions: PERMISOS });
  await cleanup();
  // 15:00 + 8 min = estimada corta; 17:00 = 120 min.
  await empresa(T, [[L.corta, '15:08:00'], [L.larga, '17:00:00']]);
  await empresa(OTRA, [[LO.corta, '15:08:00']]);
});

after(async () => {
  await cleanup();
  await deleteTestUser('test-minimo-he');
  await deleteTestUser('test-minimo-he-otra');
  await db.query('DELETE FROM tenants WHERE id IN (?, ?)', [T, OTRA]);
  await closeDb();
});

const pedir = (metodo, ruta, body, headers = h) => fetch(URL + ruta, {
  method: metodo, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
async function dia(legajo, headers = h) {
  const j = await (await pedir('GET', `/attendance-range?from=${DIA}&to=${DIA}&employeeId=${legajo}`, null, headers)).json();
  const fila = j.data.find((x) => String(x.employeeId) === String(legajo));
  return { fila, d: fila.days.find((x) => x.date === DIA) };
}

test('aplicar (pura)', () => {
  assert.deepEqual(aplicar(8, 10), { minutos: 0, bajoMinimo: 8 });
  assert.deepEqual(aplicar(10, 10), { minutos: 10, bajoMinimo: 0 }, 'justo el mínimo sí cuenta');
  assert.deepEqual(aplicar(8, null), { minutos: 8, bajoMinimo: 0 }, 'sin mínimo: como siempre');
  assert.deepEqual(aplicar(0, 10), { minutos: 0, bajoMinimo: 0 });
  assert.equal(normalizar(''), null);
  assert.equal(normalizar('15'), 15);
  assert.equal(normalizar(999), null);
});

test('sin mínimo: todo como siempre', async () => {
  assert.equal((await dia(L.corta)).d.overtimeMinutes, 8);
  assert.equal((await dia(L.larga)).d.overtimeMinutes, 120);
  const cfg = await (await pedir('GET', '/config/minimo-horas-extra')).json();
  assert.equal(cfg.minutos, null);
});

test('vista previa antes de guardar: con 10 min, 1 día de 1 persona (8 min)', async () => {
  const j = await (await pedir('GET', `/config/minimo-horas-extra/impacto?minutos=10&from=2026-09-01&to=2026-09-30`)).json();
  assert.deepEqual([j.dias, j.personas, j.minutosQueDejanDeContar, j.estimadas], [1, 1, 8, 1]);
});

test('con mínimo 10: el día de 8 min no suma y queda a la vista; el de 120 sigue igual', async () => {
  assert.equal((await pedir('POST', '/config/minimo-horas-extra', { minutos: 10 })).status, 200);
  const c = await dia(L.corta);
  assert.equal(c.d.overtimeMinutes, 0);
  assert.equal(c.d.overtimeBelowMinimumMinutes, 8);
  assert.equal(c.d.overtimeMinimumMinutes, 10);
  assert.equal(Number(c.fila.overtimeHours), 0);
  assert.equal((await dia(L.larga)).d.overtimeMinutes, 120);
});

test('aislamiento: el mínimo de una empresa no toca a otra', async () => {
  assert.equal((await dia(LO.corta, hOtra)).d.overtimeMinutes, 8);
});

test('con máximos de horas extra: sin mínimo propio vale el de la empresa; con mínimo propio, el suyo', async () => {
  let ok = true;
  try {
    await db.query(`INSERT INTO overtime_regime_policies (tenant_id, convention_id, vigente_desde, tope_mes_minutos, politica_excedente) VALUES (?, NULL, '2026-01-01', 6000, 'AVISAR')`, [T]);
  } catch { ok = false; }
  if (!ok) return; // base sin la tabla de políticas: no aplica
  assert.equal(Number((await dia(L.corta)).fila.overtimeHours), 0, 'mínimo de la empresa (10) en el cálculo por régimen');
  await db.query('UPDATE overtime_regime_policies SET minimo_minutos = 5 WHERE tenant_id = ?', [T]);
  assert.equal(Number((await dia(L.corta)).fila.overtimeHours), Number((8 / 60).toFixed(2)), 'el mínimo propio (5) gana');
  await db.query('DELETE FROM overtime_regime_policies WHERE tenant_id = ?', [T]);
});

test('validación y volver a "sin mínimo"', async () => {
  assert.equal((await pedir('POST', '/config/minimo-horas-extra', { minutos: 500 })).status, 400);
  assert.equal((await pedir('POST', '/config/minimo-horas-extra', { minutos: '' })).status, 200);
  assert.equal((await dia(L.corta)).d.overtimeMinutes, 8);
});
