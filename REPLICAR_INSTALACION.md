# Replicar el sistema en los 3 servidores

Instructivo para levantar una instalación **completa y separada** de Horas
Dedica: su propio frontend, su propio backend y su propia base, sin ninguna
relación con la instalación de AVP.

---

## Antes que nada: ¿de verdad hace falta?

**Para vender a una empresa más, no.** El sistema es multiempresa: un cliente
nuevo es una fila en `tenants` dentro de esta misma instalación, y nace vacío
sin ver un solo dato de los demás. Eso es lo que verifica
`test/full-tenant-isolation.test.js` (dos empresas con legajos, USERID y
credenciales idénticos, ningún dato que se cruce). Los pasos de ese camino
están en `ESTADO_PROYECTO.md`, sección "Cómo dar de alta una empresa nueva".

Replicar la instalación entera tiene sentido en tres casos:

1. **Un cliente exige por contrato que sus datos no compartan base** con
   otros. Es una decisión comercial legítima, y hay que cobrarla: multiplica
   el mantenimiento.
2. **Un ambiente de prueba o demo** donde romper cosas no importe — por
   ejemplo para mostrar el motor de reglas nuevo sin tocar producción.
3. **Mudar todo a otra cuenta** (otro Render, otro Firebase, otro Clever
   Cloud) porque cambia quién paga o quién administra.

**El costo real de tener N instalaciones**: cada corrección, cada migración y
cada despliegue hay que hacerlos N veces. El primer olvido deja dos clientes
con cálculos distintos sobre las mismas reglas — y acá se calculan horas que
se pagan.

---

## Los 3 servidores y qué hace cada uno

| Servidor | Qué corre | Instalación actual |
|---|---|---|
| **Clever Cloud** | La base MySQL 8.4 | addon MySQL |
| **Render** | El backend Node/Express | Web Service `academypruebadep.onrender.com` |
| **Firebase Hosting** | El frontend Angular | proyecto `horasdedicacionavp` → `horasdedicacionavp.web.app` |

### ⚠️ Firebase son DOS proyectos distintos, no uno

Esto ya causó un bug real y es lo más fácil de arruinar:

- **Hosting** (dónde vive la página): proyecto `horasdedicacionavp`.
- **Autenticación** (quién puede entrar): proyecto **`asistenciatw`**.

Se ve en `src/environments/environment.ts` del frontend: `.firebaserc` apunta
a `horasdedicacionavp`, pero el `firebaseConfig` que usa el login dice
`projectId: 'asistenciatw'`.

Consecuencia para una instalación nueva: **el `FIREBASE_SERVICE_ACCOUNT` del
backend tiene que ser del proyecto de AUTENTICACIÓN**, no del de hosting. El
backend usa esa credencial para verificar los tokens que emite el login; si
es del proyecto equivocado, todos los tokens se rechazan y nadie puede
entrar, con un error que no dice nada de proyectos.

---

## El orden importa

Base → backend → frontend. Cada uno necesita datos del anterior: el backend
necesita la dirección de la base, y el frontend necesita la URL del backend.
Hacerlo al revés obliga a volver atrás.

---

## Paso 1 — La base (Clever Cloud)

**1.1.** Crear un addon MySQL nuevo. Anotar host, puerto, usuario, contraseña
y nombre de la base.

**1.2.** Exportar la estructura de la base que ya funciona:

```powershell
cd C:\angular\horasdedicacion-back-deploy\BackHorasExtras
.\scripts\exportar-estructura.ps1
```

Genera un `.sql` con las 51 tablas y **cero filas**. El script verifica que
no se haya colado ni un `INSERT`: si aparece uno, borra el archivo y falla —
un archivo con datos llevaría información de un cliente a la instalación de
otro.

**Por qué se saca de la base y no de un archivo del repo**: `schema/full_schema_snapshot.sql`
quedó viejo. Verificado el 2026-09-22: declara 42 tablas y la base real tiene
51. Un archivo de esquema escrito a mano se desactualiza sin que nadie se
entere; la base que está funcionando, no.

**Por qué no se corren las 48 migraciones sobre una base vacía**: son
archivos escritos a lo largo de meses, varios pensados para modificar tablas
que ya existían con datos adentro. Cualquiera que asuma algo del estado
anterior falla o deja la base a medias, justo cuando uno está poniendo en
marcha un cliente. La estructura actual ya *es* el resultado de haberlas
corrido todas.

**1.3.** Cargarla en la base nueva:

```powershell
mysql -h HOST_NUEVO -P PUERTO -u USUARIO -p BASE_NUEVA < estructura-....sql
```

**1.4.** Verificar que tenga las mismas 51 tablas:

```sql
SELECT COUNT(*) FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'BASE_NUEVA' AND TABLE_TYPE = 'BASE TABLE';
```

**1.5. Sembrar los catálogos.** ⚠️ **Este paso es obligatorio y es el que más
fácil se olvida.**

El dump del paso 1.2 trae la estructura pero **ninguna fila**, así que las
tablas de catálogo quedan vacías. Sin `roles` y `role_permissions` no se le
puede dar ningún permiso a nadie: el sistema arranca, se puede entrar como
superadmin, y no se puede crear un solo usuario que sirva.

Correr estas tres migraciones, en este orden. Las tres son idempotentes (se
pueden re-correr sin romper nada):

```powershell
mysql -h HOST -P PUERTO -u USUARIO -p BASE < migrations\20260902_add_roles.sql
mysql -h HOST -P PUERTO -u USUARIO -p BASE < migrations\20260903_overtime_auth_and_vacation_scale.sql
mysql -h HOST -P PUERTO -u USUARIO -p BASE < migrations\20260906_billing_plans.sql
```

| Migración | Qué siembra |
|---|---|
| `20260902_add_roles.sql` | los 4 roles del sistema y sus 63 permisos — **imprescindible** |
| `20260903_overtime_auth_and_vacation_scale.sql` | la escala de vacaciones por antigüedad (14/21/28/35 días, LCT art. 150) como default global editable, y 2 valores por defecto de configuración |
| `20260906_billing_plans.sql` | el plan de facturación base — solo si se va a cobrar |

Verificar que quedaron:

```sql
SELECT (SELECT COUNT(*) FROM roles) AS roles,              -- esperado: 4
       (SELECT COUNT(*) FROM role_permissions) AS permisos, -- esperado: 63
       (SELECT COUNT(*) FROM vacation_scale) AS vacaciones; -- esperado: 4
```

### ⚠️ Una migración que NO hay que correr

**`20260721_add_app_users_permissions_tenant.sql`** no es una migración de
estructura nada más: crea una empresa llamada "Empresa Principal" y además
inserta como superadmin la cuenta personal `perrottavicente@gmail.com` con un
Firebase UID fijo escrito en el archivo (líneas 30 y 42).

En una instalación para un cliente eso deja una empresa fantasma y una cuenta
ajena con acceso total. Las tablas que esa migración crea ya vienen en el
dump del paso 1.2, así que no hace falta para nada.

**Los motivos de ausencia (`event_types`) son por empresa, no catálogo**:
cada empresa tiene los suyos (VACACIONES, ENFERMEDAD, ART, ARTICULO_55,
PERMISO, ESTUDIO, OTRO). Se cargan después de crear la empresa, en el paso 5.

---

## Paso 2 — El backend (Render)

**2.1.** Crear un Web Service nuevo apuntando al repo `Vicentetw/BackHorasExtras`,
rama `main`.

No hay `render.yaml` en el repo: la configuración vive en el panel de Render
y hay que cargarla a mano.

- **Build command**: `npm ci`
- **Start command**: `node horasdedica.js`

El punto de entrada **no** es lo que dice `"main"` en `package.json` (ahí dice
`db.js`, que está mal y no se usa). El servidor que escucha es
`horasdedica.js`, y toma el puerto de `process.env.PORT`, que Render provee
solo.

**2.2.** Cargar las variables de entorno.

**Obligatorias** — sin alguna de estas el sistema no funciona o funciona mal:

| Variable | Qué es |
|---|---|
| `MYSQL_ADDON_HOST` | del paso 1.1 |
| `MYSQL_ADDON_PORT` | del paso 1.1 |
| `MYSQL_ADDON_USER` | del paso 1.1 |
| `MYSQL_ADDON_PASSWORD` | del paso 1.1 |
| `MYSQL_ADDON_DB` | del paso 1.1 |
| `FIREBASE_SERVICE_ACCOUNT` | el JSON completo de la cuenta de servicio, **del proyecto de autenticación** (ver la advertencia de arriba) |
| `API_KEY` | ⚠️ ver abajo |
| `CORS_ORIGINS` | la URL del frontend nuevo, separadas por coma si hay varias |

⚠️ **`API_KEY` falla en silencio si falta.** En `security.js:33` está
`if (!API_KEY) return next();` — o sea que si la variable no está cargada, la
capa de clave de aplicación **queda desactivada** y el servidor arranca
normal, sin ningún error ni aviso. Es el tipo de olvido que no se nota hasta
que alguien lo busca. Tiene que ser una cadena larga y aleatoria, distinta de
la de la instalación de AVP, y el mismo valor va después en el
`environment.ts` del frontend.

⚠️ **`CORS_ORIGINS` sin cargar también rompe.** El valor por defecto
(`security.js:21`) es solo `localhost`, así que el frontend publicado no va a
poder hablarle al backend.

**Opcionales** — el sistema arranca sin ellas, pero esa función queda apagada:

| Variable | Si falta |
|---|---|
| `FRONTEND_URL` | los links de vuelta de MercadoPago apuntan a `horasdedicacionavp.web.app`, o sea a la instalación equivocada. Cargarla siempre que haya cobro |
| `MERCADOPAGO_ACCESS_TOKEN` | no se puede cobrar |
| `MERCADOPAGO_WEBHOOK_SECRET` | no se validan los avisos de pago |
| `SENTRY_DSN` | sin monitoreo de errores (`monitoreo.js` queda inerte, no rompe) |
| `SENTRY_ENVIRONMENT` | por defecto `production` |
| `TURNSTILE_SECRET_KEY` | sin captcha en el registro público |
| `ANTHROPIC_API_KEY` | sin el chat de ventas de la landing |

**2.3.** Verificar que levantó: abrir la URL del servicio y ver los logs de
arranque (`✅ Backend escuchando en puerto`).

**2.4.** Configurar los secrets del repo para las migraciones futuras.
GitHub → Settings → Secrets and variables → Actions:
`MYSQL_ADDON_HOST`, `MYSQL_ADDON_PORT`, `MYSQL_ADDON_USER`,
`MYSQL_ADDON_PASSWORD`, `MYSQL_ADDON_DB`.

Son los que usa el workflow `run-migration.yml`, que corre una migración a
mano desde la pestaña Actions sin necesidad de una terminal.

⚠️ **Pero son un solo juego de secrets por repositorio.** Si las dos
instalaciones salen del mismo repo, ese workflow apunta a **una sola** de las
dos bases. Con más de una instalación hay que correr las migraciones a mano
con `run-sql.js` contra cada base, o el workflow va a migrar siempre la misma
y la otra se va a quedar atrás sin que nadie lo note.

---

## Paso 3 — El frontend (Firebase Hosting)

**3.1.** Crear el proyecto de Firebase Hosting nuevo (o un sitio nuevo dentro
del existente).

**3.2.** Decidir la autenticación: reusar el proyecto de Auth actual
(`asistenciatw`) o crear uno nuevo. **Si es un cliente que exige datos
separados, tiene que ser uno nuevo** — si no, sus usuarios viven en la misma
base de identidades que los de AVP, que es justo lo que se quería evitar.

**3.3.** En `src/environments/environment.ts`, cambiar:

- `backendUrl` → la URL del Render nuevo
- `apiKey` → el mismo valor que cargaste en `API_KEY` en el paso 2.2
- `firebaseConfig` → el del proyecto de autenticación elegido en 3.2

Estos valores **no son secretos**: viajan al navegador por diseño. La
seguridad real la dan el login de Firebase y los permisos por usuario, que se
resuelven en el backend.

**3.4.** Apuntar `.firebaserc` al proyecto nuevo y publicar:

```powershell
cd C:\angular\horasDedicacionOnlineAngular\horas-dedica-angular
npm run deploy:live
```

El deploy del frontend **no es automático** — no alcanza con pushear.

Para probar sin tocar el sitio real: `npm run deploy:preview`, que publica en
una URL aparte.

---

## Paso 4 — Crear el superadmin (y nada más)

**No hay nada que vaciar.** La base nueva arranca sin una sola empresa, sin un
solo empleado y sin un solo usuario: el dump del paso 1.2 no trae filas y los
catálogos del 1.5 no crean ninguna cuenta. El único dato que va a existir
cuando termines este paso es el superadmin.

### Cómo funciona una cuenta acá (para entender por qué son dos pasos)

Una cuenta vive en **dos lugares a la vez**, y hacen cosas distintas:

- **Firebase Auth** guarda el email y la contraseña. Es lo único que sabe
  *quién sos*. Cuando entrás, Firebase emite un token.
- **La tabla `app_users`** guarda *qué podés hacer*: a qué empresa
  pertenecés, qué rol tenés, si sos superadmin, si estás activo.

Las dos se unen por el **`firebase_uid`**: la cadena que Firebase le asigna a
la cuenta. El backend recibe el token, saca el UID y busca esa fila.

Consecuencia práctica: si creás la cuenta solo en Firebase, podés poner la
contraseña pero el backend no te reconoce. Si creás solo la fila en
`app_users` con un UID inventado, no vas a poder loguearte nunca. **Tienen
que existir las dos, con el mismo UID.**

Para el *primer* superadmin no hay forma de usar la pantalla de Usuarios: esa
pantalla exige estar logueado con permisos, y todavía no existe nadie. Por
eso este primer usuario, y solo este, se crea a mano.

### 4.1. Crear la cuenta en Firebase

En la consola de Firebase, en el proyecto de **autenticación** que elegiste en
el paso 3.2 (ojo: el de autenticación, no el de hosting):

1. Authentication → Users → **Add user**
2. Email y contraseña
3. **Copiar el `User UID`** que aparece en la lista. Es una cadena de ~28
   caracteres como `8F5FJYCLwHSLSgEzBDhDo1UcOP33`.

### 4.2. Crear la fila en `app_users`

```sql
INSERT INTO app_users (firebase_uid, email, tenant_id, role_id, is_superadmin, is_active)
VALUES ('EL_UID_QUE_COPIASTE', 'el@email.com', NULL, NULL, 1, 1);
```

Qué significa cada valor, porque acá es fácil equivocarse:

| Columna | Valor | Por qué |
|---|---|---|
| `firebase_uid` | el UID del paso 4.1 | es la única unión con Firebase; si no coincide exactamente, el login falla sin decir por qué |
| `tenant_id` | **`NULL`** | el superadmin **no pertenece a ninguna empresa**: por eso las ve todas. Si le ponés un número, queda encerrado en esa empresa |
| `role_id` | **`NULL`** | los roles limitan permisos dentro de una empresa. El superadmin no pasa por ahí |
| `is_superadmin` | `1` | es una **columna**, no un rol. Es lo que habilita crear empresas y ver todo |
| `is_active` | `1` | en `0` la cuenta existe pero no puede entrar |

### 4.3. Verificar

```sql
SELECT id, email, tenant_id, is_superadmin, is_active FROM app_users;
```

Tiene que devolver **exactamente una fila**, con `tenant_id` en `NULL` y
`is_superadmin` en `1`. Si hay más de una, algo se sembró de más — revisá que
no hayas corrido `20260721_add_app_users_permissions_tenant.sql`.

Y que no haya empresas todavía:

```sql
SELECT COUNT(*) FROM tenants;   -- tiene que dar 0
```

### 4.4. Entrar

Entrar al frontend nuevo con ese email y contraseña. `/empresas` tiene que
estar **vacío**.

Si aparece una empresa que no creaste, el frontend está apuntando a la base
equivocada — revisá `backendUrl` en `environment.ts` y las variables de
MySQL en Render.

### 4.5. De acá en adelante, ya no se toca SQL

Todo lo demás sale de las pantallas: crear la empresa, su administrador, su
suscripción, su clave de agente. El paso a paso está en `ESTADO_PROYECTO.md`,
sección "Cómo dar de alta una empresa nueva".

---

## Paso 5 — Los motivos de ausencia de la primera empresa

`event_types` (VACACIONES, ENFERMEDAD, ART, ARTICULO_55, PERMISO, ESTUDIO,
OTRO) es **por empresa**, no catálogo global. Una empresa recién creada no
tiene ninguno, y sin ellos no se puede cargar una licencia.

Con el `tenant_id` de la empresa ya creada:

```sql
INSERT INTO event_types (tenant_id, code, descripcion, descuenta_vacaciones, requiere_aprobacion, active) VALUES
  (?, 'VACACIONES',  'Vacaciones',            1, 1, 1),
  (?, 'ENFERMEDAD',  'Enfermedad',            0, 0, 1),
  (?, 'ART',         'ART',                   0, 1, 1),
  (?, 'ARTICULO_55', 'Articulo 55',           0, 1, 1),
  (?, 'PERMISO',     'Permiso',               0, 1, 1),
  (?, 'ESTUDIO',     'Licencia por estudio',  0, 1, 1),
  (?, 'OTRO',        'Otro',                  0, 0, 1);
```

Es la lista que usa AVP hoy; cada empresa puede tener la suya.

---

## Verificación final

1. Entrar al frontend nuevo y loguearse.
2. Confirmar que `/empresas` está **vacío** — si aparece una empresa que no
   creaste, algo quedó apuntando a la base equivocada.
3. Crear una empresa de prueba, cargar un empleado, borrarlo.
4. Confirmar que el Render nuevo aparece en los logs cuando usás el frontend
   nuevo, y que el de AVP **no** registra nada.

---

## Lo que hay que repetir en cada instalación, para siempre

Esto es el costo real de la decisión, y conviene tenerlo escrito:

- **Cada migración nueva**, en cada base, en el mismo orden.
- **Cada deploy de frontend** (`npm run deploy:live` por separado, con el
  `environment.ts` correcto en cada uno — equivocarse acá publica el
  frontend de un cliente apuntando al backend de otro).
- **Cada backup** (`backup-produccion.ps1` con un `-EnvFile` y un `-Destino`
  distintos por instalación).
- **Cada rotación de credenciales.**

Render redespliega solo al pushear a `main`, así que los backends sí se
actualizan juntos. Las bases y los frontends, no.
