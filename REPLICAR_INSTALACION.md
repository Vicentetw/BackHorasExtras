# Montar el sistema en 3 servidores nuevos

Instructivo para levantar una instalación **completa y separada** de Horas
Dedica (su propia base, su propio backend y su propio frontend) desde cero.

> **Revisado y ensayado el 2026-10-09.** Se hizo la instalación entera en
> Docker siguiendo este documento: estructura → siembra → superadmin →
> backend apuntando a la base nueva → crear empresa, administrador, motivo,
> empleado, horario, feriado, Presentismo y registro de actividad. Salió
> bien de punta a punta (14 de 14 comprobaciones). El ensayo encontró que la
> versión anterior de este documento dejaba la instalación **sin roles**
> (ver paso 1.5): ya está corregido.

Si lo que pasó es que **se perdieron los datos** (o se cayó un servidor) y
hay que volver a funcionar, empezá por **`RECUPERACION_ANTE_DESASTRE.md`**:
ahí está qué parte de este documento usar en cada caso.

---

## Antes que nada: ¿de verdad hace falta?

**Para que un cliente nuevo pruebe el sistema, en general NO.** El sistema
es multiempresa: un cliente nuevo es una empresa más dentro de esta misma
instalación, nace vacía y no ve un solo dato de los demás (lo verifica
`test/full-tenant-isolation.test.js` en cada corrida de tests). Y el camino
ya está armado:

- el cliente se registra en la landing → **Solicitudes de alta** → al
  aprobarla se crea la empresa con **un mes de prueba gratis**, su
  administrador (que recibe el mail para poner la contraseña) y sus valores
  iniciales; o
- el superadmin la crea en **Empresas** y le crea el administrador en
  **Usuarios y Roles**.

Y si hace falta ayudarlo a arrancar, el superadmin puede **trabajar dentro de
su empresa** (botón de arriba, ver `SOPORTE_Y_REGISTRO.md`), con todo
registrado.

Una instalación separada (los 3 servidores de nuevo) tiene sentido en estos
casos:

1. **Un cliente exige por contrato que sus datos no compartan base** con
   otros. Es legítimo y hay que cobrarlo: multiplica el mantenimiento.
2. **Un ambiente de prueba o demostración** donde romper cosas no importe.
3. **Recuperarse de un desastre** en que se perdió un servidor entero o la
   cuenta (Render, Clever Cloud o Firebase).
4. **Mudar todo a otra cuenta** porque cambia quién paga o administra.

**El costo de tener N instalaciones**: cada migración, cada publicación del
frontend y cada backup hay que hacerlos N veces. El primer olvido deja dos
clientes con cálculos distintos sobre las mismas reglas, y acá se calculan
horas que se pagan.

---

## Los 3 servidores y qué hace cada uno

| Servidor | Qué corre | Instalación actual (AVP) |
|---|---|---|
| **Clever Cloud** | La base MySQL 8 | addon MySQL (base `bjtzqo…`) |
| **Render** | El backend Node/Express | Web Service `academypruebadep.onrender.com` |
| **Firebase Hosting** | El frontend Angular (y la landing dentro del sistema) | proyecto `horasdedicacionavp` → `horasdedicacionavp.web.app` |

Además hay servicios que no son "servidores" pero se configuran:
**Firebase Authentication** (el login), **Cloudflare Turnstile** (el
captcha del registro), **MercadoPago** (cobros), **Telegram** (avisos) y el
**agente de fichajes** en la PC de cada cliente con reloj.

### ⚠️ Firebase son DOS proyectos distintos, no uno

Esto ya causó un bug real y es lo más fácil de arruinar:

- **Hosting** (dónde vive la página): proyecto `horasdedicacionavp`.
- **Autenticación** (quién puede entrar): proyecto **`asistenciatw`**.

Se ve en `src/environments/environment.ts` del frontend: `.firebaserc`
apunta a `horasdedicacionavp`, pero el `firebaseConfig` del login dice
`projectId: 'asistenciatw'`.

Consecuencias para una instalación nueva:

- el **`FIREBASE_SERVICE_ACCOUNT`** del backend tiene que ser del proyecto
  de **autenticación**. Si es del otro, todos los tokens se rechazan y nadie
  entra, con un error que no dice nada de proyectos;
- si la autenticación es un proyecto **distinto** de `asistenciatw`, también
  hay que cargar **`FIREBASE_WEB_API_KEY`** en el backend (ver paso 2.2).

---

## El orden importa

**Base → backend → frontend.** Cada uno necesita datos del anterior: el
backend necesita la dirección de la base, y el frontend la del backend.

---

## Paso 1 — La base (Clever Cloud)

**1.1.** Crear un addon MySQL nuevo. Anotar host, puerto, usuario,
contraseña y nombre de la base (guardalos en un gestor de contraseñas: ver
"Dónde guardar las claves" al final).

**1.2.** Exportar la **estructura** (tablas sin datos) de la base que ya
funciona:

```powershell
cd C:\angular\horasdedicacion-back-deploy\BackHorasExtras
.\scripts\exportar-estructura.ps1
```

- Por defecto lee las credenciales de producción de `motor-laboral\.env`
  (solo LEE la estructura; no toca datos). Con `-EnvFile <otro .env>` se
  exporta de otra base.
- Genera un `.sql` con **todas las tablas y cero filas**. Si se coló un
  `INSERT`, borra el archivo y falla: un archivo con datos llevaría
  información de un cliente a la instalación de otro.
- Desde el 2026-10-09 también quita los contadores `AUTO_INCREMENT` (si no,
  la primera empresa de la base nueva nacía con un número enorme y se veía
  cuánto usa AVP el sistema) y escribe el archivo en UTF-8 sin BOM (con BOM,
  `mysql` lo rechaza).
- Anotá la cantidad de tablas que informa: **65** en producción al
  2026-10-09 (con la migración `20261017` aplicada son 66).

**Por qué se saca de la base y no de las migraciones**: son más de 60
archivos escritos a lo largo de meses, varios pensados para modificar tablas
que ya tenían datos. Correrlos en orden sobre una base vacía falla o la deja
a medias. La estructura de la base que funciona ya *es* el resultado de
haberlos corrido todos. (Tampoco sirve `schema/full_schema_snapshot.sql`:
quedó viejo.)

**1.3.** Cargarla en la base nueva:

```powershell
mysql -h HOST_NUEVO -P PUERTO -u USUARIO -p BASE_NUEVA < estructura-....sql
```

(o en phpMyAdmin de Clever Cloud: Importar → ese archivo).

**1.4.** Verificar que tenga la misma cantidad de tablas:

```sql
SELECT COUNT(*) FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'BASE_NUEVA' AND TABLE_TYPE = 'BASE TABLE';
```

**1.5. Sembrar los datos de la plataforma.** ⚠️ **Obligatorio.**

```powershell
mysql -h HOST -P PUERTO -u USUARIO -p BASE < scripts\sembrar-instalacion-nueva.sql
```

Carga **solo** lo que la plataforma necesita para funcionar:

| Qué | Para qué |
|---|---|
| los 4 roles del sistema con sus 57 permisos | sin roles no se le puede dar permisos a nadie: se entra como superadmin pero no se puede crear un usuario que sirva |
| el plan de facturación por defecto | sin él, aprobar una solicitud de alta falla con "No hay un plan por defecto configurado" (los precios se editan en Planes) |

Al final muestra un control: tiene que dar **`roles = 4, permisos = 57,
plan_por_defecto = 1`**. Se puede correr más de una vez sin duplicar nada.

⚠️ **No usar las migraciones `20260902`, `20260903` ni `20260906` para
esto**, como decía la versión anterior de este documento. Empiezan
agregando columnas (`ALTER TABLE … ADD COLUMN`) que la estructura del paso
1.2 ya tiene: `mysql` corta en ese error y **los roles nunca se cargan**.
Comprobado en el ensayo: quedaban 0 roles.

Lo que **no** hace falta sembrar:
- la escala de vacaciones y el régimen de pago: cada empresa los recibe
  **sola al crearse** (`kitInicialEmpresa.js`);
- los valores de configuración: el código tiene sus valores por defecto;
- los motivos de ausencia: los crea el administrador de cada empresa en
  **Administración > Motivos de Ausencia** (paso 5).

### ⚠️ Una migración que NO hay que correr nunca en una instalación nueva

**`20260721_add_app_users_permissions_tenant.sql`** crea una empresa
"Empresa Principal" y además inserta como superadmin la cuenta personal
`perrottavicente@gmail.com` con un UID fijo. En una instalación para un
cliente eso deja una empresa fantasma y una cuenta ajena con acceso total.

---

## Paso 2 — El backend (Render)

**2.1.** Crear un **Web Service** nuevo apuntando al repo
`Vicentetw/BackHorasExtras`, rama `main`.

- **Build command**: `npm ci`
- **Start command**: `node horasdedica.js`
- No hay `render.yaml`: la configuración se carga a mano en el panel.
- El punto de entrada es `horasdedica.js` (no lo que dice `"main"` en
  `package.json`). El puerto lo pone Render (`PORT`).

**2.2.** Cargar las variables de entorno. La lista completa, con qué pasa si
falta cada una, está en **`VARIABLES_DE_ENTORNO.md`**. Las que hay que
cargar sí o sí:

| Variable | Valor |
|---|---|
| `MYSQL_ADDON_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_DB` | los del paso 1.1 |
| `MYSQL_SSL` | `no-verify` en Clever Cloud (cifra la conexión) |
| `FIREBASE_SERVICE_ACCOUNT` | el JSON completo de la cuenta de servicio del proyecto de **autenticación**, en una línea |
| `FIREBASE_WEB_API_KEY` | ⚠️ **solo si la autenticación NO es `asistenciatw`**: la `apiKey` web de ese proyecto. Si falta, el mail de "poner tu contraseña" se pide al proyecto de AVP y no le llega a nadie |
| `NODE_ENV` | `production` (sin esto, el login no falla cerrado cuando debería) |
| `CORS_ORIGINS` | la dirección del frontend nuevo (y de la landing aparte, si hay), separadas por coma, sin barra final |
| `API_KEY` | una cadena larga y aleatoria, **distinta** de la de AVP; va también en el `environment.ts` del frontend (paso 3) |

Para las funciones opcionales (cobros, captcha del registro, chat de
ventas, avisos por Telegram, monitoreo): ver `VARIABLES_DE_ENTORNO.md`.

**2.3.** Verificar:

```
https://<backend-nuevo>/health                     → {"ok":true,...,"version":"<commit>"}
https://<backend-nuevo>/api/billing/plans          → 401 (pide login: está protegido)
```

Si el segundo da **503**, Firebase no inicializó (`FIREBASE_SERVICE_ACCOUNT`).
Si da **200**, algo está muy mal: responde sin pedir login.

**2.4. Las migraciones futuras.** Las corre el dueño a mano, **en cada
base**: phpMyAdmin de Clever Cloud (pegar el `.sql`) o, desde la PC:

```powershell
$env:MYSQL_ADDON_HOST="..."; $env:MYSQL_ADDON_PORT="3306"; $env:MYSQL_ADDON_USER="..."
$env:MYSQL_ADDON_PASSWORD="..."; $env:MYSQL_ADDON_DB="..."
node run-sql.js migrations\2026XXXX_nombre.sql
```

Ya no se usa el workflow de GitHub Actions (`run-migration.yml`): el repo es
público y no se guardan credenciales de producción ahí. Para saber qué
migraciones tiene una base: `DIAGNOSTICO_MIGRACIONES.sql` (solo lectura).

Render publica cada push a `main` en **todos** los backends que apunten al
repo: el código nuevo llega a todas las instalaciones a la vez, pero las
migraciones no. Por eso todo código nuevo funciona también sin su migración.

---

## Paso 3 — El frontend (Firebase Hosting)

**3.1.** Crear el proyecto de Firebase Hosting nuevo (o un sitio nuevo
dentro del existente: Hosting → "Agregar otro sitio", gratis).

**3.2.** Decidir la autenticación: reusar `asistenciatw` o crear un proyecto
nuevo. **Si el cliente exige datos separados, tiene que ser uno nuevo**: si
no, sus usuarios viven en la misma lista de cuentas que los de AVP.

En el proyecto de autenticación que se use:
- Authentication → Sign-in method: habilitar **Email/contraseña** (y Google
  si se usa);
- Authentication → Settings → **Authorized domains**: agregar el dominio
  del frontend nuevo (`<sitio>.web.app`). Si falta, el login con Google y
  los links de "restablecer contraseña" fallan;
- Authentication → Templates: el mail de restablecer contraseña en español
  (es el que recibe cada administrador nuevo para poner su clave).

**3.3. Los archivos que cambian por instalación.** Son cuatro, y los cuatro
tienen la dirección de AVP escrita:

| Archivo | Qué cambiar |
|---|---|
| `src/environments/environment.ts` | `backendUrl` (Render nuevo), `apiKey` (= `API_KEY` del paso 2.2), `firebaseConfig` (el del proyecto de autenticación) |
| `firebase.json` | la política de seguridad (CSP, en `headers`): en `connect-src` la URL del Render nuevo; en `frame-src` el `authDomain` del proyecto de autenticación; y el `report-uri` (Render nuevo). ⚠️ Cuando la CSP pase de "solo reportar" a "bloquear", si esto quedó con la dirección de AVP **el frontend nuevo no va a poder hablarle a su backend** |
| `.firebaserc` | el proyecto de hosting nuevo |
| `public/landing.js` y `public/landing.html` | `BACKEND_URL` y la `data-sitekey` de Turnstile (solo si se usa la landing de esa instalación) |

(`environment.development.ts` es el de `ng serve` en la PC: no se publica.)

**Cómo no mezclar instalaciones**: `main` tiene los valores de AVP. Para
otra instalación, usar una **rama propia** (`instalacion/<nombre>`) con solo
esos cuatro archivos cambiados, y para publicar una versión nueva: traer
`main` a esa rama (`git merge main`) y publicar desde ahí. Publicar desde
`main` con los archivos de otra instalación publica el frontend de un
cliente apuntando al backend de otro.

**3.4.** Publicar:

```powershell
cd C:\angular\horasDedicacionOnlineAngular\horas-dedica-angular
npm run deploy:preview   # prueba en una dirección aparte (no toca el sitio)
npm run deploy:live      # publica
```

No es automático: no alcanza con hacer push.

**3.5.** Volver al backend (Render) y verificar que `CORS_ORIGINS` tenga la
dirección exacta del frontend nuevo. Si falta, el navegador no dice "CORS":
dice "no se pudo conectar con el servidor".

---

## Paso 4 — Crear el superadmin (y nada más)

La base nueva no tiene ni una empresa, ni un empleado ni un usuario. El único
dato que se crea a mano es el superadmin: la pantalla de Usuarios exige
estar logueado con permisos, y todavía no existe nadie.

Una cuenta vive en **dos lugares**: **Firebase Auth** (email y contraseña:
*quién sos*) y la tabla **`app_users`** (empresa, rol, si es superadmin:
*qué podés hacer*). Se unen por el **`firebase_uid`**. Tienen que existir
las dos, con el mismo UID.

**4.1.** En la consola de Firebase, proyecto de **autenticación**:
Authentication → Users → **Add user** (email y contraseña) y **copiar el
`User UID`** (unos 28 caracteres).

**4.2.** En la base nueva:

```sql
INSERT INTO app_users (firebase_uid, email, tenant_id, role_id, is_superadmin, is_active)
VALUES ('EL_UID_QUE_COPIASTE', 'el@email.com', NULL, NULL, 1, 1);
```

| Columna | Valor | Por qué |
|---|---|---|
| `firebase_uid` | el UID del 4.1 | es la única unión con Firebase; si no coincide exacto, el login falla sin decir por qué |
| `tenant_id` | `NULL` | el superadmin no pertenece a ninguna empresa |
| `role_id` | `NULL` | los roles son para usuarios de una empresa |
| `is_superadmin` | `1` | es una columna, no un rol |
| `is_active` | `1` | en `0` la cuenta existe pero no entra |

**4.3.** Verificar: `SELECT id, email, tenant_id, is_superadmin FROM app_users;`
tiene que dar **una sola fila**, y `SELECT COUNT(*) FROM tenants;` **0**.

**4.4.** Entrar al frontend nuevo con ese email. **Empresas** tiene que
estar vacía. Si aparece una empresa que no creaste, el frontend apunta a
otro backend (`backendUrl`) o el backend a otra base (variables de Render).

---

## Paso 5 — La primera empresa (ya sin SQL)

Todo sale de las pantallas:

1. **Empresas → Nueva empresa** (recibe sola la escala de vacaciones de la
   ley y el régimen de pago mensual). O, si el cliente se registra solo en
   la landing, **Solicitudes de alta → Aprobar** (crea empresa, mes de
   prueba y administrador, y le manda el mail de la contraseña).
2. **Usuarios y Roles**: el administrador de la empresa, rol
   "Administrador de Empresa". En Empresas, elegirlo como **titular**.
3. **Facturación**: la suscripción (o el mes de prueba).
4. El administrador de la empresa (o el superadmin trabajando en ella)
   carga: **Motivos de Ausencia** (vacaciones, enfermedad, etc.),
   empleados, plantillas de horario, feriados.
5. **Si tiene reloj**: crear la clave del agente (**Facturación** → fila
   de la empresa → **Claves de agente**; se ve una sola vez) e instalar el
   agente en su PC. En el `config.ini` del agente:
   `[servidor] url = <backend nuevo>` y `clave = <la clave creada>`.

---

## Verificación final

1. Entrar y loguearse. **Empresas** muestra solo lo que creaste.
2. Crear un empleado, una plantilla con el asistente, un feriado; abrir
   Presentismo de un día; ver que en **Registro de actividad** quedaron los
   cambios.
3. En los logs de Render del backend **nuevo** se ven esos pedidos, y en
   los del de AVP **no**.
4. Si se usa la landing de esa instalación: registrarse con un mail propio
   y ver que llegue la solicitud.

---

## Lo que hay que repetir en cada instalación, para siempre

- **Cada migración nueva**, en cada base.
- **Cada publicación del frontend**, desde la rama de esa instalación.
- **Cada backup**: un workflow de backup por base (ver
  `RECUPERACION_ANTE_DESASTRE.md`) y `backup-produccion.ps1` con su propio
  `-EnvFile` y `-Destino`.
- **Cada cambio de claves**.

## Dónde guardar las claves

Las variables de Render (base, Firebase, MercadoPago, Telegram…) **solo
existen en Render**. Si se pierde esa cuenta, se pierden con ella y no hay
forma de verlas de nuevo. Guardá una copia de cada valor en un gestor de
contraseñas (Bitwarden, 1Password…), nunca en el repositorio ni en un
archivo suelto de la PC.

---

## Limitación conocida: los sitios de AVP están escritos en el código

`origenesPermitidos.js` deja pasar siempre a `horasdedicacionavp.web.app`
(y sus vistas previas), sin importar `CORS_ORIGINS`. En otra instalación
eso significa que su backend también acepta pedidos desde el sitio de AVP.
No da acceso a nada (sin una cuenta de esa instalación, todo pide login),
pero si un cliente exige separación total, conviene pasar esa regla a una
variable antes de entregarle la instalación.
