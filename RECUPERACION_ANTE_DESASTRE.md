# Qué hacer si algo se cae o se pierde

Este documento es para el peor día. Va directo al grano y después explica.

**Ensayado el 2026-10-09** con el backup real de ese día:
- restaurar la base entera tardó **27 segundos** (65 tablas, 508 empleados,
  165.019 fichajes);
- con un backend apuntando a la base restaurada, Presentismo de AVP del
  08/10 (479 personas), Empleados y el resumen mensual respondieron bien.

---

## Primero: ¿qué se perdió?

| Qué pasó | Qué hacer | Tiempo aproximado |
|---|---|---|
| **Se borraron o rompieron datos**, pero los servidores andan | A: restaurar el backup en una base nueva y apuntar Render a ella | 15 minutos |
| **Se cayó o se perdió la base / la cuenta de Clever Cloud** | B: base nueva (otra cuenta o proveedor) + restaurar el backup + apuntar Render | 30–60 minutos |
| **Se perdió el backend (Render)** | C: Web Service nuevo con las mismas variables | 30 minutos, si tenés las variables guardadas |
| **Se perdió el frontend (Firebase Hosting)** | D: publicar desde el repo en un sitio nuevo | 20 minutos |
| **Se perdió todo** | B + C + D, en ese orden | 2 horas |

En todos los casos, la base se **restaura desde el backup** (con todos los
datos). **No** se usa el camino de "instalación nueva" (estructura vacía +
siembra) de `REPLICAR_INSTALACION.md`: ese es para empezar sin datos.

---

## A. Restaurar los datos (los servidores andan)

```powershell
cd C:\angular\horasdedicacion-back-deploy\BackHorasExtras

# 1. El backup más reciente (ver "Dónde están los backups")

# 2. Restaurarlo en una base NUEVA (no encima de la rota)
.\scripts\restaurar-backup.ps1 `
  -Archivo "C:\ruta\backup-xxx.zip" `
  -DbHost <host> -Puerto 3306 -Usuario <usuario> `
  -Base <base_nueva> -ConfirmoBase <base_nueva>
```

3. **Render → Environment**: cambiar `MYSQL_ADDON_DB` (y host, usuario,
   contraseña si cambiaron). Guardar reinicia el servicio.
4. **Migraciones**: el backup puede ser más viejo que el código. Correr
   `DIAGNOSTICO_MIGRACIONES.sql` en la base restaurada y aplicar las que
   digan `0` (en orden). Todas se pueden correr dos veces.
5. **Verificar**: `https://academypruebadep.onrender.com/health`, entrar y
   abrir Presentismo.

**Restaurar en una base nueva y no encima de la rota** es a propósito:
mientras la rota siga ahí, tenés a dónde volver si algo sale mal, y queda la
evidencia de qué pasó.

**Lo que se pierde**: lo cargado entre el último backup y el problema.

- **Fichajes de los relojes: se recuperan, pero NO solos.** El agente lleva
  en su PC la lista de lo que ya subió y no lo vuelve a mandar (verificado
  en `descarga-fichaje-py/db_local.py`: marca cada fichaje como
  sincronizado). Para recuperar el lapso: en la PC de cada cliente con reloj
  está el `CHECKINOUT.csv` que el agente genera en cada pasada con todo lo
  que tiene el reloj → subirlo en **Importar Fichajes** (logueado como esa
  empresa, o como superadmin trabajando en ella). Los repetidos se descartan
  solos (la base no admite dos veces el mismo fichaje: misma empresa,
  persona y hora), así que subir el archivo entero es seguro. Acepta hasta
  500.000 fichajes por archivo.
- **Lo cargado a mano** en ese lapso (justificaciones, licencias, horarios)
  hay que volver a cargarlo. El **Registro de actividad** de la base vieja,
  si sigue accesible, dice qué fue y quién lo hizo.

## B. Se perdió la base o la cuenta de Clever Cloud

1. Crear una base MySQL 8 nueva (otro addon de Clever Cloud, u otro
   proveedor: Aiven, Railway, un MySQL propio).
2. Restaurar el backup ahí (paso A.2), con los datos de la base nueva.
3. Render → Environment: las cinco `MYSQL_ADDON_*` y `MYSQL_SSL`.
4. Pasos A.4 y A.5.
5. Si el usuario nuevo de la base tiene otro nombre, cambiar también los
   secrets del **workflow de backup** (ver más abajo): si no, el backup de
   la noche sigue intentando la base vieja y falla.

## C. Se perdió el backend (Render)

Seguir `REPLICAR_INSTALACION.md`, **paso 2** (Web Service nuevo, mismo
repo, mismas variables). Después:

- **Cambió la dirección del backend** (`algo.onrender.com`), así que hay
  que actualizarla en:
  1. el frontend: `environment.ts` (`backendUrl`) y `firebase.json` (CSP),
     y volver a publicar (`npm run deploy:live`);
  2. la landing (`public/landing.js` y la del repo aparte);
  3. **el `config.ini` del agente en la PC de cada cliente con reloj**
     (`[servidor] url = …`). Hasta que se cambie, ese cliente no sube
     fichajes (los guarda el reloj y se suben cuando se corrija);
  4. MercadoPago: la URL del webhook (`…/webhooks/mercadopago`).
- Sin las variables guardadas (base, `FIREBASE_SERVICE_ACCOUNT`, etc.) este
  paso es muy lento: hay que volver a generarlas una por una. Por eso
  conviene tenerlas en un gestor de contraseñas (ver al final).

> **Mejora recomendada:** un dominio propio (`api.tudominio.com` apuntando
> a Render y `app.tudominio.com` a Firebase). Si mañana hay que mudarse de
> servidor, se cambia a dónde apunta el dominio y **no hay que tocar cada
> agente ni volver a publicar el frontend**.

## D. Se perdió el frontend (Firebase Hosting)

Seguir `REPLICAR_INSTALACION.md`, **paso 3**. Lo más rápido: en el mismo
proyecto de Firebase, Hosting → "Agregar otro sitio", apuntar `.firebaserc`
a él y `npm run deploy:live`. Después:

- agregar la dirección nueva a `CORS_ORIGINS` en Render;
- agregarla a los **Authorized domains** de Firebase Authentication;
- avisar a los clientes la dirección nueva (o, con dominio propio, solo
  cambiar a dónde apunta).

Si lo que pasó es que se publicó una versión con un error: Firebase guarda
las versiones anteriores. **Hosting → historial → ⋮ en la versión anterior →
Rollback** la vuelve a poner en un minuto, sin tocar el repo.

**Si se perdió el proyecto de autenticación** (`asistenciatw`): es el peor
caso, porque ahí están las cuentas. Hay que crear un proyecto nuevo, cambiar
`firebaseConfig` en el frontend y `FIREBASE_SERVICE_ACCOUNT` +
`FIREBASE_WEB_API_KEY` en el backend, y **cada persona tiene que volver a
poner su contraseña**: el UID de cada cuenta cambia, así que hay que
actualizar `app_users.firebase_uid` de cada usuario (o borrarlos y volver a
invitarlos desde Usuarios y Roles). Por eso conviene no tocar ese proyecto y
tener a dos personas como dueñas.

---

## Dónde están los backups

Regla de **3 copias, en 2 medios distintos, 1 fuera del lugar**: cada copia
falla por un motivo distinto y es raro que fallen todas juntas.

| Dónde | Cuándo | Qué lo puede dejar sin correr |
|---|---|---|
| Tu PC: `C:\Users\EURO\Backups\HorasDedica` | Diario 23:14 (tarea programada "backup horasdedica") | Que la PC esté apagada a esa hora |
| GitHub Actions: repo **privado** `Vicentetw/horas-dedica-db-backup` | Diario 03:00 (hora de Argentina) | Que GitHub desactive el workflow por inactividad (avisa por mail) |
| Clever Cloud | Según el plan | Que el problema sea Clever Cloud |

En el repo de backups, cada corrida deja el archivo como **artifact**
(pestaña Actions → la corrida → Artifacts). Para restaurarlo: bajarlo,
descomprimirlo y usar el `.zip`/`.sql` con `restaurar-backup.ps1`.

### Montar el backup en la nube para OTRA instalación

1. Repo **privado** nuevo en GitHub (ahí van credenciales de producción).
2. Copiar `scripts/github-actions-backup.yml` a `.github/workflows/backup.yml`
   de ese repo. (Es la misma versión que ya corre para AVP, con
   `--no-tablespaces`: sin eso, en Clever Cloud el dump falla por falta de
   permiso.)
3. Settings → Secrets and variables → Actions: `MYSQL_HOST`, `MYSQL_PORT`,
   `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DB`.
4. Actions → el workflow → **Run workflow**, y **restaurar** lo que genere.
   Un backup que nunca restauraste no cuenta.

### Dos cosas que lo rompen en silencio

- **GitHub desactiva los workflows programados de un repo sin actividad por
  60 días.** Avisa por mail: cuando llegue, entrar y reactivarlo.
- **Si el workflow falla, GitHub manda un mail.** Revisá que llegue y que no
  caiga en spam.

---

## El ensayo mensual (15 minutos)

```powershell
.\scripts\restaurar-backup.ps1 `
  -Archivo "<el backup más reciente>" `
  -Base ensayo_restore -ConfirmoBase ensayo_restore `
  -Usuario <usuario> -Contenedor mysql_local
```

Restaura en el MySQL local de Docker, sin tocar nada real. Al final muestra
las tablas y cuántos empleados, fichajes, empresas y usuarios hay: tienen
que parecerse a producción. Después: `DROP DATABASE ensayo_restore;`

Lo que rompe un backup no es un evento dramático, es la deriva: cambia una
versión, aparece una tabla nueva, cambia un permiso. El dump sigue diciendo
"Dump completed". La única forma de saber que sirve es restaurarlo.

## Por qué los scripts verifican tanto

`backup-produccion.ps1`, el workflow y `restaurar-backup.ps1` revisan que el
dump termine con `-- Dump completed`. Si `mysqldump` se corta a la mitad, el
archivo queda con tamaño y aspecto normales; lo único que le falta es esa
línea. Un backup truncado que nadie revisó es peor que no tener backup,
porque hace creer que hay uno.

---

## Lo que hay que tener guardado ANTES del desastre

Sin esto, los pasos B, C y D se vuelven muy lentos:

- [ ] Las **variables de Render** (todas), en un gestor de contraseñas.
- [ ] El **JSON de la cuenta de servicio** de Firebase (autenticación).
- [ ] Acceso a las cuentas de **Render, Clever Cloud, Firebase, GitHub,
      Cloudflare (Turnstile) y MercadoPago**, con verificación en dos pasos
      y los códigos de recuperación guardados.
- [ ] La lista de **clientes con agente** y cómo entrar a su PC (para
      cambiar la `url` del `config.ini` si cambia el backend).
- [ ] Al menos un backup de los últimos días **fuera de tu PC** (el de
      GitHub).
