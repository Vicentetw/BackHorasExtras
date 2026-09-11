# Horas Dedica — Backend (repo de despliegue)

Este es el repo que **Render construye y corre**. Es un espejo aplanado del
backend de desarrollo (`horasDedicacionOnline/backendonline2/`, otro repo
en otra carpeta) — mismo código, sin la carpeta `backendonline2/` de por
medio, y con el archivo principal renombrado: `horasdedica.js` acá,
`horasdedica2.js` en el repo de desarrollo.

**La referencia completa** (arquitectura, variables de entorno, endpoints
de la API, seguridad, multiempresa, cómo crear la base de datos desde cero)
vive en el README del repo de desarrollo — este documento cubre solo lo
específico de este repo: cómo sincronizarlo y cómo desplegarlo.

> 📖 Referencia completa: `horasDedicacionOnline/backendonline2/README.md`
> (en el checkout local; el repo de desarrollo es
> `github.com/Vicentetw/horas-dedica-completo`).

## ⚠️ No edites código acá directamente

Todo cambio se escribe y se prueba en el repo de desarrollo
(`backendonline2/`, tiene los tests). Este repo solo recibe una copia una
vez que el cambio ya funciona ahí. Si editás acá sin reflejarlo allá, el
próximo `cp`/`git apply` desde el dev repo puede pisar tu cambio sin avisar.

## Cómo sincronizar un cambio desde el repo de desarrollo

**Archivo principal** (`horasdedica2.js` → `horasdedica.js`, mismo
contenido, nombre distinto):

```bash
# Parado en la raíz del repo de desarrollo (horasDedicacionOnline), con el
# cambio ya commiteado ahí (sha = ese commit):
git diff <sha>~1 <sha> -- backendonline2/horasdedica2.js \
  | sed -e 's#a/backendonline2/horasdedica2.js#a/horasdedica.js#' \
        -e 's#b/backendonline2/horasdedica2.js#b/horasdedica.js#' \
  > /tmp/x.diff

cd ../horasdedicacion-back-deploy/BackHorasExtras
git apply --check /tmp/x.diff    # si no tira error:
git apply /tmp/x.diff
```

**Cualquier otro archivo** (mismo nombre y misma ruta relativa en los dos
repos — `routes/*.js`, `motor-laboral/**`, `db.js`, `security.js`,
`appUserMiddleware.js`, etc.):

```bash
diff ../horasDedicacionOnline/backendonline2/<ruta> <ruta>
# si el archivo de acá no tiene drift propio inesperado:
cp ../horasDedicacionOnline/backendonline2/<ruta> <ruta>
```

**Migraciones nuevas**: se copian tal cual a `migrations/` (son archivos
nuevos, no hay diff que aplicar).

Después: `node -c <archivo>` para chequear que el JS no tenga errores de
sintaxis, `git add`, `git commit`, `git push`, y Manual Deploy en Render
(ver más abajo).

## Configurar Render desde cero

1. [render.com](https://render.com/) → **New → Web Service** → conectá
   este repo de GitHub (`Vicentetw/BackHorasExtras`).
2. Configuración:
   - **Root Directory**: vacío.
   - **Build Command**: `npm install`
   - **Start Command**: `node horasdedica.js`
   - **Health Check Path**: `/health`
3. Variables de entorno (Environment → Add Environment Variable) — la lista
   completa con de dónde sale cada una está en el README del repo de
   desarrollo, sección "Variables de entorno". Como mínimo para que
   arranque: `MYSQL_ADDON_HOST`, `MYSQL_ADDON_PORT`, `MYSQL_ADDON_USER`,
   `MYSQL_ADDON_PASSWORD`, `MYSQL_ADDON_DB`, `FIREBASE_SERVICE_ACCOUNT`,
   `API_KEY`, `CORS_ORIGINS`. No cargues `PORT` — Render la define sola.
4. Deploy inicial. Confirmá con:
   ```bash
   curl https://tu-servicio.onrender.com/health
   # {"ok":true,"ts":...}
   ```
5. **Los deploys posteriores son manuales**: pusheás acá, y en el dashboard
   de Render tocás **Manual Deploy → Deploy latest commit**. No hay
   auto-deploy configurado a propósito (para no desplegar un push a medio
   probar).

## Base de datos (Clever Cloud)

Ver la sección 4 del README del repo de desarrollo para el detalle
completo. Resumen: el addon de Clever Cloud te da las 5 `MYSQL_ADDON_*` en
su pestaña "Environment variables". Para crear el esquema en una base
nueva y vacía:

```bash
export MYSQL_ADDON_HOST="..." MYSQL_ADDON_PORT="3306" \
       MYSQL_ADDON_USER="..." MYSQL_ADDON_PASSWORD="..." MYSQL_ADDON_DB="..."
node run-sql.js schema/full_schema_snapshot.sql
```

`run-sql.js` (en la raíz de este repo) es la única herramienta para correr
SQL contra la base real — no lee ningún `.env`, las credenciales se pasan
por variable de entorno en la terminal para que la contraseña de
producción nunca quede escrita en un archivo que se commitea. Para correr
una migración puntual después:

```bash
node run-sql.js migrations/20260910_employees_legajo_por_tenant.sql
```

Si un archivo falla con "ya existe" (`ER_DUP_FIELDNAME`,
`ER_TABLE_EXISTS_ERROR`, `ER_DUP_KEYNAME`), normalmente significa que esa
migración ya se había corrido antes — no es necesariamente un error real.

## Diagnóstico rápido

Los `.sql` sueltos en la raíz de este repo (`DIAGNOSTICO_*.sql`,
`PRODUCTION_DB_CHECK.sql`) son consultas de solo lectura escritas durante
incidentes puntuales, para correr con `run-sql.js` y ver el estado real de
producción sin adivinar. `PRODUCTION_DB_SYNC.md` documenta un episodio de
sincronización de datos entre entornos — es una bitácora, no un
procedimiento a repetir.
