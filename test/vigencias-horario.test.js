// Asignaciones de horario superpuestas (motor-laboral/services/vigenciasHorario.js):
// qué rige, cómo normalizar sin cambiar nada, y cómo reemplazar. Sin base.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tramosVigentes, normalizar, rigeEl, planReemplazo, sumarDias, mismoContenido } = require('../motor-laboral/services/vigenciasHorario');

const fila = (id, template_id, valid_from, valid_to = null, cycle_start_date = null) => ({ id, template_id, valid_from, valid_to, cycle_start_date });

// Aplica las operaciones de normalizar() sobre una copia, como lo hace el script.
function aplicar(filas, ops) {
  let r = filas.map((f) => ({ ...f }));
  let nuevo = 1000;
  for (const op of ops) {
    if (op.tipo === 'borrar') r = r.filter((f) => f.id !== op.fila.id);
    else if (op.tipo === 'recortar') Object.assign(r.find((f) => f.id === op.fila.id), { valid_from: op.desde, valid_to: op.hasta });
    else r.push({ ...op.fila, id: nuevo++, valid_from: op.desde, valid_to: op.hasta });
  }
  return r;
}
// Lo que rige cada día de un período, para comparar antes y después.
function regimen(filas, desde, hasta) {
  const out = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
    const g = rigeEl(filas, d);
    out.push(g === null ? '-' : g === 'empate' ? 'E' : g.template_id);
  }
  return out.join(',');
}

test('rige la que empezó más tarde: la anterior queda con los días que nadie tapa', () => {
  const [vieja, nueva] = tramosVigentes([fila(1, 10, '2026-01-01', '2026-12-31'), fila(2, 20, '2026-03-01', '2026-03-31')]);
  assert.deepEqual(vieja.tramos, [['2026-01-01', '2026-02-28'], ['2026-04-01', '2026-12-31']]);
  assert.deepEqual(nueva.tramos, [['2026-03-01', '2026-03-31']]);
});

test('normalizar el caso real de AVP (legajo con 8 asignaciones): no cambia lo que rige ningún día', () => {
  const filas = [
    fila(1, 13, '2024-07-08', '2026-09-16'), fila(2, 13, '2024-07-08', '2026-09-16'), fila(3, 13, '2024-07-08', '2026-09-16'),
    fila(4, 13, '2012-09-16', '2026-09-16'),
    fila(5, 15, '2026-09-17', '2026-09-28'), fila(6, 15, '2023-02-01', '2026-09-28'),
    fila(7, 17, '2026-09-29'), fila(8, 17, '2026-01-01'),
  ];
  const ops = normalizar(filas);
  assert.deepEqual(ops.filter((o) => o.tipo === 'borrar').map((o) => o.fila.id), [2, 3], 'las dos copias exactas');
  const despues = aplicar(filas, ops);
  assert.equal(regimen(despues, '2012-09-10', '2026-12-31'), regimen(filas, '2012-09-10', '2026-12-31'));
  // Y ya no se superponen: cada día lo cubre una sola.
  for (let d = '2012-09-16'; d <= '2026-12-31'; d = sumarDias(d, 365)) {
    assert.ok(despues.filter((f) => f.valid_from <= d && (f.valid_to === null || f.valid_to >= d)).length <= 1, d);
  }
});

test('normalizar parte en dos la que tiene otra en el medio', () => {
  const filas = [fila(1, 10, '2026-01-01'), fila(2, 20, '2026-03-01', '2026-03-31')];
  const ops = normalizar(filas);
  assert.deepEqual(ops.map((o) => [o.tipo, o.fila.id, o.desde, o.hasta]), [
    ['recortar', 1, '2026-01-01', '2026-02-28'],
    ['agregar', 1, '2026-04-01', null],
  ]);
  assert.equal(regimen(aplicar(filas, ops), '2025-12-01', '2026-06-30'), regimen(filas, '2025-12-01', '2026-06-30'));
});

test('empate (dos distintas empiezan el mismo día): no se toca', () => {
  const filas = [fila(1, 10, '2026-04-01', '2026-04-20'), fila(2, 20, '2026-04-01', '2026-04-30')];
  assert.deepEqual(normalizar(filas), []);
  assert.equal(rigeEl(filas, '2026-04-05'), 'empate');
});

test('sin superposiciones: no hay nada que hacer', () => {
  assert.deepEqual(normalizar([fila(1, 10, '2026-01-01', '2026-03-31'), fila(2, 20, '2026-04-01')]), []);
});

test('el día 1 de un ciclo rotativo es parte del contenido: no son copias si cambia', () => {
  assert.equal(mismoContenido(fila(1, 10, '2026-01-01', null, '2026-01-01'), fila(2, 10, '2026-01-01', null, '2026-01-03')), false);
});

test('reemplazar: borra lo que queda adentro, acorta, corre y parte', () => {
  const ops = planReemplazo([
    fila(1, 10, '2026-01-01'),
    fila(2, 20, '2026-04-05', '2026-04-10'),
    fila(3, 30, '2026-04-25', '2026-05-31'),
    fila(4, 40, '2025-01-01', '2025-12-31'),
  ], '2026-04-01', '2026-04-30');
  assert.deepEqual(ops.map((o) => [o.tipo, o.fila.id]), [['partir', 1], ['borrar', 2], ['correr', 3]]);
  assert.deepEqual([ops[0].nuevoFin, ops[0].restoDesde, ops[0].restoFin], ['2026-03-31', '2026-05-01', null]);
  assert.equal(ops[2].nuevoDesde, '2026-05-01');
  const sinFin = planReemplazo([fila(1, 10, '2026-01-01'), fila(5, 50, '2026-06-01')], '2026-04-01', null);
  assert.deepEqual(sinFin.map((o) => [o.tipo, o.fila.id]), [['acortar', 1], ['borrar', 5]]);
});
