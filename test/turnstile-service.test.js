// Fase 11 -- funcion pura/inyectable, sin pegarle a Cloudflare de verdad.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyTurnstileToken } = require('../motor-laboral/services/turnstileService');

function fakeFetch(responseBody) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return { json: async () => responseBody };
  };
  fn.calls = calls;
  return fn;
}

test('verifyTurnstileToken: manda secret/response/remoteip como form-urlencoded a la URL correcta', async () => {
  const fetchImpl = fakeFetch({ success: true });
  const result = await verifyTurnstileToken({ token: 'tok-123', remoteIp: '1.2.3.4', secretKey: 'SECRET', fetchImpl });

  assert.equal(result.success, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  const body = fetchImpl.calls[0].options.body;
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get('secret'), 'SECRET');
  assert.equal(body.get('response'), 'tok-123');
  assert.equal(body.get('remoteip'), '1.2.3.4');
});

test('verifyTurnstileToken: success:false de Cloudflare se propaga con los error-codes', async () => {
  const fetchImpl = fakeFetch({ success: false, 'error-codes': ['invalid-input-response'] });
  const result = await verifyTurnstileToken({ token: 'tok-malo', secretKey: 'SECRET', fetchImpl });
  assert.equal(result.success, false);
  assert.deepEqual(result.errorCodes, ['invalid-input-response']);
});

test('verifyTurnstileToken: sin token, falla sin llamar a Cloudflare', async () => {
  const fetchImpl = fakeFetch({ success: true });
  const result = await verifyTurnstileToken({ token: '', secretKey: 'SECRET', fetchImpl });
  assert.equal(result.success, false);
  assert.equal(fetchImpl.calls.length, 0, 'no debe gastar ni un request si no hay token');
});
