// Tests de las reglas de vinculacion usuario-de-reloj <-> empleado.
// Puros: sin base de datos, sin servidor, sin red -- entran en `npm run
// test:unit`, o sea que los corre el CI en cada push.
//
// Los casos no son inventados: salen de medir los 478 pares reales de
// produccion el 2026-09-20. Por eso cada bloque cita cuantos casos de ese
// tipo hay de verdad.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyNameEvidence,
  rankCandidateUsers,
  buildMatchProposals,
  resolveIdentityField,
  identityColumn,
  NAME_EVIDENCE,
  DEFAULT_IDENTITY_FIELD,
  classifyPuncher,
  PUNCHER_STATUS,
  PUNCHER_STATUS_INFO
} = require('../matchingRules');

// ---------------------------------------------------------------------------
// QUE DATO CARGO LA EMPRESA EN EL RELOJ (legajo o documento)
// ---------------------------------------------------------------------------
// El Badgenumber es la identidad, pero identidad SEGUN QUE: cada empresa
// decide que le tipea al reloj. Estos tests cuidan sobre todo que el nombre
// de columna que termina en la consulta SQL salga de una lista blanca y
// nunca del texto que mando el cliente.

test('legajo y documento se traducen a la columna correcta de employees', () => {
  assert.equal(identityColumn('legajo'), 'employee_id');
  assert.equal(identityColumn('documento'), 'documento');
});

test('el default es legajo', () => {
  assert.equal(DEFAULT_IDENTITY_FIELD, 'legajo');
  assert.equal(resolveIdentityField(null), 'legajo');
  assert.equal(resolveIdentityField(''), 'legajo');
  assert.equal(resolveIdentityField(undefined), 'legajo');
});

test('tolera mayusculas y espacios', () => {
  assert.equal(resolveIdentityField('  DOCUMENTO '), 'documento');
  assert.equal(resolveIdentityField('Legajo'), 'legajo');
});

test('un valor desconocido NUNCA llega a la consulta: cae en el default', () => {
  // Si esto fallara, un valor del cliente terminaria interpolado en SQL.
  assert.equal(resolveIdentityField('nombre'), 'legajo');
  assert.equal(resolveIdentityField('id'), 'legajo');
  assert.equal(identityColumn('employee_id; DROP TABLE users'), 'employee_id');
  assert.equal(identityColumn({ malicioso: true }), 'employee_id');
});

// ---------------------------------------------------------------------------
// AVISO: ALGUIEN FICHA Y NO ESTA EN LA LISTA
// ---------------------------------------------------------------------------

test('si las fichadas YA llegan a un empleado activo, NO se avisa nada', () => {
  // Este es EL test que faltaba el 2026-09-19. Ese dia se dio por perdidos
  // 81.622 fichajes que en realidad llegaban perfecto al informe, porque se
  // supuso la cadena de JOINs en vez de leerla. Si el aviso marca como
  // problema a alguien que aparece bien en Presentismo, esta roto.
  const empleadoOk = { id: 1, activo: 1, exclude_from_report: 0 };
  assert.equal(classifyPuncher(empleadoOk, null), null);
  assert.equal(classifyPuncher(empleadoOk, empleadoOk), null);
});

test('ficha pero esta dado de baja -> avisar', () => {
  assert.equal(
    classifyPuncher({ id: 1, activo: 0, exclude_from_report: 0 }, null),
    PUNCHER_STATUS.INACTIVE
  );
});

test('ficha pero esta oculto del informe -> avisar', () => {
  assert.equal(
    classifyPuncher({ id: 1, activo: 1, exclude_from_report: 1 }, null),
    PUNCHER_STATUS.HIDDEN
  );
});

test('ficha, el empleado existe y esta bien, pero nadie lo asocio -> avisar', () => {
  assert.equal(
    classifyPuncher(null, { id: 2, activo: 1, exclude_from_report: 0 }),
    PUNCHER_STATUS.UNLINKED
  );
});

test('ficha un numero que no es de ningun empleado -> avisar para revisar', () => {
  assert.equal(classifyPuncher(null, null), PUNCHER_STATUS.UNKNOWN);
});

test('si no esta asociado Y ademas esta de baja, manda el motivo de fondo', () => {
  // Decirle "asocialo" a alguien que esta dado de baja no sirve: primero hay
  // que reactivarlo.
  assert.equal(
    classifyPuncher(null, { id: 2, activo: 0, exclude_from_report: 0 }),
    PUNCHER_STATUS.INACTIVE
  );
});

test('cada aviso tiene texto y accion en castellano llano', () => {
  for (const estado of Object.values(PUNCHER_STATUS)) {
    const info = PUNCHER_STATUS_INFO[estado];
    assert.ok(info, `falta el texto para "${estado}"`);
    assert.ok(info.titulo && info.accion);
  }
});

// ---------------------------------------------------------------------------
// EL DESEMPATE -- es el test mas importante del archivo
// ---------------------------------------------------------------------------
// Reproduce el bug que costo 81.622 fichajes: habia dos usuarios de reloj con
// el legajo 9467; el codigo viejo tomaba `users[0]` sin ORDER BY, o sea el
// USERID mas bajo (440), que nunca habia fichado, en lugar del 9467, que
// fichaba todos los dias. Si alguien vuelve a romper el desempate, este test
// se pone en rojo.

test('gana el usuario de reloj que TIENE fichajes, no el del USERID mas bajo', () => {
  const candidatos = [
    { USERID: 440, user_name: 'MENDOZA', checkinCount: 0, lastCheckin: null },
    { USERID: 9467, user_name: 'MENDOZA', checkinCount: 2011, lastCheckin: '2026-09-18 07:15:00' }
  ];
  const ordenados = rankCandidateUsers(candidatos);
  assert.equal(ordenados[0].USERID, 9467, 'debe ganar el que ficha, aunque tenga el USERID mas alto');
});

test('entre dos que fichan, gana el del fichaje mas reciente', () => {
  const candidatos = [
    { USERID: 100, checkinCount: 50, lastCheckin: '2024-01-10 08:00:00' },
    { USERID: 200, checkinCount: 12, lastCheckin: '2026-09-18 08:00:00' }
  ];
  assert.equal(rankCandidateUsers(candidatos)[0].USERID, 200,
    'mas fichajes historicos no significa que siga en uso; manda el ultimo fichaje');
});

test('si ninguno ficho, el orden es estable (USERID mas bajo) y no aleatorio', () => {
  const candidatos = [
    { USERID: 500, checkinCount: 0, lastCheckin: null },
    { USERID: 300, checkinCount: 0, lastCheckin: null }
  ];
  assert.equal(rankCandidateUsers(candidatos)[0].USERID, 300,
    'sin evidencia, al menos el resultado tiene que ser repetible');
});

test('ordenar no modifica el array original', () => {
  const candidatos = [
    { USERID: 440, checkinCount: 0, lastCheckin: null },
    { USERID: 9467, checkinCount: 2011, lastCheckin: '2026-09-18 07:15:00' }
  ];
  rankCandidateUsers(candidatos);
  assert.equal(candidatos[0].USERID, 440, 'rankCandidateUsers debe devolver una copia');
});

// ---------------------------------------------------------------------------
// EL NOMBRE COMO CORROBORACION
// ---------------------------------------------------------------------------

test('nombre identico -> exacto', () => {
  assert.equal(classifyNameEvidence('PEREZ, Juan', 'Juan Perez'), NAME_EVIDENCE.EXACT);
});

test('el reloj guarda solo el apellido -> contiene (363 de 478 casos reales)', () => {
  assert.equal(
    classifyNameEvidence('VILLARROEL', 'VILLARROEL, Víctor Saúl'),
    NAME_EVIDENCE.CONTAINS
  );
  assert.equal(
    classifyNameEvidence('BIZAMA VIDAL', 'BIZAMA VIDAL, Ricardo'),
    NAME_EVIDENCE.CONTAINS
  );
});

test('el reloj se come la ñ y los acentos -> acentos, no "no coincide"', () => {
  // El reloj BORRA la letra en vez de reemplazarla: "CAÑETE" -> "CAETE".
  assert.equal(classifyNameEvidence('CAETE', 'CAÑETE, Néstor Norberto'), NAME_EVIDENCE.ACCENTS);
  assert.equal(classifyNameEvidence('AGERO', 'AGÜERO, Paola Romina'), NAME_EVIDENCE.ACCENTS);
  assert.equal(classifyNameEvidence('Gonzalez Rubn', 'Gonzalez Rubén'), NAME_EVIDENCE.ACCENTS);
  assert.equal(classifyNameEvidence('LIZARRALDE, Iaky', 'LIZARRALDE, Iñaky'), NAME_EVIDENCE.ACCENTS);
});

test('el reloj tiene el legajo como nombre -> sin_nombre (no se puede corroborar)', () => {
  assert.equal(classifyNameEvidence('9370', 'JONES, Ezequiel'), NAME_EVIDENCE.NO_NAME);
  assert.equal(classifyNameEvidence('2489', 'SEGURA, Néstor Fabian'), NAME_EVIDENCE.NO_NAME);
  assert.equal(classifyNameEvidence('', 'AGUILAR, Marcelo José'), NAME_EVIDENCE.NO_NAME);
});

test('nombres realmente distintos -> no_coincide', () => {
  assert.equal(classifyNameEvidence('GOMEZ, Ana', 'LOPEZ, Carlos'), NAME_EVIDENCE.MISMATCH);
});

// ---------------------------------------------------------------------------
// LA PROPUESTA COMPLETA
// ---------------------------------------------------------------------------

test('propuesta: elige al que ficha y lo deja pre-tildado si el nombre corrobora', () => {
  const filas = [
    { employee_id: 77, emp_legajo: 9467, employee_name: 'MENDOZA, Bruno Ezequiel',
      USERID: 440, user_badgenumber: '9467', user_name: 'MENDOZA', checkinCount: 0, lastCheckin: null },
    { employee_id: 77, emp_legajo: 9467, employee_name: 'MENDOZA, Bruno Ezequiel',
      USERID: 9467, user_badgenumber: '9467', user_name: 'MENDOZA', checkinCount: 2011, lastCheckin: '2026-09-18 07:15:00' }
  ];
  const [p] = buildMatchProposals(filas);

  assert.equal(p.USERID, 9467);
  assert.equal(p.nameEvidence, NAME_EVIDENCE.CONTAINS);
  assert.equal(p.preselected, true);
  assert.equal(p.checkinCount, 2011);
  // El candidato descartado NO se esconde: verlo es lo que permite detectar
  // que hay dos usuarios de reloj para la misma persona.
  assert.equal(p.alternatives.length, 1);
  assert.equal(p.alternatives[0].USERID, 440);
  assert.equal(p.alternatives[0].checkinCount, 0);
});

test('propuesta: si el nombre no corrobora, se muestra pero NO viene tildada', () => {
  const filas = [
    { employee_id: 88, emp_legajo: 9370, employee_name: 'JONES, Ezequiel',
      USERID: 9370, user_badgenumber: '9370', user_name: '9370', checkinCount: 1296, lastCheckin: '2026-09-18 09:00:00' }
  ];
  const [p] = buildMatchProposals(filas);

  assert.equal(p.nameEvidence, NAME_EVIDENCE.NO_NAME);
  assert.equal(p.preselected, false, 'tiene que exigir que alguien lo mire');
  assert.equal(p.USERID, 9370, 'pero sigue siendo el candidato: el legajo coincide');
});

test('propuesta: una fila por empleado, no una por usuario de reloj', () => {
  const filas = [
    { employee_id: 1, emp_legajo: 100, employee_name: 'A', USERID: 10, user_badgenumber: '100', user_name: 'A', checkinCount: 5, lastCheckin: '2026-01-01 08:00:00' },
    { employee_id: 1, emp_legajo: 100, employee_name: 'A', USERID: 11, user_badgenumber: '100', user_name: 'A', checkinCount: 0, lastCheckin: null },
    { employee_id: 2, emp_legajo: 200, employee_name: 'B', USERID: 20, user_badgenumber: '200', user_name: 'B', checkinCount: 3, lastCheckin: '2026-01-01 08:00:00' }
  ];
  assert.equal(buildMatchProposals(filas).length, 2);
});

test('sin candidatos, no propone nada (no inventa vinculos)', () => {
  assert.deepEqual(buildMatchProposals([]), []);
  assert.deepEqual(buildMatchProposals(null), []);
});
