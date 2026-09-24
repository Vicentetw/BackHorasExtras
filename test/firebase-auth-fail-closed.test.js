// Hallazgo F-01 de la auditoria de seguridad: la autenticacion fallaba ABIERTA.
//
// Si Firebase Admin no llegaba a inicializarse, firebaseAuthMiddleware hacia
// next() y TODA la API quedaba sin autenticacion. El escenario no era un
// ataque sino un despliegue con FIREBASE_SERVICE_ACCOUNT mal pegada, o una
// clave de servicio rotada: initFirebaseAdmin solo hace console.error y sigue,
// asi que el servidor arrancaba normal y respondia 200 a cualquiera.
//
// Lo unico que quedaba protegiendo era el API_KEY, que viaja en el bundle de
// Angular y esta publicado en GitHub -- o sea, nada.
//
// Estos tests son PUROS: no necesitan servidor ni base. Recargan el modulo en
// cada caso (tiene estado interno: `initialized`) y le pasan un req/res
// falsos, que es la unica forma de probar el camino "Firebase no disponible"
// sin romper de verdad las credenciales del entorno.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULO = path.resolve(__dirname, '..', 'firebaseAuth.js');

let envOriginal;

beforeEach(() => {
  envOriginal = {
    cuenta: process.env.FIREBASE_SERVICE_ACCOUNT,
    ruta: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    nodeEnv: process.env.NODE_ENV,
  };
  // El modulo guarda `initialized` entre llamadas -- sin esto, el resultado
  // de un caso se filtraria al siguiente.
  delete require.cache[MODULO];
});

afterEach(() => {
  const restaurar = (clave, valor) => {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  };
  restaurar('FIREBASE_SERVICE_ACCOUNT', envOriginal.cuenta);
  restaurar('FIREBASE_SERVICE_ACCOUNT_PATH', envOriginal.ruta);
  restaurar('NODE_ENV', envOriginal.nodeEnv);
  delete require.cache[MODULO];
});

// req/res minimos: solo lo que el middleware toca.
function hacerContexto() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let llamoNext = false;
  return { req: { headers: {} }, res, next: () => { llamoNext = true; }, seLlamoNext: () => llamoNext };
}

test('credenciales configuradas que NO cargan -> 503, nunca deja pasar', async () => {
  // El caso peligroso de verdad: alguien QUISO tener autenticacion (la
  // variable esta) y no la tiene (el JSON esta roto). Antes esto abria la
  // API entera en silencio.
  process.env.FIREBASE_SERVICE_ACCOUNT = '{esto no es json valido';
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  process.env.NODE_ENV = 'development'; // ni siquiera en desarrollo se perdona

  const { firebaseAuthMiddleware } = require(MODULO);
  const { req, res, next, seLlamoNext } = hacerContexto();
  await firebaseAuthMiddleware(req, res, next);

  assert.equal(seLlamoNext(), false, 'no puede dejar pasar el pedido');
  assert.equal(res.statusCode, 503);
});

test('sin credenciales y en produccion -> 503', async () => {
  // Un servidor productivo sin autenticacion no es un servidor productivo.
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  process.env.NODE_ENV = 'production';

  const { firebaseAuthMiddleware } = require(MODULO);
  const { req, res, next, seLlamoNext } = hacerContexto();
  await firebaseAuthMiddleware(req, res, next);

  assert.equal(seLlamoNext(), false);
  assert.equal(res.statusCode, 503);
});

test('sin credenciales y fuera de produccion -> pasa (desarrollo local sigue andando)', async () => {
  // El unico caso que deja pasar, y a proposito: trabajar en local sin una
  // service account es legitimo y no se quiere romper. La diferencia con el
  // primer test es que aca nadie intento configurar nada.
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  process.env.NODE_ENV = 'development';

  const { firebaseAuthMiddleware } = require(MODULO);
  const { req, res, next, seLlamoNext } = hacerContexto();
  await firebaseAuthMiddleware(req, res, next);

  assert.equal(seLlamoNext(), true);
  assert.equal(res.statusCode, null, 'no responde nada, deja seguir la cadena');
});

test('el 503 no revela por que fallo', async () => {
  // Un atacante no tiene por que enterarse de si falta la credencial, si el
  // JSON esta roto o si la clave fue revocada. El detalle va al log del
  // servidor, no a la respuesta.
  process.env.FIREBASE_SERVICE_ACCOUNT = 'roto';
  process.env.NODE_ENV = 'production';

  const { firebaseAuthMiddleware } = require(MODULO);
  const { req, res, next } = hacerContexto();
  await firebaseAuthMiddleware(req, res, next);

  const texto = JSON.stringify(res.body).toLowerCase();
  assert.ok(!texto.includes('firebase'), 'no nombra la tecnologia');
  assert.ok(!texto.includes('json'), 'ni el motivo tecnico');
});
