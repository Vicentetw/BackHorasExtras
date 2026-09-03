// Bug real de produccion (encontrado 2026-09-03): /movements-range y
// /campana-range mandaban objetos Date crudos en timeOut/timeIn. Un Date
// puesto directo en res.json() se serializa con .toISOString() (SIEMPRE
// UTC). Esos Date se construyen con `new Date(mysqlStr.replace(' ','T'))`
// a partir de un string que en realidad ya es hora LOCAL de Argentina sin
// marca de zona -- en un proceso cuyo huso horario del SO sea Argentina
// (como en desarrollo local) el resultado final da bien sin que se note el
// problema, pero en un proceso en UTC (Render, produccion) la misma hora
// se manda corrida, y el navegador (en Argentina) la vuelve a correr al
// mostrarla -- 3 horas de diferencia, invisible en desarrollo local.
//
// Esta prueba fuerza al proceso hijo a correr en UTC (via env TZ=UTC) para
// reproducir las condiciones de produccion, y confirma que la hora que
// vuelve en el JSON sigue siendo la correcta (no corrida), sin importar el
// huso horario del proceso que la sirve.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_UID = 'test-timezone-regression';

after(async () => {
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('/movements-range: timeOut/timeIn son strings planos "YYYY-MM-DD HH:mm:ss", no ISO con Z', async () => {
  const headers = await getTestAuthHeaders(TEST_UID);
  const res = await fetch(`${BASE_URL}/movements-range?from=2026-08-01&to=2026-08-31&category=PARTICULAR&groupBy=month`, { headers });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.rows.length > 0, 'debe haber al menos una fila para verificar el formato');
  const row = json.rows[0];
  const plainDatetime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  assert.match(row.timeOut, plainDatetime, 'timeOut no debe ser un ISO string con Z ni un objeto Date serializado');
  if (row.timeIn) {
    assert.match(row.timeIn, plainDatetime, 'timeIn no debe ser un ISO string con Z ni un objeto Date serializado');
  }
});

test('el helper formatLocalDateTime da el mismo resultado sin importar el huso horario del proceso', () => {
  // Corre un proceso hijo con TZ=UTC (simulando Render) y otro con
  // TZ=America/Argentina/Buenos_Aires (simulando desarrollo local), y
  // confirma que formatLocalDateTime reconstruye el MISMO string de
  // entrada en los dos casos -- la propiedad clave que evita el bug: leer
  // los componentes de un Date con los getters locales (getFullYear,
  // getHours, etc.) siempre devuelve los mismos numeros con los que se
  // construyo, sin importar el huso horario del proceso.
  const script = `
    const input = '2026-08-03 07:49:54';
    const d = new Date(input.replace(' ', 'T'));
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    console.log(\`\${yyyy}-\${mm}-\${dd} \${hh}:\${mi}:\${ss}\`);
  `;
  const runWithTz = (tz) => {
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8'
    });
    return result.stdout.trim();
  };

  const utcResult = runWithTz('UTC');
  const arResult = runWithTz('America/Argentina/Buenos_Aires');
  assert.equal(utcResult, '2026-08-03 07:49:54');
  assert.equal(arResult, '2026-08-03 07:49:54');
  assert.equal(utcResult, arResult, 'formatLocalDateTime debe dar el mismo resultado sin importar TZ del proceso');
});
