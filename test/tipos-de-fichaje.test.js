// Que es cada fichaje del dia (tiposDeFichaje.js), alimentado con la salida
// REAL de detectMovements: la pantalla tiene que mostrar lo mismo que calcula
// el motor, no una segunda interpretacion. Sin base ni servidor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectMovements, fechaHoraLocal, filterEventsOpenedByFirstCheckinOfDay } = require('../motor-laboral/services/movementsCalculations');
const { clasificarFichajesDelDia, marcasDeEventos } = require('../motor-laboral/services/tiposDeFichaje');

const MARCADORES = {
  6: { category: 'PARTICULAR', direction: 'SALIDA' },
  5: { category: 'PARTICULAR', direction: 'REGRESO' },
  9: { category: 'HE', direction: 'SALIDA' },
  10: { category: 'HE', direction: 'REGRESO' },
};
const soloDe = (cat) => Object.fromEntries(Object.entries(MARCADORES).filter(([, m]) => m.category === cat));
const t = (h) => new Date(`2026-09-28T${h}`);
const fichaje = (h, userId = 100, employeeId = '100') => ({ checktime: t(h), userId, employeeId, machineIp: null });
const marcador = (h, userId) => fichaje(h, userId, null);
const marcadorDe = (ev, rol) => {
  const uid = rol === 'salida' ? ev.salidaMarkerUserId : ev.regresoMarkerUserId;
  return uid == null ? null : { userId: uid };
};

// Un dia como el de AGOGLIA: 7 fichajes.
const DIA = [
  fichaje('06:56:00'),
  marcador('09:39:58', 6), fichaje('09:40:00'),
  marcador('10:14:58', 5), fichaje('10:15:00'),
  fichaje('13:38:00'),
  marcador('14:01:58', 9), fichaje('14:02:00'),
  marcador('17:29:58', 10), fichaje('17:30:00'),
  fichaje('17:30:10'),
];
const PROPIOS = DIA.filter((c) => c.employeeId).map((c) => fechaHoraLocal(c.checktime));

function clasificar(dia = DIA) {
  const opciones = { maxMarkerGapMs: 6000, todosLosMarcadores: MARCADORES };
  const marcas = [];
  for (const cat of ['PARTICULAR', 'HE']) {
    const r = detectMovements(dia, soloDe(cat), opciones);
    marcas.push(...marcasDeEventos(cat, r, '100', fechaHoraLocal, marcadorDe));
  }
  return clasificarFichajesDelDia({ fichajes: dia.filter((c) => c.employeeId).map((c) => fechaHoraLocal(c.checktime)), marcas });
}

test('los 7 fichajes del dia, cada uno con lo que decidio el motor', () => {
  const r = clasificar();
  assert.deepEqual(r.map((f) => [f.hora, f.base, f.tipos.map((x) => x.texto)]), [
    ['06:56', 'Entrada', []],
    ['09:40', 'Intermedio', ['Salida particular']],
    ['10:15', 'Intermedio', ['Regreso particular']],
    ['13:38', 'Intermedio', []],
    ['14:02', 'Intermedio', ['Inicio de horas extra']],
    ['17:30', 'Intermedio', ['Fin de horas extra']],
    ['17:30', 'Repetido', []],
  ]);
});

test('cada tipo trae el marcador que lo genero', () => {
  const r = clasificar();
  assert.equal(r[1].tipos[0].marcador.userId, 6);
  assert.equal(r[4].tipos[0].marcador.userId, 9);
});

test('una salida sin regreso se marca como tal', () => {
  const dia = [fichaje('06:56:00'), marcador('09:39:58', 6), fichaje('09:40:00')];
  const r = clasificar(dia);
  assert.deepEqual(r[1].tipos.map((x) => x.texto), ['Salida particular (sin regreso)']);
  assert.equal(r[1].base, 'Salida', 'es el ultimo fichaje del dia');
});

test('un fichaje puede tener dos tipos (una pasada por categoria, como el motor)', () => {
  // Vuelve de la salida particular apretando el 9: regresa Y arranca HE.
  const dia = [
    fichaje('06:56:00'),
    marcador('09:39:58', 6), fichaje('09:40:00'),
    marcador('14:01:58', 9), fichaje('14:02:00'),
    marcador('17:29:58', 10), fichaje('17:30:00'),
  ];
  const r = clasificar(dia);
  assert.deepEqual(r[2].tipos.map((x) => x.texto).sort(), ['Inicio de horas extra', 'Regreso particular']);
});

test('lo que el reporte descarta se muestra como descartado, con el motivo', () => {
  // Marcador ajeno pegado a su primer fichaje (regla AVILA): Salidas no lo cuenta.
  const dia = [marcador('06:55:58', 6), fichaje('06:56:00'), fichaje('13:38:00')];
  const r = detectMovements(dia, soloDe('PARTICULAR'), { maxMarkerGapMs: 6000, todosLosMarcadores: MARCADORES });
  const quedan = new Set(filterEventsOpenedByFirstCheckinOfDay(r.closedEvents, dia));
  const marcas = marcasDeEventos('PARTICULAR', r, '100', fechaHoraLocal, marcadorDe,
    (ev) => (quedan.has(ev) ? null : 'coincide con su primer fichaje del día: el marcador probablemente era de otra persona'));
  const f = clasificarFichajesDelDia({ fichajes: ['2026-09-28 06:56:00', '2026-09-28 13:38:00'], marcas });
  assert.match(f[0].tipos[0].descartado, /primer fichaje/);
});

test('sin marcadores, solo entrada, intermedios y salida', () => {
  const f = clasificarFichajesDelDia({ fichajes: ['2026-09-28 13:38:00', '2026-09-28 06:56:00', '2026-09-28 10:00:00'], marcas: [] });
  assert.deepEqual(f.map((x) => [x.hora, x.base]), [['06:56', 'Entrada'], ['10:00', 'Intermedio'], ['13:38', 'Salida']]);
  assert.equal(PROPIOS.length, 7);
});
