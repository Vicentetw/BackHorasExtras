// Fase 11 -- funcion pura/inyectable, sin gastar tokens reales de Anthropic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { askSalesChat, buildSystemPrompt, MAX_REPLY_CHARS } = require('../motor-laboral/services/salesChatService');

const FAKE_PLAN = {
  base_price_usd: '18.00',
  price_per_employee_usd: '2.20',
  min_billed_employees: 5,
  discount_quarterly_pct: '5.00',
  discount_semiannual_pct: '10.00',
  discount_annual_pct: '17.00'
};

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => responseBody };
  };
  fn.calls = calls;
  return fn;
}

test('buildSystemPrompt: incluye los numeros REALES del plan, no valores inventados', () => {
  const prompt = buildSystemPrompt(FAKE_PLAN);
  assert.match(prompt, /USD 18\.00 base/);
  assert.match(prompt, /USD 2\.20 por empleado/);
  assert.match(prompt, /minimo 5 empleados/);
  assert.match(prompt, /17\.00% anual/);
});

test('askSalesChat: manda el body correcto a la API de Anthropic y devuelve el texto', async () => {
  const fetchImpl = fakeFetch({ content: [{ type: 'text', text: 'Respuesta corta de prueba.' }] });
  const result = await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, userMessage: '¿cuánto cuesta?', fetchImpl });

  assert.equal(result.reply, 'Respuesta corta de prueba.');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(fetchImpl.calls[0].options.headers['x-api-key'], 'KEY');
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.messages[0].content, '¿cuánto cuesta?');
  assert.ok(body.system.includes('USD 18.00 base'));
});

test('askSalesChat: trunca defensivamente una respuesta larga, no confia solo en el prompt', async () => {
  const longText = 'x'.repeat(MAX_REPLY_CHARS + 200);
  const fetchImpl = fakeFetch({ content: [{ type: 'text', text: longText }] });
  const result = await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, userMessage: 'hola', fetchImpl });

  assert.equal(result.reply.length, MAX_REPLY_CHARS);
  assert.ok(result.reply.endsWith('…'));
});

test('askSalesChat: si Anthropic responde con error, lo propaga con detalle', async () => {
  const fetchImpl = fakeFetch({ error: { message: 'invalid_api_key' } }, { ok: false, status: 401 });
  await assert.rejects(
    () => askSalesChat({ apiKey: 'MALA', plan: FAKE_PLAN, userMessage: 'hola', fetchImpl }),
    /invalid_api_key/
  );
});
