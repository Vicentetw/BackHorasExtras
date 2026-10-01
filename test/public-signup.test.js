// Fase 11: landing publica + alta autoservicio + chatbot de ventas.
// Usa las site/secret keys de PRUEBA oficiales y publicas de Cloudflare
// Turnstile (documentadas en
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/ --
// "always passes"/"always blocks", no son credenciales reales de nadie),
// asi que el alta autoservicio se puede probar de punta a punta SIN
// esperar a que el usuario cree su cuenta real de Cloudflare todavia.
//
// El chat de ventas SI necesita una ANTHROPIC_API_KEY real para su camino
// feliz (no hay un equivalente de "test key" publico de Anthropic) -- acá
// solo se prueba lo que no depende de eso (limite alcanzado, falta de
// configuracion). El llamado real a la API se prueba aparte, a mano, una
// vez que el usuario cargue su ANTHROPIC_API_KEY.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TURNSTILE_ALWAYS_PASSES_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_ALWAYS_FAILS_SECRET = '2x0000000000000000000000000000000AA';
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'; // cualquier string sirve contra las secret keys de prueba

let createdTenantIds = [];
let createdLeadIds = [];
let createdUserEmails = [];
let originalTurnstileSecret;
let originalAnthropicKey;

let headersSuperadmin;
let headersAdmin;
const UID_SUPER = 'test-public-signup-super';
const UID_ADMIN = 'test-public-signup-admin';

before(async () => {
  originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  headersSuperadmin = await getTestAuthHeaders(UID_SUPER);
  // Un usuario comun (no superadmin): no puede ver ni aprobar solicitudes.
  headersAdmin = await getTestAuthHeaders(UID_ADMIN, { isSuperadmin: false, tenantId: null });
});

const registrar = (body) => fetch(`${BASE_URL}/api/public/signup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ turnstileToken: TURNSTILE_DUMMY_TOKEN, ...body }),
});
const aprobar = (id, body = {}, headers = headersSuperadmin) => fetch(`${BASE_URL}/api/solicitudes-alta/${id}/aprobar`, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const chatPost = (ruta, body) => fetch(`${BASE_URL}/api/public/chat${ruta}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

after(async () => {
  process.env.TURNSTILE_SECRET_KEY = originalTurnstileSecret;
  process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  await deleteTestUser(UID_SUPER);
  await deleteTestUser(UID_ADMIN);
  for (const email of createdUserEmails) {
    const [[row]] = await db.query('SELECT firebase_uid FROM app_users WHERE email = ?', [email]);
    if (row) await deleteTestUser(row.firebase_uid).catch(() => {});
    await db.query('DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM app_users WHERE email = ?)', [email]).catch(() => {});
    await db.query('DELETE FROM app_users WHERE email = ?', [email]).catch(() => {});
    await db.query('DELETE FROM signup_leads WHERE email = ?', [email]).catch(() => {});
  }
  for (const leadId of createdLeadIds) {
    await db.query('DELETE FROM signup_leads WHERE id = ?', [leadId]).catch(() => {});
  }
  for (const tenantId of createdTenantIds) {
    await db.query('DELETE FROM tenant_subscriptions WHERE tenant_id = ?', [tenantId]).catch(() => {});
    await db.query('DELETE FROM tenants WHERE id = ?', [tenantId]).catch(() => {});
  }
  await closeDb();
});

// NOTA: routes/public.js NO reinicia el proceso -- necesita que el server
// (node horasdedica2.js) ya este corriendo con TURNSTILE_SECRET_KEY seteada
// en su PROPIO entorno para que este test contra el server real funcione.
// Si el server no tiene la variable seteada, este primer test lo confirma
// con un mensaje claro en vez de fallar en silencio.

test('alta: registrarse SOLO guarda la solicitud; al aprobarla el superadmin se crea empresa + prueba + administrador titular', async () => {
  const email = `test-public-signup-${Date.now()}@example.com`;
  createdUserEmails.push(email);

  const res = await registrar({
    name: 'Persona de Prueba', companyName: `Empresa Prueba ${Date.now()}`, email: email.toUpperCase(), phone: '+54 9 280 1234567',
    contactPreference: 'whatsapp', employeeCount: 12, clockCount: 1, scheduleType: 'Fijo, lunes a viernes',
  });
  const json = await res.json();
  if (res.status === 503 && /TURNSTILE_SECRET_KEY/.test(json.error || '')) {
    console.log('  (saltado: el servidor real no tiene TURNSTILE_SECRET_KEY configurada -- exportala y reiniciá node horasdedica.js para correr este test)');
    return;
  }

  assert.equal(res.status, 201, JSON.stringify(json));
  assert.ok(json.leadId);
  createdLeadIds.push(json.leadId);
  assert.equal(json.resetLink, undefined, 'la respuesta no puede traer el link de contraseña');
  assert.equal(json.pendiente, true, 'queda esperando la aprobacion del superadmin');

  // Registrarse NO crea nada (decision del dueño del producto, 2026-10-01).
  const [[pendiente]] = await db.query('SELECT tenant_id, status, email FROM signup_leads WHERE id = ?', [json.leadId]);
  assert.deepEqual({ ...pendiente }, { tenant_id: null, status: 'pending', email }, 'el mail se guarda en minusculas');
  const [[sinCuenta]] = await db.query('SELECT COUNT(*) AS n FROM app_users WHERE email = ?', [email]);
  assert.equal(sinCuenta.n, 0, 'sin aprobar no hay cuenta');

  // El token del chat se entrega UNA vez, acá, y en la base queda solo su
  // hash: si mañana se filtra un backup de signup_leads, lo que hay adentro
  // no sirve para chatear con nuestra clave de API.
  assert.ok(json.chatToken, 'la solicitud tiene que devolver el token del chat');
  const [[guardado]] = await db.query('SELECT chat_token_hash FROM signup_leads WHERE id = ?', [json.leadId]);
  assert.notEqual(guardado.chat_token_hash, json.chatToken, 'nunca el token en claro');
  assert.equal(guardado.chat_token_hash, crypto.createHash('sha256').update(json.chatToken).digest('hex'), 'lo guardado es el SHA-256 del token entregado');

  // Solo el superadmin ve y aprueba las solicitudes.
  assert.equal((await fetch(`${BASE_URL}/api/solicitudes-alta`, { headers: headersAdmin })).status, 403);
  assert.equal((await aprobar(json.leadId, {}, headersAdmin)).status, 403);
  const bandeja = await (await fetch(`${BASE_URL}/api/solicitudes-alta`, { headers: headersSuperadmin })).json();
  const enBandeja = bandeja.solicitudes.find((x) => x.id === json.leadId);
  assert.ok(enBandeja, 'aparece en la bandeja de pendientes');
  assert.equal(enBandeja.chat_token_hash, undefined, 'la bandeja no expone el hash del chat');

  // Aprobar, corrigiendo el nombre de la empresa (dato de la charla).
  const empresaCorregida = `Empresa Corregida ${Date.now()}`;
  const ok = await aprobar(json.leadId, { companyName: empresaCorregida });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await aprobar(json.leadId)).status, 409, 'una solicitud se aprueba una sola vez');

  const [[lead]] = await db.query('SELECT tenant_id, status, reviewed_at FROM signup_leads WHERE id = ?', [json.leadId]);
  assert.equal(lead.status, 'provisioned');
  assert.ok(lead.tenant_id);
  assert.ok(lead.reviewed_at, 'queda quien y cuando la aprobo');
  createdTenantIds.push(lead.tenant_id);

  const [[tenant]] = await db.query('SELECT name, titular_email FROM tenants WHERE id = ?', [lead.tenant_id]);
  assert.equal(tenant.name, empresaCorregida);
  assert.equal(tenant.titular_email, email, 'quien se registro queda como titular (quien paga)');
  const [[subscription]] = await db.query('SELECT status, current_period_start, current_period_end FROM tenant_subscriptions WHERE tenant_id = ?', [lead.tenant_id]);
  assert.equal(subscription.status, 'trial');
  assert.ok(subscription.current_period_start && subscription.current_period_end, 'el mes gratis arranca al aprobar');
  const [[appUser]] = await db.query(
    'SELECT u.tenant_id, u.is_superadmin, u.is_active, r.name AS rol FROM app_users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.email = ?', [email]);
  assert.deepEqual({ ...appUser }, { tenant_id: lead.tenant_id, is_superadmin: 0, is_active: 1, rol: 'Administrador de Empresa' });
});

test('alta: reenviar el formulario actualiza LA MISMA solicitud (no crea otra, ni otro cupo de chat)', async () => {
  const email = `test-public-signup-reenvio-${Date.now()}@example.com`;
  createdUserEmails.push(email);
  const a = await registrar({ name: 'Ana', companyName: 'Empresa Reenvio 1', email });
  if (a.status === 503) return;
  const ja = await a.json();
  await db.query('UPDATE signup_leads SET chat_questions_used = 4 WHERE id = ?', [ja.leadId]);

  const b = await registrar({ name: 'Ana Maria', companyName: 'Empresa Reenvio 2', email });
  const jb = await b.json();
  assert.equal(jb.leadId, ja.leadId, 'la misma solicitud');
  const [filas] = await db.query('SELECT company_name, chat_questions_used FROM signup_leads WHERE email = ?', [email]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].company_name, 'Empresa Reenvio 2', 'con los datos nuevos');
  assert.equal(filas[0].chat_questions_used, 4, 'el cupo de preguntas NO se reinicia');
  assert.notEqual(jb.chatToken, ja.chatToken, 'el token viejo deja de servir');
  assert.equal((await chatPost('/estado', { leadId: ja.leadId, chatToken: ja.chatToken })).status, 403);

  // Refrescar la pagina: con el token vigente se recupera el estado, y el
  // cupo es el que le quedaba (6 - 4), no uno nuevo.
  const estado = await chatPost('/estado', { leadId: jb.leadId, chatToken: jb.chatToken });
  assert.equal(estado.status, 200);
  assert.equal((await estado.json()).questionsLeft, 2);
});

test('solicitudes: rechazar pide motivo, no crea nada, y no se puede aprobar despues', async () => {
  const email = `test-public-signup-rechazo-${Date.now()}@example.com`;
  createdUserEmails.push(email);
  const res = await registrar({ name: 'R', companyName: 'Empresa Rechazada (test)', email });
  if (res.status === 503) return;
  const { leadId } = await res.json();
  const rechazar = (body) => fetch(`${BASE_URL}/api/solicitudes-alta/${leadId}/rechazar`, {
    method: 'POST', headers: { ...headersSuperadmin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await rechazar({})).status, 400, 'sin motivo no');
  assert.equal((await rechazar({ motivo: 'No es una empresa real' })).status, 200);
  const [[lead]] = await db.query('SELECT status, review_note, tenant_id FROM signup_leads WHERE id = ?', [leadId]);
  assert.deepEqual({ ...lead }, { status: 'rejected', review_note: 'No es una empresa real', tenant_id: null });
  assert.equal((await aprobar(leadId)).status, 409);
});

test('alta: un mail invalido o un texto larguisimo no entran', async () => {
  const malo = await registrar({ name: 'X', companyName: 'Y', email: 'no-es-un-mail' });
  if (malo.status === 503) return;
  assert.equal(malo.status, 400);
  const email = `test-public-signup-largo-${Date.now()}@example.com`;
  createdUserEmails.push(email);
  const largo = await registrar({ name: 'N'.repeat(5000), companyName: '<b>Empresa</b> ' + 'E'.repeat(5000), email });
  assert.equal(largo.status, 201);
  const [[f]] = await db.query('SELECT CHAR_LENGTH(name) AS n, CHAR_LENGTH(company_name) AS c FROM signup_leads WHERE email = ?', [email]);
  assert.deepEqual({ ...f }, { n: 150, c: 150 }, 'se recorta al largo de la columna');
});

test('POST /api/public/signup: rechaza un captcha invalido sin crear nada', async () => {
  const email = `test-public-signup-badcaptcha-${Date.now()}@example.com`;

  // Fuerza la secret "always fails" solo para este pedido no es posible
  // desde el cliente (la secret vive en el servidor) -- en cambio, se
  // manda un token vacio, que turnstileService ya rechaza sin llamar a
  // Cloudflare (missing-input-response).
  const res = await fetch(`${BASE_URL}/api/public/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turnstileToken: '',
      name: 'Bot',
      companyName: 'Empresa Bot',
      email
    })
  });

  if (res.status === 503) {
    console.log('  (saltado: TURNSTILE_SECRET_KEY no configurada en el servidor real)');
    return;
  }

  assert.equal(res.status, 400);
  const [[row]] = await db.query('SELECT id FROM app_users WHERE email = ?', [email]);
  assert.equal(row, undefined, 'no debe haberse creado ninguna cuenta');
});

test('alta: un mail que YA tiene cuenta recibe la MISMA respuesta, y no se crea nada ni se le manda ningun mail', async () => {
  const email = `test-public-signup-dup-${Date.now()}@example.com`;
  createdUserEmails.push(email);

  const first = await registrar({ name: 'A', companyName: 'Empresa Dup 1', email });
  const firstJson = await first.json();
  if (first.status === 503) {
    console.log('  (saltado: TURNSTILE_SECRET_KEY no configurada en el servidor real)');
    return;
  }
  assert.equal(first.status, 201, JSON.stringify(firstJson));
  // La cuenta existe recien cuando el superadmin aprueba.
  assert.equal((await aprobar(firstJson.leadId)).status, 200);
  const [[lead1]] = await db.query('SELECT tenant_id FROM signup_leads WHERE id = ?', [firstJson.leadId]);
  createdTenantIds.push(lead1.tenant_id);

  // F-04: la respuesta es igual a la de una solicitud nueva. Antes era 409
  // "ese email ya tiene cuenta", que dejaba averiguar que mails son clientes.
  const second = await registrar({ name: 'A', companyName: 'Empresa Dup 2', email });
  const secondJson = await second.json();
  assert.equal(second.status, 201, JSON.stringify(secondJson));
  assert.deepEqual(Object.keys(secondJson).sort(), Object.keys(firstJson).sort(), 'misma forma de respuesta');
  assert.equal(secondJson.pendiente, firstJson.pendiente);

  // No se crea una segunda empresa, y NO aparece como solicitud a aprobar.
  const [[dupTenant]] = await db.query('SELECT id FROM tenants WHERE name = ?', ['Empresa Dup 2']);
  assert.equal(dupTenant, undefined);
  const [[lead2]] = await db.query('SELECT status, tenant_id, error_message FROM signup_leads WHERE id = ?', [secondJson.leadId]);
  assert.equal(lead2.status, 'failed');
  assert.equal(lead2.tenant_id, null);
  assert.match(lead2.error_message, /Ya tiene cuenta/);
  assert.match(lead2.error_message, /ni se mando ningun mail/);
  assert.equal((await aprobar(secondJson.leadId)).status, 409, 'no se puede aprobar: ya tiene cuenta');

  // Y si insiste, no se acumulan filas.
  const third = await (await registrar({ name: 'A', companyName: 'Empresa Dup 3', email })).json();
  assert.equal(third.leadId, secondJson.leadId);
});

// Crea un lead de prueba con su token de chat ya armado. Devuelve el token
// en claro, que es lo unico que el cliente llega a ver en la vida real (en
// la base queda solo el hash).
async function crearLeadConToken({ email, preguntasUsadas = 0 }) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const [r] = await db.query(
    `INSERT INTO signup_leads (name, company_name, email, status, chat_questions_used, chat_token_hash)
     VALUES ('T', 'T', ?, 'provisioned', ?, ?)`,
    [email, preguntasUsadas, hash]
  );
  createdLeadIds.push(r.insertId);
  return { leadId: r.insertId, token };
}

test('POST /api/public/chat: si ya se llego al limite de preguntas, no llama a la IA y avisa', async () => {
  const { leadId, token } = await crearLeadConToken({ email: 'chat-limit-test@example.com', preguntasUsadas: 6 });

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, chatToken: token, message: '¿cuánto cuesta?' })
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.limitReached, true);
  assert.equal(json.questionsLeft, 0);
});

test('POST /api/public/chat: sin ANTHROPIC_API_KEY configurada, 503 claro (no un error generico)', async () => {
  const { leadId, token } = await crearLeadConToken({ email: 'chat-noapikey-test@example.com' });

  // No podemos des-configurar la variable del PROCESO DEL SERVIDOR desde
  // este test (corre en otro proceso) -- si el servidor real ya tiene la
  // key puesta, este test se salta en vez de fallar por una precondicion
  // que no controla.
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('  (saltado: el proceso del servidor tiene ANTHROPIC_API_KEY configurada)');
    return;
  }

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, chatToken: token, message: '¿cuánto cuesta?' })
  });
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// Hallazgo F-02 de la auditoria: el chat era la unica ruta que llama a la API
// de Anthropic alcanzable sin cuenta, y se identificaba con el leadId a
// secas. Como es AUTO_INCREMENT, cualquiera podia recorrer ids ajenos y
// gastar preguntas con NUESTRA clave, ademas de recibir como contexto el
// historial de otro prospecto. Estos tests cierran esa puerta.
// ---------------------------------------------------------------------------

test('SEGURIDAD: el chat con un leadId ajeno y sin token se rechaza', async () => {
  const { leadId } = await crearLeadConToken({ email: 'chat-sin-token@example.com' });

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, message: 'gasto tu cuota de API' })
  });
  assert.equal(res.status, 403, 'adivinar el id ya no alcanza para usar el chat');

  // Y lo que mas importa: no se consumio una pregunta ni se llamo a la IA.
  const [[lead]] = await db.query('SELECT chat_questions_used FROM signup_leads WHERE id = ?', [leadId]);
  assert.equal(lead.chat_questions_used, 0);
});

test('SEGURIDAD: el token de un lead no sirve para otro', async () => {
  const victima = await crearLeadConToken({ email: 'chat-victima@example.com' });
  const atacante = await crearLeadConToken({ email: 'chat-atacante@example.com' });

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: victima.leadId, chatToken: atacante.token, message: 'hola' })
  });
  assert.equal(res.status, 403, 'tener UN token valido no habilita a usar el lead de otro');

  const [[lead]] = await db.query('SELECT chat_questions_used FROM signup_leads WHERE id = ?', [victima.leadId]);
  assert.equal(lead.chat_questions_used, 0);
});

test('SEGURIDAD: un lead inexistente responde igual que un token invalido', async () => {
  // Misma respuesta a proposito: si "no existe" y "token equivocado" se
  // distinguieran, el endpoint serviria para averiguar que ids existen, que
  // es el primer paso del ataque.
  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: 999999999, chatToken: 'a'.repeat(64), message: 'hola' })
  });
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.match(json.error, /no se pudo validar la sesión/i);
});

test('SEGURIDAD: un mensaje larguisimo se rechaza antes de llegar a la IA', async () => {
  // Sin este tope, el unico limite era el 1MB de express.json(): ese texto se
  // manda entero a Anthropic (se paga por token) y ademas queda en el
  // historial, que se reenvia en cada mensaje siguiente.
  const { leadId, token } = await crearLeadConToken({ email: 'chat-largo@example.com' });

  const res = await fetch(`${BASE_URL}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, chatToken: token, message: 'a'.repeat(5000) })
  });
  assert.equal(res.status, 400);

  const [[lead]] = await db.query('SELECT chat_questions_used FROM signup_leads WHERE id = ?', [leadId]);
  assert.equal(lead.chat_questions_used, 0, 'no se consume una pregunta por un mensaje rechazado');
});

test('chat: el cupo de preguntas es por MAIL, no por envio del formulario', async () => {
  // Reportado el 2026-10-01: refrescar y volver a completar el formulario
  // regalaba otras 6 preguntas (cada una se paga).
  const email = `chat-cupo-${Date.now()}@example.com`;
  createdUserEmails.push(email);
  await crearLeadConToken({ email, preguntasUsadas: 4 });
  const otro = await crearLeadConToken({ email: email.toUpperCase(), preguntasUsadas: 2 });

  const estado = await (await chatPost('/estado', { leadId: otro.leadId, chatToken: otro.token })).json();
  assert.equal(estado.questionsLeft, 0, '4 + 2 = 6: sin preguntas, aunque esta fila tenga solo 2');
  assert.equal(estado.limitReached, true);
  const res = await (await chatPost('', { leadId: otro.leadId, chatToken: otro.token, message: 'hola' })).json();
  assert.equal(res.limitReached, true, 'manda a WhatsApp sin llamar a la IA');
});

test('chat/estado: sin token valido no devuelve la conversacion de nadie', async () => {
  const { leadId } = await crearLeadConToken({ email: 'chat-estado-ajeno@example.com' });
  await db.query('UPDATE signup_leads SET chat_history = ? WHERE id = ?', [JSON.stringify([{ role: 'user', content: 'dato privado' }]), leadId]);
  const res = await chatPost('/estado', { leadId, chatToken: 'a'.repeat(64) });
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes('dato privado'));
});

test('chat/estado: una respuesta vieja con mal trato no se vuelve a mostrar', async () => {
  const { leadId, token } = await crearLeadConToken({ email: 'chat-estado-trato@example.com' });
  await db.query('UPDATE signup_leads SET chat_history = ? WHERE id = ?',
    [JSON.stringify([{ role: 'user', content: 'cómo hago' }, { role: 'assistant', content: 'Muy fácil, boludo.' }]), leadId]);
  const { history } = await (await chatPost('/estado', { leadId, chatToken: token })).json();
  assert.equal(history[0].content, 'cómo hago');
  assert.ok(!/boludo/i.test(history[1].content));
});
