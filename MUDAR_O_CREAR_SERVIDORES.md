# Mudar los servidores o crear 3 nuevos — paso a paso (2026-10-18)

> Para el dueño. Sirve para dos cosas:
> - **Mudar:** reemplazar los servidores de hoy por otros. Por ejemplo, porque
>   el repositorio pasa a privado y Render tiene que conectarse de otra forma,
>   o porque se cambia de proveedor.
> - **Crear 3 nuevos para pruebas** ("staging", Fase 3 de
>   `PLAN_LISTO_PARA_VENDER.md`): los mismos pasos, con otros nombres y datos
>   anonimizados.
>
> Este documento no tiene contraseñas: dice **qué** variable va en cada lugar
> y **de dónde** sale su valor.

---

## 0. Primero entender las piezas

El sistema tiene **3 servidores** y **un servicio de login** que **no** se muda:

| # | Pieza | Qué hace | Dónde está hoy |
|---|---|---|---|
| 1 | **Base de datos** (MySQL) | Guarda todo: empleados, fichajes, configuración. | Clever Cloud |
| 2 | **Servidor de la aplicación** (backend) | Hace los cálculos y atiende a las pantallas, al agente del reloj y a MercadoPago. | Render: `academypruebadep.onrender.com` |
| 3 | **Páginas** (la app y la de venta) | Lo que se ve en el navegador. | Firebase Hosting: `horasdedicacionavp.web.app` (app) + landing aparte |
| — | **Login** (Firebase Authentication) | Usuarios y contraseñas, segundo factor. | Proyecto Firebase `asistenciatw`: **queda igual**, no se muda |

**Analogía:**
- La base es el **archivo** con todas las carpetas.
- El servidor es la **oficina** donde se trabaja con esas carpetas.
- Las páginas son la **vidriera** que ve el cliente.

Mudarse es abrir una oficina nueva, llevar el archivo, cambiar la dirección en
la vidriera y **avisarles a todos los que mandan cartas a la dirección vieja**.

### Quién "manda cartas" a la dirección del servidor (lo que más se olvida)

- La **app** (las páginas): tiene la dirección del servidor escrita.
- La **página de venta** (landing): idem.
- El **agente del reloj**, en la PC de **cada empresa** cliente: tiene la
  dirección en su archivo de configuración (`[servidor]`). Si no se cambia, los
  fichajes dejan de llegar.
- **MercadoPago**: avisa los pagos a `/webhooks/mercadopago`.
- **GitHub** (la acción que corre migraciones): tiene los datos de la base.

---

## 1. La mejor decisión antes de mudarse: direcciones propias

Hoy las direcciones son las que dio cada proveedor (`...onrender.com`,
`...web.app`). Si se cambia de servidor, cambia la dirección, y hay que tocar
todo lo de arriba, **incluida la PC de cada cliente**.

Con un dominio propio (ej. `horasdedica.com.ar`), que cuesta pocos miles de
pesos por año en NIC Argentina:
- `app.horasdedica.com.ar` → la app (Firebase Hosting lo permite gratis).
- `api.horasdedica.com.ar` → el servidor (Render lo permite gratis).
- `horasdedica.com.ar` → la página de venta.

La próxima mudanza solo cambia **a dónde apunta** `api.`, desde la
configuración del dominio, y nadie más tiene que tocar nada. **Recomendación:
hacer esta mudanza ya con dominio propio, así es la última vez que se cambian
direcciones en los clientes.** Además, un dominio propio da más confianza al
vender.

---

## 2. Reglas de oro

1. **No borrar nada viejo** hasta que lo nuevo funcione al menos 1 o 2
   semanas.
2. **Backup fresco** justo antes de empezar (el de la noche anterior más uno
   manual en el momento).
3. **De noche o en fin de semana:** mientras se copia la base, lo que se cargue
   en la vieja no llega a la nueva.
4. **Orden:** base → servidor → páginas → los que "mandan cartas" →
   verificar → recién después apagar lo viejo.
5. **Plan para volver atrás** (al final de este documento) leído antes de
   empezar.

---

## 3. Paso a paso

### Paso 1 — Base de datos nueva (Clever Cloud u otro MySQL 8)
1. Crear la base: Clever Cloud → **Create → an add-on → MySQL**, versión 8,
   misma región. Para pruebas (staging) alcanza con el plan chico.
2. Anotar los datos de conexión que muestra (host, puerto, base, usuario,
   contraseña) en un lugar seguro, **no** en un archivo del repositorio.
3. Avisar a la empresa (o pausar el agente del reloj) para que no entren
   fichajes durante la copia.
4. Backup de la base vieja en ese momento (como el de todas las noches).
5. Cargar el backup en la base nueva (se puede pedir a Claude: mismo método
   que se usa para la copia local, apuntando a la base nueva).
6. **Verificar:** cantidad de empleados, de fichajes del último mes y de
   empresas iguales en las dos bases.
7. **Para pruebas (staging):** antes de usarla, **anonimizar** (nombres,
   legajos, DNI y emails reemplazados). Nunca datos reales en un entorno de
   pruebas.

### Paso 2 — Servidor nuevo (Render)
1. Render → **Account Settings → Git → GitHub**: conectar la cuenta de GitHub
   e instalar la app de Render con acceso al repositorio `BackHorasExtras`.
   Así ve el repositorio aunque sea **privado**.
2. **New → Web Service** → elegir `BackHorasExtras`, rama `main`.
   - Build: `npm ci` · Start: `node horasdedica.js`.
   - Node: lo toma solo del archivo `.node-version` (22).
   - Health check path: `/health`.
   - Plan: uno que **no se duerma** para producción. Para pruebas, el gratis
     alcanza.
3. **Environment:** cargar estas variables. Los valores se copian del servicio
   viejo (Render → servicio viejo → Environment), salvo los que cambian:

| Variable | Qué es | Valor en el servidor nuevo |
|---|---|---|
| `MYSQL_ADDON_HOST`, `_PORT`, `_DB`, `_USER`, `_PASSWORD` | Conexión a la base | **Los de la base NUEVA** (paso 1) |
| `MYSQL_SSL` | Cifrado con la base | Empezar con `no-verify` |
| `MYSQL_SSL_CA` | "Sello" de la base | **No copiar el viejo**: es de la base vieja. Se saca después con el botón de Seguridad. |
| `NODE_ENV` | Modo | `production` (en pruebas: `staging`) |
| `FIREBASE_SERVICE_ACCOUNT` | Clave del servidor para el login | Igual que el viejo (mismo proyecto de login) |
| `FIREBASE_WEB_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID` | Login y botón de Google | Igual que el viejo |
| `API_KEY` | Clave de la aplicación (la que mandan las páginas) | Igual que el viejo |
| `CORS_ORIGINS` | Desde qué páginas se acepta | Agregar las direcciones **nuevas** de las páginas |
| `FRONTEND_URL` | Dirección de la app (vuelta de MercadoPago) | La dirección de la app (nueva si cambia) |
| `TURNSTILE_SECRET_KEY` | Captcha del registro | Igual que el viejo |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Cobros | Igual (en pruebas: las de **prueba** de MercadoPago) |
| `ANTHROPIC_API_KEY`, `CHAT_VENTAS_TOPE_DIARIO` | Chat de ventas | Igual |
| `TELEGRAM_BOT_TOKEN` | Avisos al dueño | Igual (en pruebas: dejar vacío) |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT` | Registro de errores | Igual; `SENTRY_ENVIRONMENT` = `production` o `staging` |

4. Esperar el deploy y abrir `https://<servidor-nuevo>/health`: tiene que
   decir `"ok": true` y la versión.
5. Si se usa dominio propio: Render → Settings → **Custom Domains** → agregar
   `api.tudominio`, y en el proveedor del dominio crear el registro que Render
   indica.

### Paso 3 — Páginas (app y página de venta)
Si siguen en el mismo Firebase Hosting y cambia solo la dirección del servidor:
1. **App:** en `src/environments/environment.ts`, `backendUrl` = la nueva
   dirección del servidor.
2. **App:** en `firebase.json`, en la CSP, cambiar la dirección vieja del
   servidor por la nueva en `connect-src` y `report-uri`. **Si no se cambia,
   la protección de la CSP bloquea los pedidos y la app no carga datos.**
3. **Página de venta:** en `index.html`, `BACKEND_URL` = la nueva.
4. Publicar las dos (`npm run deploy:live` en la app; la landing como siempre).

Si las páginas cambian de dirección (dominio propio o proyecto nuevo):
5. Firebase (proyecto de **login** `asistenciatw`) → Authentication →
   Settings → **Authorized domains**: agregar la dirección nueva de la app.
   Sin eso, el login dice "dominio no autorizado".
6. Google Cloud (mismo proyecto) → APIs & Services → Credentials → el cliente
   OAuth del botón de Google → **Authorized JavaScript origins**: agregar la
   dirección nueva.
7. Cloudflare → Turnstile → el sitio del captcha → **Hostnames**: agregar la
   dirección nueva.
8. En el servidor: `CORS_ORIGINS` y `FRONTEND_URL` con las direcciones nuevas.
   En el código hay dos lugares con la dirección de la app escrita (los
   cambia Claude): `origenesPermitidos.js` y el link de los avisos en
   `avisos.js`.

### Paso 4 — Los que "mandan cartas" al servidor
1. **Agente del reloj, en cada empresa:** en el archivo de configuración del
   agente, sección `[servidor]`, poner la dirección nueva y reiniciar el
   servicio del agente. Verificar en la app que llegan fichajes nuevos
   (Presentismo de hoy). *Con dominio propio, este paso no se vuelve a hacer
   nunca.*
2. **MercadoPago:** panel de desarrolladores → tu aplicación → Webhooks /
   Notificaciones: URL = `https://<servidor-nuevo>/webhooks/mercadopago`.
3. **GitHub** → repositorio `BackHorasExtras` → Settings → Secrets → Actions:
   actualizar `MYSQL_ADDON_*` con los datos de la base nueva. Los usa la
   acción que corre migraciones.
4. **Backups de todas las noches:** apuntarlos a la base nueva.

### Paso 5 — Verificar (lista para tildar)
- [ ] `/health` del servidor nuevo responde con la versión.
- [ ] Entrar a la app con contraseña y con Google.
- [ ] Presentismo de un mes cerrado da **el mismo total** que en el servidor
      viejo (mismo mes, misma empresa).
- [ ] Llegan fichajes nuevos del agente del reloj (Presentismo de hoy).
- [ ] Seguridad (superadmin): "Conexión con la base: Cifrada". Después:
      "Probar verificación del certificado" → copiar el sello → en Render
      `MYSQL_SSL_CA` + `MYSQL_SSL=require` → volver a mirar.
- [ ] Registro de actividad: aparece lo que hiciste recién.
- [ ] Un pago de prueba de MercadoPago llega (o el webhook figura recibido en
      su panel).
- [ ] La página de venta: el formulario y el chat responden.

### Paso 6 — Apagar lo viejo (1 o 2 semanas después)
1. Servidor viejo en Render: **Suspend**, no borrar.
2. Base vieja: dejarla sin uso un mes más como respaldo y recién después
   borrarla.
3. Quitar de `CORS_ORIGINS` las direcciones viejas.

---

## 4. Plan para volver atrás

Si algo falla y no se resuelve en el momento:
1. Las páginas: volver a publicar la versión anterior (Firebase Hosting →
   Release history → **Rollback**). Eso las vuelve a apuntar al servidor
   viejo.
2. El agente del reloj: volver a poner la dirección vieja.
3. MercadoPago: volver a poner la URL vieja.
4. Lo cargado en la base nueva mientras tanto: pedirle a Claude que lo pase a
   la vieja (fichajes y cambios del período).

Por esto es importante no borrar nada viejo hasta el paso 6.

---

## 5. Para el entorno de pruebas (staging) — diferencias

- Nombres claros: `horasdedica-staging` (servidor), base `staging`.
- **Datos anonimizados** (paso 1.7). Nunca datos reales de clientes.
- MercadoPago con credenciales **de prueba**; Telegram vacío; Sentry con
  `SENTRY_ENVIRONMENT=staging`.
- La app de pruebas, en un **canal de vista previa** de Firebase Hosting o en
  un sitio aparte, con su propio `backendUrl` (configuración `staging`).
- Uso: todo cambio se publica primero ahí, se prueba, y recién después va a
  producción.
