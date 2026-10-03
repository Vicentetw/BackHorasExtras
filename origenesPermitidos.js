// Que sitios de internet pueden llamar a la API desde un navegador (CORS).
//
// Archivo aparte, sin dependencias, a proposito: es una regla de seguridad
// pura (entra un texto, sale si/no) y asi se puede probar sola, sin levantar
// la base ni Firebase. La usa security.js.

const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];

function isLocalHostOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

// Los sitios propios del sistema: SIEMPRE permitidos, sin depender de la
// variable CORS_ORIGINS. Es el sitio real (web.app y su alias firebaseapp.com)
// y sus canales de vista previa de Firebase ("horasdedicacionavp--algo.web.app"),
// que solo puede crear el dueño del proyecto.
//
// Por que fijos en el codigo: hasta 2026-10-03 el filtro de CORS dejaba pasar
// CUALQUIER origen (ver corsOptionsDelegate en security.js), asi que si
// CORS_ORIGINS en Render tenia un error (una barra de mas, el sitio viejo),
// nadie se iba a enterar. Al arreglar el filtro, ese error escondido habria
// dejado al sistema sin poder hablar con el servidor. Con esto, el sistema
// propio anda siempre; la variable sirve para AGREGAR otros (la landing en su
// propio sitio, otra instalacion).
//
// La regex esta anclada (^ y $): sin eso, "https://horasdedicacionavp.web.app.sitio-malicioso.example"
// tambien pasaria, porque CONTIENE el nombre propio.
const ORIGEN_PROPIO = /^https:\/\/horasdedicacionavp(--[a-z0-9-]+)?\.(web\.app|firebaseapp\.com)$/;

// ¿Un navegador que abrio una pagina en `origin` puede llamar a esta API?
function origenPermitido(origin) {
  if (ORIGEN_PROPIO.test(origin)) return true;
  if (CORS_ORIGINS.includes(origin)) return true;
  // Desarrollo: cualquier puerto de localhost, si la variable ya incluye
  // alguno (el front de `ng serve` cambia de puerto).
  return isLocalHostOrigin(origin) && CORS_ORIGINS.some(o => /localhost|127\.0\.0\.1/.test(o));
}

module.exports = { origenPermitido };
