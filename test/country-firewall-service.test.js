const { test } = require('node:test');
const assert = require('node:assert');
const { checkAccess, isIpException, normalizeIp, resolveCountry } = require('../motor-laboral/services/countryFirewallService');

test('checkAccess: sin paises configurados, el firewall esta desactivado -- deja pasar todo', () => {
  const result = checkAccess({ ip: '200.1.2.3', allowedCountriesCsv: '', allowedIpsCsv: '' });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'firewall_disabled');
});

test('checkAccess: pais resuelto DENTRO de la lista permitida -- deja pasar', () => {
  const result = checkAccess({
    ip: '200.1.2.3',
    allowedCountriesCsv: 'AR,UY',
    allowedIpsCsv: '',
    resolveCountryFn: () => 'AR'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'country_allowed');
  assert.equal(result.country, 'AR');
});

test('checkAccess: pais resuelto FUERA de la lista permitida -- bloquea', () => {
  const result = checkAccess({
    ip: '1.2.3.4',
    allowedCountriesCsv: 'AR',
    allowedIpsCsv: '',
    resolveCountryFn: () => 'CN'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'country_blocked');
  assert.equal(result.country, 'CN');
});

test('checkAccess: pais no se pudo resolver (IP privada, base sin ese rango) -- fail-open, deja pasar', () => {
  const result = checkAccess({
    ip: '127.0.0.1',
    allowedCountriesCsv: 'AR',
    allowedIpsCsv: '',
    resolveCountryFn: () => null
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'country_unknown');
});

test('checkAccess: una IP en la lista de excepciones pasa aunque el pais este bloqueado', () => {
  const result = checkAccess({
    ip: '1.2.3.4',
    allowedCountriesCsv: 'AR',
    allowedIpsCsv: '1.2.3.4',
    resolveCountryFn: () => 'CN'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'ip_exception');
});

test('checkAccess: un rango CIDR en la lista de excepciones matchea una IP dentro del rango', () => {
  const result = checkAccess({
    ip: '190.2.3.55',
    allowedCountriesCsv: 'AR',
    allowedIpsCsv: '190.2.3.0/24',
    resolveCountryFn: () => 'CN'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'ip_exception');
});

test('checkAccess: un CIDR NO matchea una IP fuera del rango -- sigue evaluando por pais', () => {
  const result = checkAccess({
    ip: '190.2.99.1',
    allowedCountriesCsv: 'AR',
    allowedIpsCsv: '190.2.3.0/24',
    resolveCountryFn: () => 'CN'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'country_blocked');
});

test('checkAccess: los codigos de pais configurados son case-insensitive', () => {
  const result = checkAccess({
    ip: '1.2.3.4',
    allowedCountriesCsv: 'ar',
    allowedIpsCsv: '',
    resolveCountryFn: () => 'AR'
  });
  assert.equal(result.allowed, true);
});

test('isIpException: IP exacta con formato IPv6-mapeado (::ffff:x.x.x.x) matchea la excepcion en formato IPv4', () => {
  assert.equal(isIpException('::ffff:1.2.3.4', ['1.2.3.4']), true);
});

test('normalizeIp: le saca el prefijo IPv6-mapeado a una IPv4', () => {
  assert.equal(normalizeIp('::ffff:190.2.3.4'), '190.2.3.4');
  assert.equal(normalizeIp('190.2.3.4'), '190.2.3.4');
});

test('resolveCountry: una IP privada/de loopback nunca resuelve pais real', () => {
  assert.equal(resolveCountry('127.0.0.1'), null);
  assert.equal(resolveCountry('192.168.1.1'), null);
});
