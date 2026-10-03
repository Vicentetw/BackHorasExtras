# Seguridad de la web (navegador ↔ sistema)

Revisión del 2026-10-03. El sistema guarda datos personales de empleados
(nombres, documentos, horarios, ausencias), así que se revisó qué puede hacer
un sitio ajeno, o un código inyectado, contra un usuario que tiene la sesión
abierta. Hay cuatro cambios, de la A a la D.

---

## A. CORS: qué sitios pueden usar la API desde un navegador

**El concepto.** Cuando una página abierta en `sitio-x.com` le pide datos a
nuestra API, el navegador primero pregunta al servidor: "¿le dejás a sitio-x
leer tu respuesta?". El servidor contesta con la cabecera
`Access-Control-Allow-Origin`. Si no la manda, el navegador no le entrega la
respuesta a la página. Eso es CORS. Es lo que impide que una página
cualquiera, abierta en otra pestaña, use tu sesión para leer datos del
sistema.

**El error que había.** En `security.js` se usaba
`cors({ origin: corsOptionsDelegate })`. La librería llama a la función
`origin` con el *texto* del origen ("https://sitio-x.com"), pero la función
esperaba el *pedido completo* (`req`). Entonces `req.headers` no existía, el
origen quedaba vacío y la función contestaba "permitido" siempre. Se comprobó
contra producción: con `Origin: https://sitio-malicioso.example`, el
servidor respondía `Access-Control-Allow-Origin: https://sitio-malicioso.example`.

Hoy el riesgo era bajo, porque el token de sesión no viaja solo (lo agrega el
código del sistema). Pero era una puerta abierta que no tenía por qué estarlo.

**El arreglo:**
- `cors(corsOptionsDelegate)`: la forma correcta, en la que la librería le
  pasa el pedido a la función y espera las opciones de vuelta.
- La regla está en `origenesPermitidos.js`, sin dependencias, para poder
  probarla sola.
- Los sitios propios (`horasdedicacionavp.web.app`, `.firebaseapp.com` y sus
  vistas previas `horasdedicacionavp--algo.web.app`) quedan **fijos en el
  código**. Como el filtro dejaba pasar todo, un error en la variable
  `CORS_ORIGINS` de Render habría pasado inadvertido, y al arreglar el filtro
  el sistema se habría quedado mudo. Con los sitios propios fijos eso no
  puede pasar. La variable sigue sirviendo para **agregar** otros (la
  landing cuando tenga su sitio).
- Segunda capa, `rechazarOrigenAjeno`: un pedido de un navegador en un sitio
  ajeno se corta con **403** antes de llegar a cualquier ruta. CORS solo
  impide *leer* la respuesta; sin esta capa, el pedido igual se ejecutaría
  (por ejemplo, un formulario de otro sitio que hace POST).
- Sin cabecera `Origin` (el agente de los relojes, curl), todo funciona igual
  que antes: CORS es una regla de navegadores.

Test: `test/cors.test.js`.

## B. Cabeceras de seguridad del sitio (Firebase Hosting)

Están en `firebase.json` del frontend. Cada una le da una orden al navegador:

| Cabecera | Qué evita |
|---|---|
| `X-Frame-Options: DENY` y `frame-ancestors 'none'` | Que otro sitio meta el sistema dentro de un iframe invisible y engañe al usuario para que haga clic donde no quiere (*clickjacking*). Son dos cabeceras para lo mismo: la vieja y la moderna |
| `X-Content-Type-Options: nosniff` | Que el navegador "adivine" que un archivo es un script cuando el servidor dice que es otra cosa |
| `Referrer-Policy: strict-origin-when-cross-origin` | Que al salir del sistema hacia otro sitio, la dirección completa (con datos en la URL) viaje a ese sitio. Solo viaja el dominio |
| `Permissions-Policy` | Apaga cámara, micrófono, pagos y USB. Deja la ubicación (`geolocation=(self)`) para el futuro fichaje con celular, y el portapapeles (los botones "copiar" de claves e invitaciones) |

`Strict-Transport-Security` (forzar https) ya la mandaba Firebase sola.

**Lo que NO se puso, a propósito:** `Cross-Origin-Opener-Policy`. Cortaría la
comunicación con el popup de "Ingresar con Google".

## C. CSP: Política de Seguridad de Contenido

**El concepto.** Es la defensa más fuerte contra el robo de sesiones. Si
alguien consigue meter un `<script>` en una página (un *XSS*: por ejemplo,
un nombre de empleado con código adentro que algún día se muestre sin
escapar), ese script corre con la sesión del usuario y puede leer todo. La
CSP es una lista de lugares desde donde la página puede cargar código,
estilos, conexiones e iframes. El navegador se niega a ejecutar lo que no
esté en la lista, incluido el código escrito dentro del HTML.

**La política** (en `firebase.json`):

| Directiva | Permite |
|---|---|
| `default-src 'self'` | Por defecto, solo nuestro propio sitio |
| `script-src` | Nuestro sitio, Google (login), Cloudflare (captcha) y un script en línea de Angular autorizado por su huella `sha256-…` |
| `style-src` | Nuestro sitio, Google Fonts, y estilos en línea (Angular Material los usa. Inyectar estilos es mucho menos peligroso que inyectar scripts) |
| `connect-src` | Nuestro backend de Render y los servicios de login de Google |
| `frame-src` | El iframe de login de Firebase y el captcha |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | Cierran tres trucos clásicos de inyección |

**Por qué la landing ahora tiene `landing.js`.** Su código estaba escrito
dentro del HTML. Una CSP que permita eso también permite el código
inyectado, y entonces no sirve. Se movió tal cual a un archivo aparte.

**Cómo se sale a producción: primero "solo reportar".** Una CSP demasiado
estricta rompe cosas legítimas. Por eso sale como
`Content-Security-Policy-Report-Only`: el navegador **no bloquea nada**, pero
cada vez que *habría* bloqueado algo le avisa al backend
(`/api/public/csp-report`, archivo `routes/cspReport.js`), que lo anota en el
log así:

```
[CSP] report script-src-elem bloquearia "https://..." en https://horasdedicacionavp.web.app/presentismo
```

Cada violación distinta se anota una vez por hora, para que nadie pueda
llenar el log mandando reportes falsos.

**Lo que ya se probó, con la CSP bloqueando de verdad** (servidor local con
la misma política, Chrome sin ventana, usuario superadmin): las 28 pantallas
del sistema, exportar Excel y PDF, importar empleados desde Excel, la landing
y el login con Google (popup e iframe). **Cero bloqueos.**

### Paso pendiente: activar el bloqueo

Después de **una semana de uso real**, mirar en Render → Logs y buscar `[CSP]`:
- **Si no aparece nada:** en `firebase.json` del frontend, cambiar la clave
  `Content-Security-Policy-Report-Only` por `Content-Security-Policy`, borrar
  la otra entrada `Content-Security-Policy` que hoy solo tiene
  `frame-ancestors 'none'` (la nueva ya lo incluye) y desplegar con
  `npm run deploy:live`. Dejar el `report-uri`: así se sigue enterando de
  los bloqueos.
- **Si aparece algo legítimo** (un servicio nuestro): agregarlo a la
  directiva que dice el log.
- **Si aparecen extensiones del navegador** (`chrome-extension://…`):
  ignorarlas, no son nuestras.

### Cuidado al agregar cosas nuevas

Cualquier servicio externo nuevo en el frontend (Sentry, el SDK de
MercadoPago, mapas para el fichaje con celular, otra tipografía) **tiene que
agregarse a la CSP**. Si no, con el bloqueo activado, no carga. Y nunca
volver a escribir `<script>` con código adentro de un HTML: va en un `.js`
aparte.

## D. Librerías con fallas conocidas

| Librería | Antes | Ahora | Por qué |
|---|---|---|---|
| `firebase-admin` (backend) | 12.7 | 13.10 | La 12 traía `node-forge` con una falla en la verificación de firmas. Se eligió la 13 y no la 14 porque la 14 exige Node 22, y no está confirmado qué versión de Node corre Render |
| `xlsx` (frontend) | 0.18.5 (npm) | 0.20.3 (sitio oficial de SheetJS) | Lee el Excel que se sube al importar empleados. La 0.18.5 tenía dos fallas al leer un archivo armado a propósito: podía colgar la pestaña o contaminar objetos de JavaScript. SheetJS dejó de publicar en npm; las versiones corregidas salen solo de `cdn.sheetjs.com`. La API es la misma |
| Angular | 22.1 | 22.2.1 | La falla del router es del renderizado en servidor, que no usamos, pero conviene estar al día. También arregla `piscina` (herramienta de compilación) |
| `firebase` (frontend) | 12.18 | 12.19 | Al día |
| Otras (`npm audit fix`) | | | Arreglos sin cambio de versión mayor |

**Lo que queda en `npm audit`, y por qué no importa:**
- Backend: `uuid` (moderada). Viene de Firestore y Storage, que el sistema no
  usa. Solo afecta a quien le pasa un buffer propio a `uuid`.
- Frontend: `@grpc/grpc-js`. Es la versión para Node de Firestore. El sistema
  no importa Firestore y el navegador nunca carga esa pieza. `npm audit` la
  marca porque viene dentro del paquete `firebase`.

## Lo que sigue dependiendo del dueño

1. **Pasar el repo del backend a privado.** Es lo más urgente: el código
   público le muestra a cualquiera cómo está armado el sistema.
2. Verificación en dos pasos para la cuenta de superadmin.
3. `MYSQL_SSL` en Render (cifrar la conexión a la base) y mandar el
   resultado de `SHOW GRANTS` (que el usuario de la base no tenga más
   permisos de los necesarios).
4. Protección de la rama `main` en GitHub.
5. `SENTRY_DSN` en Render (aviso de errores).
6. Dentro de una semana: activar el bloqueo de la CSP (ver arriba).
