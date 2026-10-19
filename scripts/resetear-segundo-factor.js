// EMERGENCIA: sacarle el segundo factor a una cuenta (2026-10-19).
//
// Para cuando el ÚNICO superadmin pierde el celular y no tiene otra forma de
// entrar (ver "Si perdés el celular" en ESTADO_PROYECTO.md). Lo normal es
// resetearlo desde la app (Empresas → la empresa → "Resetear (perdió el
// celular)"), pero eso necesita a otro superadmin adentro.
//
// Usa la llave del servidor ante Firebase (FIREBASE_SERVICE_ACCOUNT del .env):
// se corre SOLO desde una PC de confianza que tenga ese .env.
//
//   node scripts/resetear-segundo-factor.js tu-email@ejemplo.com
//
// Qué hace: saca los segundos factores de esa cuenta y cierra sus sesiones.
// Al entrar de nuevo (con la contraseña), si es obligatorio, el sistema lo
// lleva a activarlo con el celular nuevo.
require('dotenv').config({ quiet: true });
const { initFirebaseAdmin } = require('../firebaseAuth');
const { getAuth } = require('firebase-admin/auth');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Uso: node scripts/resetear-segundo-factor.js email@de-la-cuenta');
    process.exit(1);
  }
  initFirebaseAdmin();
  const auth = getAuth();
  const u = await auth.getUserByEmail(email);
  const antes = (u.multiFactor && u.multiFactor.enrolledFactors || []).length;
  await auth.updateUser(u.uid, { multiFactor: { enrolledFactors: null } });
  await auth.revokeRefreshTokens(u.uid);
  console.log(`Listo: ${email} tenía ${antes} segundo(s) factor(es); ahora 0. Se cerraron sus sesiones.`);
  console.log('Entrá con la contraseña y, si es obligatorio, activalo de nuevo con el celular nuevo.');
  process.exit(0);
})().catch((err) => { console.error('No se pudo:', err.message); process.exit(1); });
