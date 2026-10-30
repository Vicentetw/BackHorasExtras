// Correcciones de fichajes (etapa G): la transformación en memoria que se le
// pasa al motor de marcadores, sobre el detectMovements REAL (sin tocarlo).
// Sin base ni servidor. Diseño: CORRECCIONES_FICHAJES.md (secciones 3 a
// 3 quater). La regla del dueño que más se cuida acá: los fichajes de un
// reloj nunca se mezclan con los de otro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mc = require('../motor-laboral/services/movementsCalculations');
const corr = require('../motor-laboral/services/correccionesFichajes');

const MARC = {
  6: { category: 'PARTICULAR', direction: 'SALIDA' }, 5: { category: 'PARTICULAR', direction: 'REGRESO' },
  9: { category: 'HE', direction: 'SALIDA' }, 10: { category: 'HE', direction: 'REGRESO' },
};
const deCategoria = (c) => Object.fromEntries(Object.entries(MARC).filter(([, m]) => m.category === c));
const t = (h) => new Date(`2026-10-01T${h}`);
// Fichaje de una persona: el número crudo del reloj es 1000 + legajo.
const F = (h, legajo, ip) => ({ checktime: t(h), userId: 1000 + Number(legajo), employeeId: String(legajo), machineIp: ip });
const M = (h, u, ip) => ({ checktime: t(h), userId: u, employeeId: null, machineIp: ip });
const f = (d) => (d ? mc.fechaHoraLocal(d).slice(11) : '-');

let siguienteId = 1;
// Correcciones activas, con la misma forma que devuelve leer().
function correcciones(...lista) {
  const activas = new Map();
  for (const [fila, accion, marcadorUserId = null] of lista) {
    const c = { id: siguienteId++, userid: fila.userId, time: mc.fechaHoraLocal(fila.checktime), machineIp: fila.machineIp,
      employeeId: fila.employeeId, accion, marcadorUserId };
    activas.set(corr.clave(c.userid, c.time), c);
  }
  return { activas, huerfanas: [], tabla: true };
}

// Lo que el motor le da a cada persona (sin las lecturas "de nadie").
function resultado(filas, cs = corr.SIN_CORRECCIONES) {
  const out = {};
  const entrada = corr.paraDeteccion(filas, cs);
  for (const c of ['PARTICULAR', 'HE']) {
    const r = mc.detectMovements(entrada, deCategoria(c), { maxMarkerGapMs: 6000, todosLosMarcadores: MARC });
    const add = (e, s) => { if (corr.esInterno(e)) return; (out[e] ||= []).push(`${c} ${s}`); };
    r.closedEvents.forEach((e) => add(e.employeeId, `${f(e.timeOut)}→${f(e.timeIn)} [${e.salidaMarkerUserId}/${e.regresoMarkerUserId}]`));
    for (const [k, e] of r.openEvents) add(k, `${f(e.timeOut)}→abierta [${e.salidaMarkerUserId}]`);
    r.orphanReturns.forEach((e) => add(e.employeeId, `→${f(e.timeIn)} sin salida [${e.regresoMarkerUserId}]`));
  }
  for (const k in out) out[k].sort();
  return out;
}
const sin = (o, legajo) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== String(legajo)));

test('sin correcciones: devuelve LA MISMA lista (ni siquiera una copia)', () => {
  const filas = [F('07:00:00', 1, '.30')];
  assert.equal(corr.paraDeteccion(filas, corr.SIN_CORRECCIONES), filas);
  assert.equal(corr.paraDeteccion(filas, correcciones()), filas);
  assert.equal(corr.paraHoras(filas, corr.SIN_CORRECCIONES), filas);
});

test('nunca modifica las filas que recibe', () => {
  const a = F('12:00:01', 1, '.30');
  const filas = [F('07:00:00', 1, '.30'), M('12:00:00', 6, '.30'), a];
  const copia = JSON.stringify(filas);
  corr.paraDeteccion(filas, correcciones([a, 'CAMBIAR_MARCADOR', 9]));
  assert.equal(JSON.stringify(filas), copia);
});

test('Santi 01/10: omitir los fichajes de 12:05 y 12:09 deja la salida real 12:04 → 15:06', () => {
  const a = F('12:05:12', 2616, '.30'), b = F('12:09:28', 2616, '.30');
  const dia = [
    F('06:54:59', 2616, '.30'),
    M('12:04:02', 6, '.30'), F('12:04:08', 2616, '.30'),
    M('12:05:06', 5, '.30'), a,
    M('12:09:22', 5, '.30'), b,
    M('15:06:08', 5, '.30'), F('15:06:14', 2616, '.30'),
    F('16:00:00', 77, '.30'),
  ];
  assert.deepEqual(resultado(dia)['2616'], ['PARTICULAR 12:04:08→12:05:12 [6/5]']);
  const r = resultado(dia, correcciones([a, 'OMITIR'], [b, 'OMITIR']));
  assert.deepEqual(r['2616'], ['PARTICULAR 12:04:08→15:06:14 [6/5]']);
  assert.deepEqual(sin(r, 2616), sin(resultado(dia), 2616), 'nadie más cambia');
});

test('quitar el marcador no une dos salidas: cualquier fichaje propio cierra la salida abierta', () => {
  const a = F('12:05:12', 2616, '.30');
  const dia = [F('06:54:59', 2616, '.30'), M('12:04:02', 6, '.30'), F('12:04:08', 2616, '.30'), M('12:05:06', 5, '.30'), a, F('15:06:14', 2616, '.30')];
  assert.deepEqual(resultado(dia, correcciones([a, 'QUITAR_MARCADOR']))['2616'], ['PARTICULAR 12:04:08→12:05:12 [6/null]']);
});

test('omitir: el fichaje queda en su reloj a nombre de nadie y se lleva el mismo marcador (no pasa al de atrás)', () => {
  const a = F('12:00:01', 1, '.30');
  const dia = [F('07:00:00', 1, '.30'), F('07:01:00', 2, '.30'), M('12:00:00', 6, '.30'), a, F('12:00:03', 2, '.30'), F('14:00:00', 2, '.30')];
  const r = resultado(dia, correcciones([a, 'OMITIR']));
  assert.deepEqual(sin(r, 1), sin(resultado(dia), 1));
  // Sacarlo de la lista sin más SÍ se lo pasaría: por eso no se hace así.
  const sacado = resultado(dia.filter((x) => x !== a));
  assert.notDeepEqual(sacado['2'], resultado(dia)['2']);
});

test('quitar el marcador: la persona sigue fichando, sin marcador, y nadie más lo recibe', () => {
  const a = F('12:00:01', 1, '.30');
  const dia = [F('07:00:00', 1, '.30'), F('07:00:00', 2, '.31'), M('12:00:00', 6, '.30'), a, F('12:00:02', 2, '.30'), F('14:00:00', 1, '.30'), F('14:00:00', 2, '.31')];
  assert.deepEqual(resultado(dia)['1'], ['PARTICULAR 12:00:01→14:00:00 [6/null]']);
  const r = resultado(dia, correcciones([a, 'QUITAR_MARCADOR']));
  assert.equal(r['1'], undefined);
  assert.deepEqual(sin(r, 1), sin(resultado(dia), 1));
  assert.equal(corr.paraHoras([{ USERID: 1001, CHECKTIME: '2026-10-01 12:00:01' }], correcciones([a, 'QUITAR_MARCADOR'])).length, 1, 'para las horas sigue contando');
});

test('cambiar el marcador: el elegido lleva la hora EXACTA del fichaje y es para ese fichaje', () => {
  const a = F('12:00:00', 1, '.30');
  const dia = [F('07:00:00', 1, '.30'), M('12:00:00', 6, '.30'), a, F('14:00:00', 1, '.30')];
  const cs = correcciones([a, 'CAMBIAR_MARCADOR', 9]);
  const sintetico = corr.paraDeteccion(dia, cs).find((x) => x.sintetico);
  assert.equal(+sintetico.checktime, +a.checktime, 'ninguna hora se mueve');
  assert.deepEqual(resultado(dia, cs)['1'], ['HE 12:00:00→14:00:00 [9/null]']);
});

test('dos fichajes de la misma persona en el mismo segundo, en dos relojes: se corrige solo el elegido', () => {
  const a = F('12:00:01', 1, '.30');
  const b = { ...F('12:00:01', 1, '.33'), userId: 5001 }; // otro número de reloj de la misma persona
  const dia = [F('07:00:00', 1, '.30'), M('12:00:00', 6, '.30'), a, b, F('14:00:00', 1, '.30')];
  const salida = corr.paraDeteccion(dia, correcciones([a, 'OMITIR']));
  assert.ok(salida.includes(b), 'el otro fichaje queda igual');
  assert.equal(salida.filter((x) => x.employeeId === '1').length, dia.filter((x) => x.employeeId === '1').length - 1);
});

test('correcciones sucesivas: deshacer vuelve exacto; la segunda equivale a hacerla de cero', () => {
  const a = F('12:00:01', 1, '.30');
  const dia = [F('07:00:00', 1, '.30'), M('12:00:00', 6, '.30'), a, M('13:59:58', 5, '.30'), F('14:00:00', 1, '.30')];
  assert.deepEqual(resultado(dia, correcciones()), resultado(dia));
  assert.deepEqual(resultado(dia, correcciones([a, 'CAMBIAR_MARCADOR', 9])), resultado(dia.map((x) => ({ ...x })), correcciones([a, 'CAMBIAR_MARCADOR', 9])));
});

test('multireloj: el 9 apretado en .33 nunca pasa a un fichaje de .30, con ninguna corrección', () => {
  const x = F('13:51:15', 1, '.30'), y = F('13:51:16', 2, '.33');
  const dia = [F('07:00:00', 1, '.30'), F('07:00:00', 2, '.33'), M('13:51:14', 9, '.33'), x, y, F('17:00:00', 1, '.30'), F('17:00:00', 2, '.33')];
  const antes = resultado(dia);
  assert.equal(antes['1'], undefined);
  assert.deepEqual(antes['2'], ['HE 13:51:16→17:00:00 [9/null]']);
  for (const accion of ['OMITIR', 'QUITAR_MARCADOR']) {
    assert.equal(resultado(dia, correcciones([y, accion]))['1'], undefined, `${accion} de Y: su 9 no salta de reloj`);
  }
  assert.deepEqual(resultado(dia, correcciones([x, 'CAMBIAR_MARCADOR', 6]))['2'], antes['2'], 'cambiarle el marcador a X no toca a Y');
});

test('multireloj: marcadores simultáneos en dos relojes, corregir uno no toca el otro', () => {
  const x = F('13:00:01', 1, '.30');
  const dia = [F('07:00:00', 1, '.30'), F('07:00:00', 2, '.33'), M('13:00:00', 9, '.30'), M('13:00:00', 6, '.33'),
    x, F('13:00:01', 2, '.33'), F('15:00:00', 1, '.30'), F('15:00:00', 2, '.33')];
  const antes = resultado(dia);
  for (const [accion, m] of [['OMITIR'], ['QUITAR_MARCADOR'], ['CAMBIAR_MARCADOR', 6]]) {
    assert.deepEqual(sin(resultado(dia, correcciones([x, accion, m])), 1), sin(antes, 1), accion);
  }
});

test('el carril privado no recibe marcadores de ningún reloj real', () => {
  const a = F('12:00:01', 1, '.30');
  // Un 6 en .30 justo después: se lo lleva el que ficha en .30, no la copia en el carril privado.
  const dia = [F('07:00:00', 1, '.30'), F('07:00:00', 2, '.30'), a, M('12:00:02', 6, '.30'), F('12:00:03', 2, '.30'), F('14:00:00', 2, '.30'), F('14:00:00', 1, '.30')];
  const r = resultado(dia, correcciones([a, 'QUITAR_MARCADOR']));
  assert.deepEqual(sin(r, 1), sin(resultado(dia), 1));
});

// Los 11 casos de octubre de AVP (2026-10-13, legajos 2544 y 2446; acá con
// números inventados): omitir la LLEGADA de A hace que el motor relea el
// resto del día de A (su fichaje de 13:41:18 pasa a ser la llegada y el de
// 13:41:28 queda como lectura repetida), A ya no se lleva el 9 y el 9 le
// queda a B, en el MISMO reloj. No es un marcador que cambia de reloj ni el
// marcador del fichaje omitido: es el motor sin tocar. No se puede evitar sin
// cambiar el motor; por eso la vista previa lo muestra y pide confirmarlo.
test('omitir la llegada puede cambiarle el resultado a otro del mismo reloj (lo que la vista previa avisa)', () => {
  const HE = { 9: MARC[9], 10: MARC[10] };
  const T = (h) => new Date(`2026-10-13T${h}`);
  const P = (h, l) => ({ checktime: T(h), userId: 1000 + l, employeeId: String(l), machineIp: '.33' });
  const K = (h, u) => ({ checktime: T(h), userId: u, employeeId: null, machineIp: '.33' });
  const llegadaA = P('11:24:23', 1);
  const dia = [P('07:04:33', 2), llegadaA, P('13:41:18', 1), K('13:41:24', 9), P('13:41:28', 1), P('13:41:37', 2), K('13:41:45', 9),
    P('13:41:52', 2), K('15:30:46', 10), P('15:30:49', 1), K('16:50:09', 10), P('16:50:17', 2)];
  const he = (cs) => mc.detectMovements(corr.paraDeteccion(dia, cs), HE, { maxMarkerGapMs: 25000, todosLosMarcadores: HE, ownCheckinBounceMs: 20000 })
    .closedEvents.map((e) => `${e.employeeId} ${f(e.timeOut)}→${f(e.timeIn)}`);
  assert.deepEqual(he(corr.SIN_CORRECCIONES), ['1 13:41:28→15:30:49', '2 13:41:52→16:50:17']);
  assert.deepEqual(he(correcciones([llegadaA, 'OMITIR'])), ['2 13:41:37→13:41:52']);
});

test('campaña "solo afectados": la lectura a nombre de nadie hereda el permiso de la persona', () => {
  const a = F('12:00:01', 1, '.30');
  const filas = corr.paraDeteccion([a], correcciones([a, 'OMITIR']));
  const set = corr.soloPuedenConsumirCon(new Set(['1']), filas);
  assert.ok(set.has(filas[0].employeeId));
  assert.equal(corr.soloPuedenConsumirCon(new Set(['9']), filas).size, 1, 'si la persona no era afectada, no se agrega nada');
});

test('para las horas: el omitido no está, el resto sí', () => {
  const a = F('12:00:01', 1, '.30');
  const filas = [{ USERID: 1001, CHECKTIME: '2026-10-01 07:00:00' }, { USERID: 1001, CHECKTIME: '2026-10-01 12:00:01' }];
  assert.deepEqual(corr.paraHoras(filas, correcciones([a, 'OMITIR'])).map((x) => x.CHECKTIME), ['2026-10-01 07:00:00']);
  assert.deepEqual(corr.idsOmitidos({ activas: new Map([['x', { accion: 'OMITIR', checkinId: 7 }], ['y', { accion: 'QUITAR_MARCADOR', checkinId: 8 }]]) }), [7]);
  assert.equal(corr.sinOmitidos('c.id', []), '');
  assert.equal(corr.sinOmitidos('c.id', [7, '8', 'x;DROP']), ' AND c.id NOT IN (7,8)');
});
