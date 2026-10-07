// "Fuera de su horario" (motor-laboral/services/fueraDeHorario.js): reglas
// puras, sin base. Casos reales de AVP del 07/10/2026.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluarFueraDeHorario: evaluar } = require('../motor-laboral/services/fueraDeHorario');

const ADMIN = { esDiaDeTrabajo: true, entrada: '07:00:00', salida: '13:40:00', plantilla: 'Administración', umbralMinutos: 60 };

test('BELCARO 2107: fichó 05:08 y 05:08 con plantilla de 07:00 a 13:40 -> no coincide', () => {
  const r = evaluar({ ...ADMIN, fichajes: ['05:08', '05:08'] });
  assert.equal(r.tipo, 'no_coincide');
  assert.match(r.texto, /05:08, 05:08/);
  assert.match(r.texto, /Administración/);
});

test('AGUILAR 3056: plantilla de 15 a 23, fichó 07:04 (salida de su noche) -> no coincide', () => {
  const r = evaluar({ esDiaDeTrabajo: true, entrada: '15:00', salida: '23:00', plantilla: 'turno de 15 a 23', umbralMinutos: 60, fichajes: ['07:04', '07:04'] });
  assert.equal(r.tipo, 'no_coincide');
});

test('llegó mucho antes pero se fue a su hora -> antes, con los minutos', () => {
  const r = evaluar({ ...ADMIN, fichajes: ['05:30', '13:41'] });
  assert.deepEqual([r.tipo, r.minutos], ['antes', 90]);
  assert.match(r.texto, /1 h 30 min antes/);
});

test('un dia normal no avisa: a horario, unos minutos antes, o tarde (eso ya es "Tarde")', () => {
  assert.equal(evaluar({ ...ADMIN, fichajes: ['06:52', '13:45'] }), null);
  assert.equal(evaluar({ ...ADMIN, fichajes: ['06:10', '13:40'] }), null, '50 min antes, dentro del umbral');
  assert.equal(evaluar({ ...ADMIN, fichajes: ['09:30', '13:40'] }), null, 'llegó tarde: lo dice el estado');
});

test('dia sin turno en su plantilla (franco) con fichajes -> sin_turno; sin fichajes, nada', () => {
  assert.equal(evaluar({ ...ADMIN, esDiaDeTrabajo: false, fichajes: ['08:00', '12:00'] }).tipo, 'sin_turno');
  assert.equal(evaluar({ ...ADMIN, esDiaDeTrabajo: false, fichajes: [] }), null);
});

test('feriado, aviso apagado o sin horario: no se evalua', () => {
  assert.equal(evaluar({ ...ADMIN, esFeriado: true, fichajes: ['05:00'] }), null);
  assert.equal(evaluar({ ...ADMIN, umbralMinutos: null, fichajes: ['05:00'] }), null);
  assert.equal(evaluar({ ...ADMIN, entrada: null, salida: null, fichajes: ['05:00'] }), null);
});

test('turno que cruza medianoche: solo se compara la entrada', () => {
  const NOCHE = { esDiaDeTrabajo: true, entrada: '23:00', salida: '07:00', cruzaMedianoche: true, umbralMinutos: 60 };
  assert.equal(evaluar({ ...NOCHE, fichajes: ['22:53'] }), null, 'entró a horario');
  assert.equal(evaluar({ ...NOCHE, fichajes: ['15:02'] }).tipo, 'no_coincide', 'fichó a las 15: no es su turno');
});

test('acepta fecha y hora completas, como las manda el motor', () => {
  assert.equal(evaluar({ ...ADMIN, fichajes: ['2026-10-07 05:08:23', '2026-10-07 05:08:46'] }).tipo, 'no_coincide');
});
