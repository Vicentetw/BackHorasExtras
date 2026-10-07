// Plantillas rotativas: reglas puras (motor-laboral/services/cicloDeTurnos.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diaDelCiclo, esRotativa, bloquesDelCiclo, cruzaMedianoche } = require('../motor-laboral/services/cicloDeTurnos');

test('dia del ciclo: cuenta desde el dia 1, da la vuelta, y funciona para atras', () => {
  // 4x1 de AGUILAR: dia 1 = 15/06/2026.
  assert.equal(diaDelCiclo('2026-06-15', '2026-06-15', 5), 1);
  assert.equal(diaDelCiclo('2026-06-19', '2026-06-15', 5), 5);
  assert.equal(diaDelCiclo('2026-06-20', '2026-06-15', 5), 1, 'vuelve a empezar');
  assert.equal(diaDelCiclo('2026-06-14', '2026-06-15', 5), 5, 'el dia anterior al dia 1 es el ultimo del ciclo');
  assert.equal(diaDelCiclo('2026-01-01', '2026-06-15', 5), 1 + ((((-165) % 5) + 5) % 5));
  // Cambio de horario de verano/invierno o meses de 31 dias no lo corren.
  assert.equal(diaDelCiclo('2026-12-31', '2026-01-01', 10), (364 % 10) + 1);
});

test('es rotativa solo con el modo Y el largo cargados', () => {
  assert.equal(esRotativa({ modo: 'ROTATIVO', cycle_length: 5 }), true);
  assert.equal(esRotativa({ modo: 'ROTATIVO', cycle_length: null }), false, 'sin largo no se trata como ciclo');
  assert.equal(esRotativa({ modo: 'SEMANAL', cycle_length: 5 }), false);
  assert.equal(esRotativa({ type: 'FIXED' }), false, 'una plantilla de antes de la migracion');
});

test('bloques del dia: el turno del dia del ciclo, con sus tramos (partido) y la noche que cruza', () => {
  const datos = {
    ciclos: new Map([[7, new Map([[1, 10], [2, 20], [3, null]])]]),
    turnos: new Map([
      [10, { id: 10, nombre: 'Comercio', tramos: [{ inicio: '07:00:00', fin: '12:00:00', cruza_medianoche: 0 }, { inicio: '16:00:00', fin: '20:00:00', cruza_medianoche: 0 }] }],
      [20, { id: 20, nombre: 'Noche', tramos: [{ inicio: '23:00', fin: '07:00', cruza_medianoche: 1 }] }],
    ]),
  };
  const plantilla = { id: 7, modo: 'ROTATIVO', cycle_length: 3, valid_from: '2026-06-01', cycle_start_date: null };
  const d1 = bloquesDelCiclo(plantilla, '2026-06-01', datos);
  assert.equal(d1.dia, 1);
  assert.equal(d1.turno.nombre, 'Comercio');
  assert.deepEqual(d1.bloques.map((b) => [b.start_time, b.end_time, b.block_type]), [['07:00:00', '12:00:00', 'WORK'], ['16:00:00', '20:00:00', 'WORK']]);
  const d2 = bloquesDelCiclo(plantilla, '2026-06-02', datos);
  assert.deepEqual([d2.turno.nombre, d2.bloques[0].start_time, d2.bloques[0].crosses_midnight], ['Noche', '23:00:00', 1]);
  const d3 = bloquesDelCiclo(plantilla, '2026-06-03', datos);
  assert.deepEqual([d3.dia, d3.bloques.length, d3.turno], [3, 0, null], 'sin turno ese dia');
  // El "dia 1" de la asignacion manda sobre la fecha de inicio.
  assert.equal(bloquesDelCiclo({ ...plantilla, cycle_start_date: '2026-06-02' }, '2026-06-02', datos).dia, 1);
});

test('HE estimada en turno de noche: el corte es la salida del DIA SIGUIENTE', () => {
  const { computeDailyOvertime, corteAlDiaSiguiente } = require('../motor-laboral/services/overtimeCalculations');
  const noche = { timeEntrance: '23:00', timeExit: '07:00', blocks: [{ block_type: 'WORK', crosses_midnight: 1 }] };
  const dia = { timeEntrance: '07:00', timeExit: '15:00', blocks: [{ block_type: 'WORK', crosses_midnight: 0 }] };
  assert.equal(corteAlDiaSiguiente(noche, 420), true);
  assert.equal(corteAlDiaSiguiente(dia, 900), false, 'una plantilla diurna no cambia');
  assert.equal(corteAlDiaSiguiente(null, 900), false);
  const f = (s) => new Date(s);
  // Caso real de AGUILAR 01/06: entra 22:53, sale 07:10 -> 10 min a revisar (antes daba 1451).
  const r1 = computeDailyOvertime([f('2026-06-01T22:53:00'), f('2026-06-02T07:10:00')], { cutoffMinutes: 420, cutoffNextDay: true });
  assert.deepEqual([r1.minutes, r1.needsVerification], [10, true]);
  // Lecturas dobles (22:59 22:59 07:10 07:10): antes daba 492 desde las 22:59.
  const r2 = computeDailyOvertime(['22:59:00', '22:59:05', '07:10:00', '07:10:04'].map((h, i) => f(`2026-06-${i < 2 ? '16' : '17'}T${h}`)), { cutoffMinutes: 420, cutoffNextDay: true });
  assert.equal(r2.minutes, 10);
  // Se fue antes de las 07:00: no hay HE.
  assert.equal(computeDailyOvertime([f('2026-06-01T23:00:00'), f('2026-06-02T06:55:00')], { cutoffMinutes: 420, cutoffNextDay: true }), null);
  // Sale, vuelve a las 08:00 y se va a las 10:00: HE desde el reingreso, sin revisar.
  const r3 = computeDailyOvertime(['2026-06-01T23:00:00', '2026-06-02T07:05:00', '2026-06-02T08:00:00', '2026-06-02T10:00:00'].map(f), { cutoffMinutes: 420, cutoffNextDay: true });
  assert.deepEqual([r3.minutes, r3.needsVerification], [120, false]);
});

test('cruza medianoche: fin menor o igual que el inicio', () => {
  assert.equal(cruzaMedianoche('23:00', '07:00'), true);
  assert.equal(cruzaMedianoche('07:00', '15:00'), false);
  assert.equal(cruzaMedianoche('22:00', '22:00'), true);
});
