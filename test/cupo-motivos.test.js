// Cupo por motivo -- reglas de RRHH del calculo puro (cupoMotivos.js).
// Sin base ni servidor: corre tambien en el CI de logica.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { periodoAnual, cupoVigente, calcularConsumo, evaluarCupo } = require('../motor-laboral/services/cupoMotivos');

const ANIO = { desde: '2026-01-01', hasta: '2026-12-31' };
const HABILES = [{ modo: 'habiles', vigente_desde: '2000-01-01' }];
const sinFeriados = { fechas: new Set(), recurrentesMesDia: new Set() };
const consumo = (p) => calcularConsumo({
  periodo: ANIO, licencias: [], justificaciones: [], diasFichados: new Set(),
  vigenciasModo: HABILES, feriados: sinFeriados, ...p,
});

test('cuenta licencias y justificaciones de dia completo', () => {
  const c = consumo({
    licencias: [{ fecha_desde: '2026-03-02', fecha_hasta: '2026-03-03' }], // lun-mar
    justificaciones: ['2026-03-10'],
  });
  assert.equal(c.usados, 3);
});

test('un dia que FICHÓ no consume cupo (articulo 55 cargado pero vino a trabajar)', () => {
  const c = consumo({ justificaciones: ['2026-06-29'], diasFichados: new Set(['2026-06-29']) });
  assert.equal(c.usados, 0);
  assert.equal(c.detalle[0].porQueNo, 'fichó ese día');
});

test('vuelve antes de terminar las vacaciones: los dias fichados no se descuentan', () => {
  const c = consumo({
    licencias: [{ fecha_desde: '2026-07-06', fecha_hasta: '2026-07-10' }], // lun a vie
    diasFichados: new Set(['2026-07-09', '2026-07-10']),
  });
  assert.equal(c.usados, 3);
});

test('el mismo dia como licencia Y como justificacion cuenta una sola vez', () => {
  const c = consumo({
    licencias: [{ fecha_desde: '2026-07-01', fecha_hasta: '2026-07-01' }],
    justificaciones: ['2026-07-01'],
  });
  assert.equal(c.usados, 1);
  assert.deepEqual(c.detalle[0].origen.sort(), ['justificacion', 'licencia']);
});

test('en dias habiles no cuentan fin de semana ni feriados; en corridos si', () => {
  const lic = [{ fecha_desde: '2026-05-22', fecha_hasta: '2026-05-26' }]; // vie a mar, 25/05 feriado
  const feriados = { fechas: new Set(['2026-05-25']), recurrentesMesDia: new Set() };
  assert.equal(consumo({ licencias: lic, feriados }).usados, 2); // vie 22 y mar 26
  assert.equal(consumo({ licencias: lic, feriados, vigenciasModo: [] }).usados, 5); // corridos
});

test('solo cuenta lo que cae dentro del periodo', () => {
  const c = consumo({ licencias: [{ fecha_desde: '2025-12-30', fecha_hasta: '2026-01-02' }], vigenciasModo: [] });
  assert.equal(c.usados, 2); // 01 y 02 de enero
});

test('la carga nueva se proyecta aparte, sin duplicar un dia ya cargado', () => {
  const c = consumo({ justificaciones: ['2026-03-10'], nuevo: { desde: '2026-03-10', hasta: '2026-03-11' } });
  assert.equal(c.usados, 1);
  assert.equal(c.usadosConNuevo, 2);
});

test('periodo calendario y aniversario de ingreso', () => {
  assert.deepEqual(periodoAnual('2026-06-29', 'calendario', '2015-09-14'), { desde: '2026-01-01', hasta: '2026-12-31' });
  assert.deepEqual(periodoAnual('2026-06-29', 'aniversario', '2015-09-14'), { desde: '2025-09-14', hasta: '2026-09-13' });
  assert.deepEqual(periodoAnual('2026-10-01', 'aniversario', '2015-09-14'), { desde: '2026-09-14', hasta: '2027-09-13' });
  assert.deepEqual(periodoAnual('2026-06-29', 'aniversario', null), { desde: '2026-01-01', hasta: '2026-12-31' }, 'sin ingreso: calendario');
});

test('la regla de cupo vigente sale del historial por fecha', () => {
  const cupos = [{ max_dias_anio: 6, vigente_desde: '2020-01-01' }, { max_dias_anio: 8, vigente_desde: '2027-01-01' }];
  assert.equal(cupoVigente('2026-06-01', cupos).max_dias_anio, 6);
  assert.equal(cupoVigente('2027-02-01', cupos).max_dias_anio, 8);
  assert.equal(cupoVigente('2019-01-01', cupos), null);
});

test('articulo 55 con 6 por año: el 7mo dia es exceso', () => {
  const justificaciones = ['2026-02-02', '2026-03-02', '2026-04-06', '2026-05-04', '2026-06-01', '2026-07-06'];
  const c = consumo({ justificaciones, nuevo: { desde: '2026-08-03', hasta: '2026-08-03' } });
  assert.equal(c.usados, 6);
  assert.deepEqual(evaluarCupo({ max_dias_anio: 6 }, c), ['supera el tope anual: quedaría en 7 de 6']);
  assert.deepEqual(evaluarCupo({ max_dias_anio: 7 }, c), []);
});

test('tope mensual: solo frena el mes que la carga nueva pasa', () => {
  const c = consumo({
    justificaciones: ['2026-03-02', '2026-03-03', '2026-03-04'], // marzo ya estaba en 3
    nuevo: { desde: '2026-04-06', hasta: '2026-04-07' },
  });
  assert.deepEqual(evaluarCupo({ max_dias_mes: 2 }, c), [], 'abril queda en 2: no es exceso aunque marzo ya este pasado');
  const c2 = consumo({ justificaciones: ['2026-04-01', '2026-04-02'], nuevo: { desde: '2026-04-06', hasta: '2026-04-06' } });
  assert.deepEqual(evaluarCupo({ max_dias_mes: 2 }, c2), ['supera el tope de 2026-04: quedaría en 3 de 2']);
});

test('sin cupo configurado nunca hay exceso', () => {
  assert.deepEqual(evaluarCupo(null, consumo({ justificaciones: ['2026-01-05'] })), []);
});
