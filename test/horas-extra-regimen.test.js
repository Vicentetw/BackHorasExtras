// Horas extra segun el regimen (horasExtraRegimen.js) -- reglas de RRHH con
// los casos reales que las motivaron. Sin base ni servidor.
// Diseño: HORAS_EXTRA_REGIMENES.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  recortarPorPlantilla, aplicarMinimoYRedondeo, clasificarPorTipoDeDia, resolverTopes, aplicarTopesDelPeriodo,
} = require('../motor-laboral/services/horasExtraRegimen');

const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const H = (horas) => horas * 60;

// ---------------------------------------------------------------------------
// 1. Plantilla: jornada, descanso, corte y ventana
// ---------------------------------------------------------------------------

// MARTENSEN: Trabajo 7-14, Descanso 14-15. Aprieta el 9 a las 14:42 y el 10 a las 18:01.
const MARTENSEN = { bloques: [{ tipo: 'WORK', desde: hm('07:00'), hasta: hm('14:00') }, { tipo: 'BREAK', desde: hm('14:00'), hasta: hm('15:00') }] };

test('MARTENSEN: lo marcado dentro del descanso no cuenta; la HE arranca a las 15:00', () => {
  const r = recortarPorPlantilla({ inicio: hm('14:42'), fin: hm('18:01') }, MARTENSEN);
  assert.equal(r.minutos, 181);
  assert.deepEqual(r.tramos, [{ desde: hm('15:00'), hasta: hm('18:01') }]);
  assert.deepEqual(r.recortes, [{ motivo: 'dentro del descanso', minutos: 18 }]);
});

test('sin descanso en su plantilla (7-14), la HE cuenta desde las 14:00: cada uno segun SU plantilla', () => {
  const r = recortarPorPlantilla({ inicio: hm('14:00'), fin: hm('18:00') }, { bloques: [MARTENSEN.bloques[0]] });
  assert.equal(r.minutos, 240);
});

test('el corte HE cargado recorta lo anterior aunque no haya descanso', () => {
  const r = recortarPorPlantilla({ inicio: hm('14:10'), fin: hm('18:00') }, { bloques: [MARTENSEN.bloques[0]], cuentanDesde: hm('15:00') });
  assert.equal(r.minutos, 180);
  assert.deepEqual(r.recortes, [{ motivo: 'antes del corte de horas extra', minutos: 50 }]);
});

test('con una ventana de horas extra (15-20), lo de despues de las 20 no cuenta', () => {
  const r = recortarPorPlantilla({ inicio: hm('15:00'), fin: hm('21:30') }, { bloques: [...MARTENSEN.bloques, { tipo: 'OVERTIME', desde: hm('15:00'), hasta: hm('20:00') }] });
  assert.equal(r.minutos, 300);
  assert.deepEqual(r.recortes, [{ motivo: 'fuera de la ventana de horas extra', minutos: 90 }]);
});

test('un intervalo que cae entero en la jornada no da horas extra', () => {
  assert.equal(recortarPorPlantilla({ inicio: hm('09:00'), fin: hm('11:00') }, MARTENSEN).minutos, 0);
});

// ---------------------------------------------------------------------------
// 2. Minimo y redondeo
// ---------------------------------------------------------------------------

test('RAMIREZ 22/09: 9 minutos por salir tarde no son hora extra si el minimo es 30', () => {
  assert.deepEqual(aplicarMinimoYRedondeo(9, { minimo: 30 }), { minutos: 0, motivo: 'menos del mínimo de 30 min' });
  assert.deepEqual(aplicarMinimoYRedondeo(9, {}), { minutos: 9, motivo: null }, 'sin minimo configurado, como hoy');
});

test('redondeo a fracciones de 30 min, hacia abajo, al mas cercano o hacia arriba', () => {
  assert.equal(aplicarMinimoYRedondeo(181, { redondeo: 30 }).minutos, 180);
  assert.equal(aplicarMinimoYRedondeo(200, { redondeo: 30, modo: 'CERCANO' }).minutos, 210);
  assert.equal(aplicarMinimoYRedondeo(181, { redondeo: 30, modo: 'ARRIBA' }).minutos, 210);
});

// ---------------------------------------------------------------------------
// 3. Tipo de dia segun el regimen
// ---------------------------------------------------------------------------

// Regimen "Horas extra": habil y sabado al 50 %, domingo y feriado al 100 %.
const REGIMEN_HE = [
  { day_type: 'WORKDAY', classification_type: 'EXTRA', rate: 50 },
  { day_type: 'SATURDAY', classification_type: 'EXTRA', rate: 50 },
  { day_type: 'SUNDAY', classification_type: 'EXTRA', rate: 100 },
  { day_type: 'HOLIDAY', classification_type: 'EXTRA', rate: 100 },
];
// Regimen "Administrativo": fuera de horario se registra, no se paga.
const REGIMEN_ADMIN = ['WORKDAY', 'SATURDAY', 'SUNDAY', 'HOLIDAY', 'REST_DAY'].map((d) => ({ day_type: d, classification_type: 'REGISTRAR', rate: null }));

test('mismo sabado, dos regimenes: uno cobra al 50 %, el otro se registra sin pagar', () => {
  assert.deepEqual(clasificarPorTipoDeDia('SATURDAY', REGIMEN_HE), { clase: 'EXTRA', recargo: 50, motivo: null });
  const admin = clasificarPorTipoDeDia('SATURDAY', REGIMEN_ADMIN);
  assert.equal(admin.clase, 'REGISTRAR');
  assert.match(admin.motivo, /horas de dedicación/);
});

test('domingo y feriado al 100 %', () => {
  assert.equal(clasificarPorTipoDeDia('SUNDAY', REGIMEN_HE).recargo, 100);
  assert.equal(clasificarPorTipoDeDia('HOLIDAY', REGIMEN_HE).recargo, 100);
});

test('"extra si autorizado": sin autorizacion se registra, no se paga', () => {
  const reglas = [{ day_type: 'WORKDAY', classification_type: 'EXTRA_SI_AUTORIZADO', rate: 50 }];
  assert.equal(clasificarPorTipoDeDia('WORKDAY', reglas, { autorizado: true }).clase, 'EXTRA');
  assert.equal(clasificarPorTipoDeDia('WORKDAY', reglas, { autorizado: false }).clase, 'REGISTRAR');
});

test('sin regla para ese dia: EXTRA sin recargo (lo de siempre); el valor historico OVERTIME es EXTRA', () => {
  assert.deepEqual(clasificarPorTipoDeDia('REST_DAY', REGIMEN_HE), { clase: 'EXTRA', recargo: null, motivo: null });
  assert.equal(clasificarPorTipoDeDia('WORKDAY', [{ day_type: 'WORKDAY', classification_type: 'OVERTIME', rate: 50 }]).clase, 'EXTRA');
});

// ---------------------------------------------------------------------------
// 4. Topes y politica de excedente -- CHINELI: ~3,3 h/dia, 18 dias, tope 40 h/mes
// ---------------------------------------------------------------------------

const CHINELI = Array.from({ length: 18 }, (_, i) => ({ fecha: `2026-09-${String(i + 1).padStart(2, '0')}`, minutos: 197, recargo: 50 }));
const REALES = 18 * 197; // 3546 min = 59,1 h

test('tope 40 h/mes con "no computar": 40 h computables y el resto queda como excedente visible', () => {
  const r = aplicarTopesDelPeriodo(CHINELI, { dia: null, mes: H(40), anio: null }, { politica: 'NO_COMPUTAR' });
  assert.equal(r.reales, REALES);
  assert.equal(r.computables, H(40));
  assert.equal(r.excedente, REALES - H(40));
  assert.equal(r.aviso, true);
});

test('el tope se consume en orden cronologico: los ultimos dias del mes son los excedentes', () => {
  const r = aplicarTopesDelPeriodo(CHINELI, { mes: H(40) }, { politica: 'NO_COMPUTAR' });
  assert.equal(r.detalle[0].computables, 197, 'el 1 de septiembre cuenta completo');
  assert.equal(r.detalle[17].computables, 0, 'el ultimo dia ya no entra');
  assert.deepEqual(r.detalle[17].motivos, ['tope mensual']);
});

test('"avisar": computa todo y marca el excedente', () => {
  const r = aplicarTopesDelPeriodo(CHINELI, { mes: H(40) }, { politica: 'AVISAR' });
  assert.equal(r.computables, REALES);
  assert.equal(r.excedente, REALES - H(40));
  assert.equal(r.aviso, true);
});

test('"tal cual": sin tope efectivo, sin aviso', () => {
  const r = aplicarTopesDelPeriodo(CHINELI, { mes: H(40) }, { politica: 'TAL_CUAL' });
  assert.equal(r.computables, REALES);
  assert.equal(r.excedente, 0);
  assert.equal(r.aviso, false);
});

test('"autorizar": el excedente queda pendiente hasta que alguien apruebe; lo aprobado pasa a computable', () => {
  const sin = aplicarTopesDelPeriodo(CHINELI, { mes: H(40) }, { politica: 'AUTORIZAR' });
  assert.equal(sin.computables, H(40));
  assert.equal(sin.pendiente, REALES - H(40));
  const con = aplicarTopesDelPeriodo(CHINELI, { mes: H(40) }, { politica: 'AUTORIZAR', aprobados: H(10) });
  assert.equal(con.computables, H(50));
  assert.equal(con.pendiente, REALES - H(50));
});

test('autorizacion individual: reemplaza el tope del regimen (Chineli hasta 60 h aunque el regimen diga 40)', () => {
  const topes = resolverTopes({ dia: H(3), mes: H(40), anio: H(200) }, { mes: H(60) });
  assert.deepEqual(topes, { dia: H(3), mes: H(60), anio: H(200) }, 'solo cambia el tope que la autorizacion define');
  const r = aplicarTopesDelPeriodo(CHINELI, { mes: topes.mes }, { politica: 'NO_COMPUTAR' });
  assert.equal(r.computables, REALES, '59,1 h entran en 60');
});

test('tope diario de 3 h: cada dia de 3 h 17 min deja 17 min de excedente', () => {
  const r = aplicarTopesDelPeriodo(CHINELI, { dia: H(3) }, { politica: 'NO_COMPUTAR' });
  assert.equal(r.computables, 18 * 180);
  assert.equal(r.excedente, 18 * 17);
});

test('tope anual: cuenta lo computado en los meses anteriores', () => {
  const r = aplicarTopesDelPeriodo(CHINELI, { anio: H(200) }, { politica: 'NO_COMPUTAR', yaComputadoEnElAnio: H(190) });
  assert.equal(r.computables, H(10));
});

test('liquidacion por recargo: las horas del domingo al 100 % y las del habil al 50 %', () => {
  const dias = [
    { fecha: '2026-09-01', minutos: H(3), recargo: 50 },
    { fecha: '2026-09-06', minutos: H(4), recargo: 100 },
    { fecha: '2026-09-08', minutos: H(3), recargo: 50 },
  ];
  const r = aplicarTopesDelPeriodo(dias, { mes: H(8) }, { politica: 'NO_COMPUTAR' });
  assert.deepEqual(r.porRecargo, { '50%': H(4), '100%': H(4) }, 'el tope corta el ultimo dia (08/09, al 50 %)');
  assert.equal(r.excedente, H(2));
});
