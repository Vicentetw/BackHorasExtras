// Registro seguro (2026-10-14): las cuentas de login las crea SOLO el
// servidor, después de sus controles. Ver cuentasDeRegistro.js.
//
// Dos partes:
//   1. el servicio, con un Firebase FALSO (para probar Google sin una cuenta
//      de Google real, y la limpieza de los 7 días sin esperar 7 días);
//   2. de punta a punta contra el backend local (puerto 3000) y el Firebase
//      REAL, incluido que Firebase rechace un alta hecha desde afuera.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const admin = require('firebase-admin');
const db = require('../db');
const cuentas = require('../motor-laboral/services/cuentasDeRegistro');
const { ErrorDeRegistro } = require('../motor-laboral/services/registroService');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const WEB_API_KEY = 'AIzaSyAJ3oBdp9YIjJvMDOOgcybRwAbc3eGcJwI'; // pública
const TOKEN_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX'; // vale con la clave secreta de prueba de Turnstile
const SUFIJO = Date.now().toString(36);
const UN_DIA = 24 * 60 * 60 * 1000;
const creadasDeVerdad = [];

function initAdmin() {
  if (admin.apps.length) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  admin.initializeApp({ credential: admin.credential.cert(json ? JSON.parse(json) : require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH))) });
}

// Firebase falso: guarda lo que se le pide.
function authFalso({ existentes = [], fallaVincular = false, usuarios = [] } = {}) {
  const llamadas = [];
  let n = 0;
  return {
    llamadas,
    async createUser(datos) {
      llamadas.push(['createUser', datos]);
      if (existentes.includes(datos.email)) throw Object.assign(new Error('existe'), { code: 'auth/email-already-exists' });
      return { uid: `falso-${++n}` };
    },
    async getUserByEmail(email) {
      if (existentes.includes(email)) return { uid: 'ya' };
      throw Object.assign(new Error('no'), { code: 'auth/user-not-found' });
    },
    async getUserByProviderUid() { throw Object.assign(new Error('no'), { code: 'auth/user-not-found' }); },
    async updateUser(uid, datos) {
      llamadas.push(['updateUser', uid, datos]);
      if (fallaVincular) throw new Error('no se pudo vincular');
    },
    async setCustomUserClaims(uid, claims) { llamadas.push(['claims', uid, claims]); },
    async deleteUser(uid) { llamadas.push(['deleteUser', uid]); },
    async listUsers() { return { users: usuarios }; },
    async deleteUsers(uids) { llamadas.push(['deleteUsers', uids]); return { successCount: uids.length, failureCount: 0, errors: [] }; },
  };
}
const esError = (codigoHttp, codigo) => (err) => err instanceof ErrorDeRegistro && err.status === codigoHttp && (!codigo || err.codigo === codigo);

// --- 1. El servicio ----------------------------------------------------------

test('datos inválidos se rechazan ANTES de tocar Firebase', () => {
  const v = cuentas.validarCuentaConEmail;
  assert.throws(() => v({ email: 'no-es-email', password: 'Clave-segura-1' }), esError(400));
  assert.throws(() => v({ email: 'ana@empresa.com', password: 'corta' }), esError(400));
  assert.throws(() => v({ email: 'ana@empresa.com', password: 'ana@empresa.com' }), esError(400));
  assert.throws(() => v({ email: 'ana@empresa.com', password: 'aaaaaaaaaa' }), esError(400));
  assert.throws(() => v({ email: 'ana@mailinator.com', password: 'Clave-segura-1' }), esError(400, 'DESCARTABLE'));
  assert.deepEqual(v({ email: '  Ana@Empresa.com ', password: 'Clave-segura-1' }), { email: 'ana@empresa.com', password: 'Clave-segura-1' });
});

test('con email: crea la cuenta SIN verificar y con la marca "registro"', async () => {
  const auth = authFalso();
  const r = await cuentas.crearCuentaConEmail(db, { email: 'Ana@Empresa.com', password: 'Clave-segura-1' }, { auth });
  assert.equal(r.email, 'ana@empresa.com');
  assert.deepEqual(auth.llamadas[0], ['createUser', { email: 'ana@empresa.com', password: 'Clave-segura-1', emailVerified: false }]);
  assert.deepEqual(auth.llamadas[1], ['claims', 'falso-1', { registro: true }]);
});

test('con email: si ya existe, 409 con un mensaje que manda a Ingresar', async () => {
  const auth = authFalso({ existentes: ['ana@empresa.com'] });
  await assert.rejects(cuentas.crearCuentaConEmail(db, { email: 'ana@empresa.com', password: 'Clave-segura-1' }, { auth }), esError(409, 'YA_EXISTE'));
});

const googleOk = async () => ({ sub: 'google-123', email: 'Beto@Gmail.com', email_verified: true, name: 'Beto Pérez' });

test('con Google: crea la cuenta con el email verificado y Google vinculado', async () => {
  const auth = authFalso();
  const r = await cuentas.crearCuentaConGoogle(db, { idToken: 'x' }, { auth, verificarGoogle: googleOk });
  assert.equal(r.email, 'beto@gmail.com');
  assert.deepEqual(auth.llamadas[0], ['createUser', { email: 'beto@gmail.com', emailVerified: true, displayName: 'Beto Pérez' }]);
  assert.deepEqual(auth.llamadas[1], ['updateUser', 'falso-1',
    { providerToLink: { providerId: 'google.com', uid: 'google-123', email: 'beto@gmail.com', displayName: 'Beto Pérez' } }]);
  assert.deepEqual(auth.llamadas[2], ['claims', 'falso-1', { registro: true }]);
});

test('con Google: un email que Google NO verificó no sirve', async () => {
  const auth = authFalso();
  await assert.rejects(cuentas.crearCuentaConGoogle(db, { idToken: 'x' },
    { auth, verificarGoogle: async () => ({ sub: 'g', email: 'x@empresa.com', email_verified: false }) }), esError(400));
  assert.equal(auth.llamadas.length, 0, 'no se creó nada');
});

test('con Google: si el email ya tiene cuenta, 409 y no se crea nada', async () => {
  const auth = authFalso({ existentes: ['beto@gmail.com'] });
  await assert.rejects(cuentas.crearCuentaConGoogle(db, { idToken: 'x' }, { auth, verificarGoogle: googleOk }), esError(409, 'YA_EXISTE'));
  assert.equal(auth.llamadas.length, 0);
});

test('con Google: si no se puede vincular, la cuenta a medias se borra', async () => {
  const auth = authFalso({ fallaVincular: true });
  await assert.rejects(cuentas.crearCuentaConGoogle(db, { idToken: 'x' }, { auth, verificarGoogle: googleOk }));
  assert.deepEqual(auth.llamadas.at(-1), ['deleteUser', 'falso-1']);
});

test('limpieza de 7 días: solo cuentas del registro, viejas y sin uso', async () => {
  const ahora = Date.now();
  const cuenta = (uid, dias, registro = true) => ({ uid, customClaims: registro ? { registro: true } : {}, metadata: { creationTime: new Date(ahora - dias * UN_DIA).toUTCString() } });
  const uid = (s) => `limpieza-${s}-${SUFIJO}`;
  // Una con solicitud y otra con usuario en el sistema: esas NO se tocan.
  await db.query(`INSERT INTO signup_leads (name, company_name, email, status, firebase_uid, origen) VALUES ('T', 'T', ?, 'pending', ?, 'sistema')`,
    [`${uid('solicitud')}@x.example.com`, uid('solicitud')]);
  await db.query('INSERT INTO app_users (firebase_uid, email, tenant_id, is_superadmin, is_active) VALUES (?, ?, NULL, 0, 0)',
    [uid('usuario'), `${uid('usuario')}@x.example.com`]);
  try {
    const auth = authFalso({ usuarios: [
      cuenta(uid('abandonada'), 8),
      cuenta(uid('solicitud'), 8),
      cuenta(uid('usuario'), 8),
      cuenta(uid('reciente'), 2),
      cuenta(uid('invitada'), 30, false), // creada al invitar a un usuario: sin marca
    ] });
    const n = await cuentas.borrarCuentasSinUso(db, { auth, ahora });
    assert.equal(n, 1);
    assert.deepEqual(auth.llamadas, [['deleteUsers', [uid('abandonada')]]]);
  } finally {
    await db.query('DELETE FROM signup_leads WHERE firebase_uid = ?', [uid('solicitud')]);
    await db.query('DELETE FROM app_users WHERE firebase_uid = ?', [uid('usuario')]);
  }
});

// --- 2. De punta a punta -----------------------------------------------------

const pedir = (url, body) => fetch(BASE_URL + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('Firebase rechaza un alta hecha desde afuera (el alta está cerrada)', async () => {
  // Esto es lo que hizo pepe@gmail.com. Si este test falla, alguien volvió a
  // habilitar "Enable create (sign-up)" en Firebase (proyecto asistenciatw).
  const r = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `intruso-${SUFIJO}@registro-test.example.com`, password: 'Clave-segura-1', returnSecureToken: true }),
  })).json();
  if (r.localId) { initAdmin(); await admin.auth().deleteUser(r.localId).catch(() => {}); }
  assert.ok(r.error, 'Firebase NO debería haber creado la cuenta');
  assert.match(r.error.message, /ADMIN_ONLY_OPERATION/);
});

test('POST /api/public/registro/cuenta crea la cuenta, y con ella se puede entrar', async () => {
  const email = `seguro-${SUFIJO}@registro-test.example.com`;
  const res = await pedir('/api/public/registro/cuenta', { email, password: 'Clave-segura-1', turnstileToken: TOKEN_CAPTCHA });
  assert.equal(res.status, 201, await res.clone().text());
  initAdmin();
  const u = await admin.auth().getUserByEmail(email);
  creadasDeVerdad.push(u.uid);
  assert.equal(u.emailVerified, false);
  assert.deepEqual(u.customClaims, { registro: true });
  // Entrar (no es un alta) funciona con el alta cerrada.
  const login = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Clave-segura-1', returnSecureToken: true }),
  })).json();
  assert.ok(login.idToken, JSON.stringify(login.error || {}));

  // El mismo email otra vez: 409.
  const otra = await pedir('/api/public/registro/cuenta', { email, password: 'Clave-segura-1', turnstileToken: TOKEN_CAPTCHA });
  assert.equal(otra.status, 409);
  assert.equal((await otra.json()).codigo, 'YA_EXISTE');
});

test('sin captcha, con datos malos o con email descartable no se crea nada', async () => {
  const email = `sincaptcha-${SUFIJO}@registro-test.example.com`;
  assert.equal((await pedir('/api/public/registro/cuenta', { email, password: 'Clave-segura-1' })).status, 400);
  assert.equal((await pedir('/api/public/registro/cuenta', { email, password: 'corta', turnstileToken: TOKEN_CAPTCHA })).status, 400);
  assert.equal((await pedir('/api/public/registro/cuenta', { email: `x-${SUFIJO}@yopmail.com`, password: 'Clave-segura-1', turnstileToken: TOKEN_CAPTCHA })).status, 400);
  initAdmin();
  await assert.rejects(admin.auth().getUserByEmail(email), (e) => e.code === 'auth/user-not-found');
});

test('con Google: un certificado falso o vencido se rechaza', async () => {
  const res = await pedir('/api/public/registro/cuenta-google', { idToken: 'eyJhbGciOiJSUzI1NiJ9.e30.firma-falsa', turnstileToken: TOKEN_CAPTCHA });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).codigo, 'GOOGLE_INVALIDO');
});

after(async () => {
  initAdmin();
  for (const uid of creadasDeVerdad) await admin.auth().deleteUser(uid).catch(() => {});
  await db.end().catch(() => {});
});
