# Mapa de Firebase y de las cuentas: qué va dónde

Para cuando pase el tiempo y no te acuerdes, o para mudar algo a otra cuenta
u otro servidor. Complementa `REPLICAR_INSTALACION.md` (instalación completa)
y `VARIABLES_DE_ENTORNO.md` (variables del backend).

> **No se escriben acá los emails de las cuentas ni ninguna clave.** Este
> repositorio puede terminar siendo público. Anotá qué cuenta de Google es
> dueña de cada proyecto en tu **gestor de contraseñas**, en una nota con
> el título "Horas Dedica: cuentas".

---

## La idea en una frase

Hay **dos proyectos de Firebase**, y cada uno pertenece a **una cuenta de
Google distinta**:

| Proyecto | Para qué sirve | Si se pierde… |
|---|---|---|
| **`horasdedicacionavp`** | **Hosting**: solo guarda y sirve la página (el frontend Angular) | Se publica la página en otro proyecto. Molesto, pero sin pérdida de datos |
| **`asistenciatw`** | **Authentication**: las cuentas de login (email, contraseña, Google) | **Grave**: cada persona tiene que volver a crear su login (ver `RECUPERACION_ANTE_DESASTRE.md`) |

¿Por qué funciona igual estando separados? Porque el **Hosting** no sabe nada
del login: solo entrega archivos. Es la página, ya en el navegador, la que
habla con el proyecto de **autenticación**, porque así lo dice su
`firebaseConfig`. Y el backend comprueba los tokens con la cuenta de servicio
de ese mismo proyecto. Son dos mundos que nunca se hablan entre sí.

**Cómo saber con qué cuenta está la consola de comandos** (la que usa
`npm run deploy:live`):

```
firebase login:list        # muestra la cuenta de Google logueada
firebase projects:list     # muestra los proyectos que esa cuenta puede tocar
```

La cuenta que publica ve `horasdedicacionavp`, pero **no** ve `asistenciatw`
(comprobado el 2026-10-14). O sea que `asistenciatw` es de la **otra** cuenta.

---

## 1. Proyecto `asistenciatw` (autenticación)

Se entra en https://console.firebase.google.com **con la cuenta dueña de
`asistenciatw`**.

| Qué | Dónde está en la consola | Estado recomendado |
|---|---|---|
| Métodos de login | Authentication → **Sign-in method** | Email/contraseña: **sí**. Google: **sí** (para el registro con Google) |
| Quién puede crear cuentas | Authentication → Settings → **User actions** → "Enable create (sign-up)" | **Destildado**: las cuentas las crea solo nuestro servidor |
| Que cada uno borre su cuenta | Authentication → Settings → User actions → "Enable delete" | **Destildado**: el borrado pasa por el sistema, que deja constancia (Ley 25.326) |
| Protección de enumeración de correo | Authentication → Settings → User actions | **Tildado**: no deja averiguar qué emails tienen cuenta |
| Dominios autorizados | Authentication → Settings → **Authorized domains** | Tiene que estar `horasdedicacionavp.web.app` (y `localhost` para probar). Si la página se muda a otro dominio, **agregarlo acá o el login falla** |
| Textos de los mails (verificar email, contraseña) | Authentication → **Templates** | Idioma: español. Nombre del remitente: "Horas Dedica" |
| Cuenta de servicio del backend | ⚙️ Project settings → **Service accounts** → "Generate new private key" | Ese JSON va en `FIREBASE_SERVICE_ACCOUNT` (Render). **Es secreto** |
| `firebaseConfig` web (apiKey, etc.) | ⚙️ Project settings → General → "Your apps" → app web | Va en los `environment*.ts` del frontend. **No es secreto**: viaja al navegador a propósito |
| Nombre que ven los usuarios (mails y ventana de Google) | ⚙️ Project settings → General → **Public-facing name** | "Horas Dedica". Hasta el 2026-10-14 decía `project-948260225701` (948260225701 es el número del proyecto) |
| ID de cliente web de Google | Authentication → Sign-in method → Google → "Web SDK configuration" | `948260225701-ekc31….apps.googleusercontent.com`. **No es secreto**: lo usa el registro con Google |
| Pantalla "Continuar con Google" | Google Cloud Console (mismo proyecto `asistenciatw`) → APIs y servicios → **Pantalla de consentimiento de OAuth** | Nombre de la app "Horas Dedica", con logo y email de soporte. Si no se configura, Google muestra "asistenciatw.firebaseapp.com" |

### Archivos y variables que dependen de `asistenciatw`

| Dónde | Qué tiene | Si se cambia el proyecto de autenticación |
|---|---|---|
| Frontend `src/environments/environment.ts` (producción) | `firebaseConfig` con `projectId: 'asistenciatw'` y `authDomain: 'asistenciatw.firebaseapp.com'` | Pegar el `firebaseConfig` del proyecto nuevo |
| Frontend `src/environments/environment.development.ts` (local) | lo mismo | Ídem. Hoy local y producción **comparten** el mismo login |
| Frontend `firebase.json` → cabecera CSP, `frame-src` | `https://asistenciatw.firebaseapp.com` (la ventanita de login de Google) | Cambiar por el `authDomain` nuevo, o el login con Google queda bloqueado cuando se active el modo bloqueo de la CSP |
| Backend, Render → `FIREBASE_SERVICE_ACCOUNT` | JSON de la cuenta de servicio | El del proyecto nuevo. Si es de otro proyecto, **nadie entra**, y el error no dice nada de proyectos |
| Backend, Render → `FIREBASE_WEB_API_KEY` | apiKey web, para mandar el mail de "poner tu contraseña" | **Obligatoria si el proyecto no es `asistenciatw`**. Sin ella, el mail no llega a nadie |
| Backend local `.env` → `FIREBASE_SERVICE_ACCOUNT_PATH` | ruta al JSON de la cuenta de servicio en esta PC | Apuntar al JSON nuevo. El archivo **nunca** se sube a GitHub |
| GitHub del backend → Secrets → `FIREBASE_SERVICE_ACCOUNT` | el mismo JSON, para los tests automáticos (CI) | Actualizarlo |

---

## 2. Proyecto `horasdedicacionavp` (hosting)

Se entra con la **cuenta que publica**, la que muestra `firebase login:list`.

| Dónde | Qué tiene |
|---|---|
| Frontend `.firebaserc` | `"default": "horasdedicacionavp"`: a qué proyecto publica `npm run deploy:live` |
| Frontend `firebase.json` | Qué carpeta se publica, las cabeceras de seguridad y la CSP |
| Backend `origenesPermitidos.js` (`ORIGEN_PROPIO`) | Deja pasar siempre a `horasdedicacionavp.web.app` y a sus vistas previas (CORS) |
| Backend `avisos.js` y `routes/billing.js` | Links a `horasdedicacionavp.web.app` en los avisos de Telegram y en la vuelta de MercadoPago. `billing.js` lee primero `FRONTEND_URL` |
| Backend, Render → `CORS_ORIGINS` | Otros sitios permitidos (la landing de Cloudflare Pages) |

**Si la página se muda** (a otro proyecto o a un dominio propio):

1. cambiar `.firebaserc`;
2. agregar el dominio nuevo en `asistenciatw` → **Authorized domains**;
3. agregarlo en Cloudflare Turnstile (ver abajo);
4. agregarlo en `CORS_ORIGINS` de Render, o en `ORIGEN_PROPIO`;
5. poner `FRONTEND_URL` en Render.

---

## 3. Las otras cuentas (no son Firebase, pero también se mudan)

| Servicio | Qué guarda | Qué se configura en el código |
|---|---|---|
| **Cloudflare Turnstile** (el captcha) | La clave del sitio (pública) y la secreta | Clave pública: frontend `environment.ts` (`turnstileSiteKey`) y landing `index.html` (`data-sitekey`). Clave secreta: Render `TURNSTILE_SECRET_KEY`. **Cada dominio donde aparece el captcha** se agrega en el panel de Turnstile → el sitio → Hostnames |
| **Cloudflare Pages** | La landing (`landing-horas-dedica.pages.dev`) | Repo `horas-dedica-landing` (ver su README) |
| **Render** | El backend | Variables: `VARIABLES_DE_ENTORNO.md` |
| **Clever Cloud** | La base MySQL | Variables `MYSQL_ADDON_*` en Render |
| **GitHub** | El código de los 3 repos, y el secreto para los tests (CI) | — |
| **Telegram, MercadoPago, Anthropic** | Avisos, cobros, IA | Variables en Render |

---

## ¿Conviene juntar todo en una sola cuenta?

**Recomendación: sí, más adelante, y con calma.** Lo mejor es pasar los dos
proyectos a una **cuenta de Google dedicada al negocio**, separada de tu
cuenta personal y con verificación en dos pasos, y sumar tu cuenta personal
como **segundo propietario**. Así:

- si perdés el acceso a una cuenta, no perdés el sistema;
- no tenés que recordar qué cuenta tiene qué.

**No hace falta mover ni migrar nada.** En cada proyecto: ⚙️ Project settings
→ **Users and permissions** → agregar la otra cuenta como **Owner**. Los
proyectos quedan iguales, con los mismos nombres y las mismas cuentas de
login, y no se toca código. Unir los dos proyectos en uno, en cambio, **no
conviene**: obligaría a mudar las cuentas de login de todos los usuarios, y
eso es justo lo más riesgoso.
