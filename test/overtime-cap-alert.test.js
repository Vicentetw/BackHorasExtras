// Bug real reportado por el usuario: "el tope es una opcion solo para que
// salte un aviso en el detalle, superó límite diario" -- ANTES, /attendance-range
// usaba overtimeResult.cappedMinutes para el numero que se muestra/suma,
// TRUNCANDO el valor real de HE al tope configurado sin ningun aviso (si el
// tope era 6h y alguien hizo 8h reales, el sistema mostraba "6h" como si
// fuera el numero real). Esto viene asi desde el commit que introdujo el
// tope (9f41c0d, 2026-09-01) -- no es una regresion reciente, pero tampoco
// es el comportamiento que se pidio nunca: el tope es solo informativo.
//
// Los dias de prueba tienen HE automatica de fondo (datos reales del
// entorno de test, no un dia "limpio") -- se compara siempre contra una
// linea de base leida ANTES de tocar nada, mismo patron que ya usa
// manual-entries.test.js, en vez de asumir un valor absoluto.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const FULL_PERMS_UID = 'test-overtime-cap-alert-ci';
const LEGAJO_2525 = '2525';
const TENANT_ID = 6; // tenant real de legajo 2525 en la base de este entorno

let headers;
let userIdFor2525;
let originalCapMinutes;
const insertedManualIds = [];

async function fetchDay(testDate) {
  const rangeUrl = `${BASE_URL}/attendance-range?from=${testDate}&to=${testDate}&employeeId=${LEGAJO_2525}&tenantId=${TENANT_ID}`;
  const res = await fetch(rangeUrl, { headers });
  const json = await res.json();
  const emp = json.data.find((e) => String(e.employeeId) === LEGAJO_2525);
  assert.ok(emp, 'legajo 2525 debe aparecer en el reporte');
  const day = emp.days.find((d) => d.date === testDate);
  assert.ok(day, `el dia ${testDate} debe aparecer en el detalle`);
  return { day, overtimeCapMinutes: json.overtimeCapMinutes };
}

async function setCapMinutes(minutes) {
  const res = await fetch(`${BASE_URL}/config/overtime-settings?tenantId=${TENANT_ID}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overtimeCapMinutes: minutes })
  });
  assert.equal(res.status, 200);
}

before(async () => {
  const [[row]] = await db.query(
    `SELECT u.USERID FROM users u
     JOIN user_employee_map uem ON uem.USERID = u.USERID
     JOIN employees e ON e.id = uem.employee_id
     WHERE e.employee_id = ?`,
    [LEGAJO_2525]
  );
  userIdFor2525 = row ? row.USERID : null;
  headers = await getTestAuthHeaders(FULL_PERMS_UID, { isSuperadmin: true });

  const settingsRes = await fetch(`${BASE_URL}/config/overtime-settings?tenantId=${TENANT_ID}`, { headers });
  const settingsJson = await settingsRes.json();
  originalCapMinutes = settingsJson.overtimeCapMinutes;
});

after(async () => {
  if (originalCapMinutes) {
    await setCapMinutes(originalCapMinutes).catch(() => {});
  }
  if (insertedManualIds.length) {
    await db.query('DELETE FROM ManualEntries WHERE id IN (?)', [insertedManualIds]).catch(() => {});
  }
  await deleteTestUser(FULL_PERMS_UID);
  await closeDb();
});

test('un dia con HE real por encima del tope muestra el numero REAL (sin truncar) + aviso overtimeOverCap', async () => {
  assert.ok(userIdFor2525, 'legajo 2525 debe tener un USERID de reloj asociado para esta prueba');
  const testDate = '2026-08-18'; // martes habil (2026-08-17 es feriado San Martin, 08-16 es domingo)

  // Tope generoso primero, para leer la HE real de ese dia sin que nada la tape.
  await setCapMinutes(1440);
  const baseline = await fetchDay(testDate);
  const realMinutes = baseline.day.overtimeMinutes ?? 0;
  assert.ok(realMinutes > 0, 'este dia debe tener HE real de base para que la prueba tenga sentido');
  assert.equal(baseline.day.overtimeOverCap, false, 'con un tope generoso, no debe avisar');

  // Ahora un tope MENOR al valor real ya existente -- el numero mostrado
  // tiene que seguir siendo el real, con el aviso prendido (antes del fix,
  // esto hubiera truncado a capMinutes en vez de mostrar realMinutes).
  const capMinutes = realMinutes - 1;
  await setCapMinutes(capMinutes);
  const { day, overtimeCapMinutes } = await fetchDay(testDate);

  assert.equal(overtimeCapMinutes, capMinutes, 'el endpoint debe informar el tope configurado');
  assert.equal(day.overtimeMinutes, realMinutes, 'el numero mostrado/sumado debe seguir siendo el REAL, no truncado al tope');
  assert.equal(day.overtimeOverCap, true, 'debe avisar que ese dia supera el tope configurado');
});

test('una carga manual que sola supera el tope tambien dispara el aviso, sumada al total real', async () => {
  const testDate = '2026-08-19'; // miercoles habil

  await setCapMinutes(1440);
  const baseline = await fetchDay(testDate);
  const baselineMinutes = baseline.day.overtimeMinutes ?? 0;

  const manualMinutes = 180;
  const addRes = await fetch(`${BASE_URL}/add/manual`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: userIdFor2525,
      startDatetime: `${testDate} 20:00`,
      endDatetime: `${testDate} 23:00`,
      durationMinutes: manualMinutes,
      type: 'he',
      note: 'test tope como aviso, no como recorte'
    })
  });
  assert.equal(addRes.status, 200);
  const addJson = await addRes.json();
  insertedManualIds.push(addJson.id);

  const expectedTotal = baselineMinutes + manualMinutes;
  // Tope por debajo del total esperado -- debe avisar sin truncar.
  await setCapMinutes(Math.max(1, expectedTotal - 1));
  const overCapResult = await fetchDay(testDate);
  assert.equal(overCapResult.day.overtimeMinutes, expectedTotal, 'debe sumar automatico + manual, sin truncar al tope');
  assert.equal(overCapResult.day.overtimeOverCap, true);

  // Tope por encima del total esperado -- mismo total, sin aviso.
  await setCapMinutes(expectedTotal + 60);
  const underCapResult = await fetchDay(testDate);
  assert.equal(underCapResult.day.overtimeMinutes, expectedTotal);
  assert.equal(underCapResult.day.overtimeOverCap, false, 'con tope por encima del total, no debe avisar');
});
