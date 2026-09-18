// Etapa 8 del plan "Motor de reglas de asistencia configurable" -- tests
// puros (sin backend, sin DB) para dayTypeRuleResolver.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveOvertimeRate, resolveAllDayRule } = require('../motor-laboral/services/dayTypeRuleResolver');

test('sin ninguna regla cargada: null -- comportamiento de hoy, ningun dia tiene tasa automatica', () => {
  assert.equal(resolveOvertimeRate([], { dayType: 'HOLIDAY', trigger: 'ALL_DAY' }), null);
  assert.equal(resolveOvertimeRate([{ day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 100 }], { dayType: 'SUNDAY', trigger: 'ALL_DAY' }), null, 'una regla de OTRO dia no debe matchear');
});

test('regla simple: feriado con tasa 100, disparador ALL_DAY', () => {
  const rules = [{ day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: '100.00', requires_authorization: 0 }];
  const result = resolveOvertimeRate(rules, { dayType: 'HOLIDAY', trigger: 'ALL_DAY' });
  assert.equal(result.rate, 100);
  assert.equal(result.requiresAuthorization, false);
});

test('un disparador puntual (AFTER_SCHEDULE) tambien matchea una regla ALL_DAY', () => {
  const rules = [{ day_type: 'SATURDAY', trigger_type: 'ALL_DAY', rate: 50 }];
  const result = resolveOvertimeRate(rules, { dayType: 'SATURDAY', trigger: 'AFTER_SCHEDULE' });
  assert.equal(result.rate, 50);
});

test('si hay una regla puntual Y una ALL_DAY para el mismo dia, gana la puntual (mas especifica sobre CUANDO)', () => {
  const rules = [
    { day_type: 'SATURDAY', trigger_type: 'ALL_DAY', rate: 50 },
    { day_type: 'SATURDAY', trigger_type: 'AFTER_SCHEDULE', rate: 100 },
  ];
  const result = resolveOvertimeRate(rules, { dayType: 'SATURDAY', trigger: 'AFTER_SCHEDULE' });
  assert.equal(result.rate, 100);
});

test('desempate por especificidad: template gana a convenio, convenio gana a tenant, tenant gana a global', () => {
  const rules = [
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 100, tenant_id: null, convention_id: null, template_id: null },
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 150, tenant_id: 6, convention_id: null, template_id: null },
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 200, tenant_id: 6, convention_id: 3, template_id: null },
    { day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 250, tenant_id: 6, convention_id: 3, template_id: 9 },
  ];
  assert.equal(resolveOvertimeRate(rules, { dayType: 'HOLIDAY', trigger: 'ALL_DAY' }).rate, 250);
});

test('reglas inactivas se ignoran', () => {
  const rules = [{ day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 100, active: 0 }];
  assert.equal(resolveOvertimeRate(rules, { dayType: 'HOLIDAY', trigger: 'ALL_DAY' }), null);
});

test('dayType o trigger invalido: null, no rompe', () => {
  assert.equal(resolveOvertimeRate([{ day_type: 'HOLIDAY', trigger_type: 'ALL_DAY', rate: 100 }], { dayType: 'ALGO_RARO', trigger: 'ALL_DAY' }), null);
});

test('resolveAllDayRule es un atajo de resolveOvertimeRate con trigger=ALL_DAY', () => {
  const rules = [{ day_type: 'REST_DAY', trigger_type: 'ALL_DAY', rate: 100 }];
  assert.equal(resolveAllDayRule(rules, 'REST_DAY').rate, 100);
  assert.equal(resolveAllDayRule(rules, 'WORKDAY'), null);
});
