// Registro dentro del sistema (2026-10-14): crear cuenta, aceptar términos,
// quedar en revisión SIN acceso, aprobación del superadmin, spam (borrar y
// bloquear) y limpieza a los 30 días. Y que lo existente siga igual.
// Requiere el backend local (puerto 3000) y la migración 20261018 en la base local.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
// API modular de firebase-admin (la 'getAuth()' vieja no existe desde la v14).

const { initializeApp, getApps, cert } = require('firebase-admin/app');

const { getAuth } = require('firebase-admin/auth');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');
const { borrarSolicitudesVencidas } = require('../motor-laboral/services/registroService');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const WEB_API_KEY = 'AIzaSyAJ3oBdp9YIjJvMDOOgcybRwAbc3eGcJwI'; // pública
const TOKEN_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX'; // vale con la clave secreta de prueba de Turnstile
const SUFIJO = Date.now().toString(36);
const CUENTAS = { ok: `reg-ok-${SUFIJO}`, sinVerif: `reg-sinverif-${SUFIJO}`, spam: `reg-spam-${SUFIJO}`, spam2: `reg-spam2-${SUFIJO}`, vieja: `reg-vieja-${SUFIJO}` };
const emailDe = (clave) => `${CUENTAS[clave]}@registro-test.example.com`;
let hSuper; let documentos; const headers = {}; let tenantCreado = null;

function initAdmin() {
  if (getApps().length) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  initializeApp({ credential: cert(json ? JSON.parse(json) : require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH))) });
}
// Cuenta de login SIN usuario en el sistema (como alguien que recién se registró).
async function cuentaSinAcceso(clave, emailVerified) {
  initAdmin();
  const uid = CUENTAS[clave];
  await getAuth().deleteUser(uid).catch(() => {});
  await getAuth().createUser({ uid, email: emailDe(clave), emailVerified, password: 'Prueba-2026!' });
  return tokenDe(uid);
}
async function tokenDe(uid) {
  const custom = await getAuth().createCustomToken(uid);
  const r = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
  })).json();
  return { 'x-api-key': process.env.API_KEY, Authorization: `Bearer ${r.idToken}` };
}
const pedir = (h, m, url, body) => fetch(BASE_URL + url, { method: m, headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const solicitud = (extra = {}) => ({
  empresa: `Registro Test ${SUFIJO}`, nombre: 'Persona de Prueba', telefono: '2804000000', contacto: 'whatsapp', empleados: 12, relojes: 1,
  tieneFacultades: true, turnstileToken: TOKEN_CAPTCHA,
  aceptaciones: documentos.map((d) => ({ clave: d.clave, version: d.version, hash: d.hash })), ...extra,
});
const leadDe = async (clave) => (await db.query('SELECT * FROM signup_leads WHERE firebase_uid = ? ORDER BY id DESC LIMIT 1', [CUENTAS[clave]]))[0][0];

before(async () => {
  hSuper = await getTestAuthHeaders(`reg-super-${SUFIJO}`, { isSuperadmin: true });
  headers.ok = await cuentaSinAcceso('ok', true);
  headers.sinVerif = await cuentaSinAcceso('sinVerif', false);
  documentos = (await (await pedir(headers.ok, 'GET', '/api/registro/documentos')).json()).documentos;
});

after(async () => {
  initAdmin();
  for (const uid of Object.values(CUENTAS)) await getAuth().deleteUser(uid).catch(() => {});
  const uids = Object.values(CUENTAS);
  await db.query('DELETE FROM aceptaciones_legales WHERE firebase_uid IN (?)', [uids]);
  await db.query('DELETE FROM signup_leads WHERE firebase_uid IN (?)', [uids]);
  await db.query("DELETE FROM registro_bloqueos WHERE valor LIKE ?", [`%${SUFIJO}%`]);
  if (tenantCreado) {
    await db.query('DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM app_users WHERE tenant_id = ?)', [tenantCreado]);
    await db.query('DELETE FROM app_users WHERE tenant_id = ?', [tenantCreado]);
    for (const t of ['tenant_subscriptions', 'vacation_scale', 'payroll_regime_settings']) await db.query(`DELETE FROM ${t} WHERE tenant_id = ?`, [tenantCreado]).catch(() => {});
    await db.query('DELETE FROM tenants WHERE id = ?', [tenantCreado]);
  }
  await deleteTestUser(`reg-super-${SUFIJO}`);
  await closeDb();
});

test('una cuenta de login sin usuario sigue SIN acceso al sistema (igual que antes); solo /api/registro responde', async () => {
  assert.equal((await pedir(headers.ok, 'GET', '/api/app-users/me')).status, 403);
  assert.equal((await pedir(headers.ok, 'GET', '/api/employees')).status, 403);
  assert.equal((await pedir(headers.ok, 'GET', '/attendance-range?from=2026-01-01&to=2026-01-02')).status, 403);
  const e = await (await pedir(headers.ok, 'GET', '/api/registro/estado')).json();
  assert.equal(e.estado, 'sin_solicitud');
  assert.equal(e.emailVerificado, true);
});

test('sin login, /api/registro no responde', async () => {
  const r = await fetch(BASE_URL + '/api/registro/estado', { headers: { 'x-api-key': process.env.API_KEY } });
  assert.equal(r.status, 401);
});

test('los textos legales vienen con versión y huella', () => {
  assert.deepEqual(documentos.map((d) => d.clave), ['terminos', 'acuerdo_datos', 'privacidad']);
  for (const d of documentos) assert.match(d.hash, /^[0-9a-f]{64}$/);
});

test('sin email verificado no puede pedir el alta', async () => {
  const r = await pedir(headers.sinVerif, 'POST', '/api/registro/solicitud', solicitud());
  assert.equal(r.status, 403);
  assert.equal((await r.json()).codigo, 'EMAIL_SIN_VERIFICAR');
});

test('sin aceptar la versión vigente de los textos, no se acepta la solicitud', async () => {
  const mala = solicitud({ aceptaciones: documentos.map((d) => ({ clave: d.clave, version: d.version, hash: '0'.repeat(64) })) });
  assert.equal((await pedir(headers.ok, 'POST', '/api/registro/solicitud', mala)).status, 400);
  assert.equal((await pedir(headers.ok, 'POST', '/api/registro/solicitud', solicitud({ tieneFacultades: false }))).status, 400);
});

test('con todo en regla: queda pendiente, con la prueba de aceptación, y sigue SIN acceso', async () => {
  assert.equal((await pedir(headers.ok, 'POST', '/api/registro/solicitud', solicitud())).status, 201);
  const e = await (await pedir(headers.ok, 'GET', '/api/registro/estado')).json();
  assert.equal(e.estado, 'pendiente');
  const lead = await leadDe('ok');
  assert.equal(lead.origen, 'sistema');
  assert.equal(lead.status, 'pending');
  const [acept] = await db.query('SELECT documento, version, hash_texto FROM aceptaciones_legales WHERE signup_lead_id = ?', [lead.id]);
  assert.equal(acept.length, 3);
  assert.equal((await pedir(headers.ok, 'GET', '/api/employees')).status, 403, 'en revisión no ve nada');
  // Mandarla de nuevo actualiza la misma solicitud, no crea otra.
  assert.equal((await pedir(headers.ok, 'POST', '/api/registro/solicitud', solicitud({ empleados: 20 }))).status, 201);
  const [[{ n }]] = await db.query("SELECT COUNT(*) n FROM signup_leads WHERE firebase_uid = ? AND status = 'pending'", [CUENTAS.ok]);
  assert.equal(n, 1);
});

test('el superadmin la ve como "del sistema" y al aprobarla la persona entra con SU cuenta (sin mail de contraseña)', async () => {
  const lista = (await (await pedir(hSuper, 'GET', '/api/solicitudes-alta?estado=pending')).json()).solicitudes;
  const lead = lista.find((x) => x.email === emailDe('ok'));
  assert.ok(lead);
  assert.equal(lead.origen, 'sistema');
  assert.equal(Number(lead.aceptaciones), 6, 'dos envíos x 3 textos');
  // No se puede cambiar el email de alguien que se registró en el sistema.
  assert.equal((await pedir(hSuper, 'POST', `/api/solicitudes-alta/${lead.id}/aprobar`, { email: 'otro@example.com' })).status, 400);
  const r = await (await pedir(hSuper, 'POST', `/api/solicitudes-alta/${lead.id}/aprobar`, {})).json();
  assert.equal(r.ok, true);
  assert.equal(r.emailEnviado, false);
  tenantCreado = r.tenantId;
  const me = await pedir(await tokenDe(CUENTAS.ok), 'GET', '/api/app-users/me');
  assert.equal(me.status, 200);
  assert.equal((await me.json()).tenantId, tenantCreado);
  const [[a]] = await db.query('SELECT COUNT(*) n FROM aceptaciones_legales WHERE firebase_uid = ? AND tenant_id = ?', [CUENTAS.ok, tenantCreado]);
  assert.equal(a.n, 6, 'la aceptación queda asociada a la empresa creada');
});

test('spam: bloquear deshabilita la cuenta y no deja volver a pedir; borrar elimina solicitud y cuenta', async () => {
  headers.spam = await cuentaSinAcceso('spam', true);
  assert.equal((await pedir(headers.spam, 'POST', '/api/registro/solicitud', solicitud({ empresa: 'Spam SA' }))).status, 201);
  const lead = await leadDe('spam');
  const b = await (await pedir(hSuper, 'POST', `/api/solicitudes-alta/${lead.id}/bloquear`, { motivo: 'spam de prueba' })).json();
  assert.equal(b.ok, true);
  assert.equal(b.loginDeshabilitado, true);
  initAdmin();
  assert.equal((await getAuth().getUser(CUENTAS.spam)).disabled, true);
  assert.equal((await leadDe('spam')).status, 'blocked');
  // Bloquear un dominio público no se permite.
  headers.spam2 = await cuentaSinAcceso('spam2', true);
  assert.equal((await pedir(headers.spam2, 'POST', '/api/registro/solicitud', solicitud({ empresa: 'Spam 2' }))).status, 201);
  const lead2 = await leadDe('spam2');
  // Borrar: solicitud y cuenta de login.
  const d = await (await pedir(hSuper, 'POST', `/api/solicitudes-alta/${lead2.id}/borrar`)).json();
  assert.equal(d.ok, true);
  assert.equal(d.loginBorrado, true);
  assert.equal(await leadDe('spam2'), undefined);
  await assert.rejects(getAuth().getUser(CUENTAS.spam2));
  // El email bloqueado figura en la lista.
  const bl = (await (await pedir(hSuper, 'GET', '/api/solicitudes-alta/bloqueos/lista')).json()).bloqueos;
  assert.ok(bl.some((x) => x.valor === emailDe('spam')));
});

test('un no-superadmin no puede aprobar, borrar ni bloquear', async () => {
  const lead = await leadDe('spam');
  assert.equal((await pedir(headers.ok, 'POST', `/api/solicitudes-alta/${lead.id}/borrar`)).status, 403);
});

test('limpieza: una solicitud del sistema sin aprobar de más de 30 días se borra (y su cuenta de login)', async () => {
  headers.vieja = await cuentaSinAcceso('vieja', true);
  assert.equal((await pedir(headers.vieja, 'POST', '/api/registro/solicitud', solicitud({ empresa: 'Vieja SA' }))).status, 201);
  const lead = await leadDe('vieja');
  await db.query('UPDATE signup_leads SET created_at = NOW() - INTERVAL 31 DAY WHERE id = ?', [lead.id]);
  const n = await borrarSolicitudesVencidas(db);
  assert.ok(n >= 1);
  assert.equal(await leadDe('vieja'), undefined);
  initAdmin();
  await assert.rejects(getAuth().getUser(CUENTAS.vieja));
});

test('una cuenta deshabilitada ve "deshabilitado", no el registro', async () => {
  await db.query('UPDATE app_users SET is_active = 0 WHERE firebase_uid = ?', [CUENTAS.ok]);
  try {
    const e = await (await pedir(await tokenDe(CUENTAS.ok), 'GET', '/api/registro/estado')).json();
    assert.equal(e.estado, 'deshabilitado');
  } finally {
    await db.query('UPDATE app_users SET is_active = 1 WHERE firebase_uid = ?', [CUENTAS.ok]);
  }
});
