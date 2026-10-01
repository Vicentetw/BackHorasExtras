// Fase 11 -- funcion pura/inyectable, sin gastar tokens reales de Anthropic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { askSalesChat, buildSystemPrompt, tratoInapropiado, MAX_REPLY_CHARS, RESPUESTA_SEGURA } = require('../motor-laboral/services/salesChatService');

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

test('askSalesChat: manda el historial previo antes del mensaje nuevo', async () => {
  // Bug real encontrado probando la landing de verdad: antes se mandaba
  // SOLO el mensaje nuevo -- un "si" respondiendo a la propia pregunta del
  // bot le llegaba sin ningun contexto y el modelo contestaba cualquier cosa.
  const fetchImpl = fakeFetch({ content: [{ type: 'text', text: 'Dale, usá el botón de WhatsApp.' }] });
  const history = [
    { role: 'user', content: '¿en qué link me registro?' },
    { role: 'assistant', content: 'El formulario está arriba en esta misma página.' }
  ];
  await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, history, userMessage: 'si', fetchImpl });

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[0], history[0]);
  assert.deepEqual(body.messages[1], history[1]);
  assert.equal(body.messages[2].content, 'si');
});

test('buildSystemPrompt: sabe que el visitante YA envio la solicitud, y que no puede mandar links', () => {
  // Reportado el 2026-10-01: el chat mandaba a "completar el formulario de
  // arriba" a quien acababa de completarlo, y decia que la cuenta ya estaba
  // creada. Ahora el alta es una solicitud que aprueba el superadmin.
  const prompt = buildSystemPrompt(FAKE_PLAN);
  assert.match(prompt, /YA ENVIO el formulario/);
  assert.match(prompt, /NUNCA le digas que complete el formulario/);
  assert.match(prompt, /TODAVIA NO esta creada/);
  assert.doesNotMatch(prompt, /no hace falta .* que nadie los contacte/i);
  assert.match(prompt, /NO podés enviar links ni contactos/i);
  assert.doesNotMatch(RESPUESTA_SEGURA, /complet(á|a)r? el formulario/i, 'la respuesta fija tampoco manda al formulario');
});

test('askSalesChat: si Anthropic responde con error, lo propaga con detalle', async () => {
  const fetchImpl = fakeFetch({ error: { message: 'invalid_api_key' } }, { ok: false, status: 401 });
  await assert.rejects(
    () => askSalesChat({ apiKey: 'MALA', plan: FAKE_PLAN, userMessage: 'hola', fetchImpl }),
    /invalid_api_key/
  );
});

// ---------------------------------------------------------------------------
// TRATO RESPETUOSO -- incidente real del 2026-10-01: el chat le contesto
// "Muy fácil, boludo." a un visitante. Estos tests fijan que no vuelva a pasar.
// ---------------------------------------------------------------------------

// Devuelve una respuesta distinta en cada llamada (para probar el reintento).
function fetchEnSecuencia(textos) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const text = textos[Math.min(calls.length - 1, textos.length - 1)];
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
  };
  fn.calls = calls;
  return fn;
}

test('tratoInapropiado: detecta la respuesta real del incidente y otras parecidas', () => {
  assert.equal(tratoInapropiado('Muy fácil, boludo. Arriba de este chat vas a ver un formulario.'), true, 'la frase exacta que salio en produccion');
  for (const malo of [
    'No seas BOLUDO, es fácil.', 'Eso es una pelotudez.', 'Qué estúpido.', 'Che, mirá el formulario.', 'Fácil, loco.',
    'Dale, maestro!', 'Tranquilo, capo.', 'Listo, genio.', 'Amigo, completá el formulario.', 'Andá a cagar.', 'Es una mierda.',
  ]) assert.equal(tratoInapropiado(malo), true, malo);
});

test('tratoInapropiado: no molesta a las respuestas normales (sin falsos positivos)', () => {
  for (const bueno of [
    'El plan cuesta USD 18 base más USD 2,20 por empleado. El primer mes es gratis.',
    'El cálculo de horas extra es automático.', // "cálculo" contiene "culo" adentro
    'Sirve para turnos partidos de docentes: un maestro puede tener dos turnos.', // "maestro" como sustantivo, no como vocativo
    'Podés consultar el cómputo del mes.', // "cómputo" contiene "puto" adentro
    'Dale, usá el botón de WhatsApp.',
    'El sistema es muy amigable y lo usa cualquier persona.',
    RESPUESTA_SEGURA,
  ]) assert.equal(tratoInapropiado(bueno), false, bueno);
});

test('buildSystemPrompt: exige trato profesional aunque el visitante escriba informal', () => {
  const prompt = buildSystemPrompt(FAKE_PLAN);
  assert.match(prompt, /TRATO OBLIGATORIO/);
  assert.match(prompt, /NUNCA uses insultos/);
  assert.match(prompt, /AUNQUE la persona escriba de forma muy informal/);
  assert.doesNotMatch(prompt, /rioplatense/, 'esa palabra sola empujaba al modelo a la jerga');
});

test('askSalesChat: una respuesta con mal trato NO llega al visitante: se descarta y se pide otra', async () => {
  const fetchImpl = fetchEnSecuencia(['Muy fácil, boludo. Completá el formulario.', 'Tu solicitud ya fue recibida: el equipo te va a contactar.']);
  const r = await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, userMessage: 'bueno, cómo hago, no tengo idea', fetchImpl });
  assert.equal(r.reply, 'Tu solicitud ya fue recibida: el equipo te va a contactar.');
  assert.equal(r.revisado, 'reintento');
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(JSON.parse(fetchImpl.calls[1].options.body).system, /respuesta anterior fue descartada/);
});

test('askSalesChat: si falla dos veces, se muestra el texto fijo y correcto', async () => {
  const fetchImpl = fetchEnSecuencia(['Fácil, boludo.', 'Dale, loco.']);
  const r = await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, userMessage: 'hola', fetchImpl });
  assert.equal(r.reply, RESPUESTA_SEGURA);
  assert.equal(r.revisado, 'respuesta_segura');
  assert.equal(tratoInapropiado(r.reply), false);
  assert.equal(fetchImpl.calls.length, 2, 'no reintenta sin fin');
});

test('askSalesChat: aunque el VISITANTE insulte, la respuesta se revisa igual', async () => {
  const fetchImpl = fetchEnSecuencia(['Entiendo. El formulario está arriba de este chat.']);
  const r = await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, userMessage: 'che boludo cuanto sale esto', fetchImpl });
  assert.equal(r.revisado, 'ok');
  assert.equal(tratoInapropiado(r.reply), false);
});

test('askSalesChat: una respuesta vieja con mal trato no se reenvia al modelo en el historial', async () => {
  const fetchImpl = fetchEnSecuencia(['Claro, con gusto.']);
  const history = [{ role: 'user', content: 'cómo hago' }, { role: 'assistant', content: 'Muy fácil, boludo.' }];
  await askSalesChat({ apiKey: 'KEY', plan: FAKE_PLAN, history, userMessage: 'gracias', fetchImpl });
  const enviado = JSON.parse(fetchImpl.calls[0].options.body).messages;
  assert.equal(enviado[1].content, RESPUESTA_SEGURA);
  assert.equal(enviado[0].content, 'cómo hago', 'lo que escribio el visitante no se toca');
});
