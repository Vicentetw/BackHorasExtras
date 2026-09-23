# Archivos obsoletos — auditoría del 2026-09-23

Revisión de qué archivos del sistema ya no se usan. **No se borró nada**: esto
es la lista para decidir.

## Cómo se hizo

No a ojo. Se siguieron los `require()` de forma recursiva desde el punto de
entrada real (`horasdedica.js`) y se comparó contra los 167 archivos `.js` del
repositorio, sin `node_modules` ni el agente de Python.

**Resultado: 64 archivos se alcanzan desde el punto de entrada. 18 no.**

De esos 18, la mitad son herramientas que se corren a mano (no tienen por qué
estar enganchadas al servidor) y la otra mitad está muerta de verdad. Después
se verificó uno por uno si algún test o el CI los importa —no por nombre, que
da falsos positivos, sino buscando el `require()` real.

---

## 1. Muertos de verdad — nadie los importa, nada los corre

Estos diez no los alcanza el servidor, ningún test los importa y ningún
workflow los invoca. **26,5 KB entre los cinco de `routes/`.**

| Archivo | Tamaño | Último cambio | Por qué está muerto |
|---|---|---|---|
| `routes/attendance.js` | 8,0 KB | 2026-07-21 | ⚠️ **ojo, no confundir**: el que SÍ se usa es `motor-laboral/routes/attendance.js`, otro archivo distinto con el mismo nombre. Este, el de la raíz de `routes/`, no lo importa nadie |
| `routes/dashboard.js` | 8,5 KB | 2026-09-19 | ya tiene cabecera de archivo muerto |
| `routes/manual.js` | 3,2 KB | 2026-09-19 | ya tiene cabecera de archivo muerto |
| `routes/import.js` | 1,6 KB | 2026-07-03 | lo reemplazó `routes/import.routes.js` |
| `routes/users.js` | 1,3 KB | 2026-07-03 | lo reemplazó `routes/appUsers.js` |
| `endpoints-employees.js` | 11,6 KB | 2026-06-12 | el más grande de la lista; quedó de antes de que los endpoints de empleados se movieran a `routes/employees.js` |
| `update-holidays-table.js` | 3,2 KB | 2026-06-12 | script de una migración de feriados ya aplicada |
| `add-exclusion-column.js` | 2,4 KB | 2026-06-12 | ídem, columna ya agregada |
| `check-holidays.js` | 0,9 KB | 2026-06-12 | script de diagnóstico de un problema puntual de 2026-06 |
| `motor-laboral/migrate.js` | 1,1 KB | 2026-07-03 | corredor de migraciones viejo; hoy se usa `migration-runner/run-migration.js` (el del workflow) o `run-sql.js` |

**Por qué conviene borrarlos y no dejarlos "por las dudas"**: `routes/attendance.js`
es el ejemplo exacto del daño que hacen. Hay dos archivos con el mismo nombre,
uno vivo y uno muerto, y en una búsqueda aparecen los dos. El día que alguien
—o yo— corrija un bug en el equivocado, va a parecer que el arreglo no
funciona, sin ninguna pista de por qué. Los cuatro `routes/` viejos tienen ese
mismo riesgo.

Están todos en el historial de git: borrarlos no pierde nada.

---

## 2. Bloqueados pero todavía presentes

Tres scripts peligrosos y obsoletos que en septiembre se dejaron bloqueados
(abortan si alguien los corre) en vez de borrarlos:

- `fix-duplicate-users.js`
- `fix-userexclusions.js`
- `migrate-exclude-column.js`

Junto con `scripts/guardia-obsoleto.js`, que es el módulo que los bloquea y
existe **solo** para ellos.

Bloquearlos fue lo correcto en su momento: el aviso explica por qué no hay que
correrlos, y borrarlos de una habría dejado esa explicación afuera. Ahora que
está escrita acá, se pueden borrar los cuatro juntos. Decisión pendiente.

---

## 3. NO son obsoletos, aunque tampoco los alcanza el servidor

Son herramientas que se corren a mano. Que no estén enganchadas al servidor es
lo normal:

- `run-sql.js` — correr un `.sql` contra la base
- `scripts/correr-tests.js` — es el `npm test`
- `scripts/limpiar-datos-de-prueba.js` — limpieza de empresas de prueba
- `scripts/cleanup-duplicate-users.js` — mantenimiento de usuarios duplicados
- `scripts/backup-produccion.ps1` — backup diario
- `scripts/exportar-estructura.ps1` — estructura para una instalación nueva
- `migration-runner/run-migration.js` — lo usa el workflow de migraciones

---

## 4. `schema/full_schema_snapshot.sql` — desactualizado, engañoso

Declara **42 tablas**; la base real tiene **51**. Le faltan `ciudades`,
`sucursales`, `day_type_overtime_rules`, `employee_convention_assignments`,
`event_type_count_modes`, `manual_entry_log`, `manual_checkin_log`,
`user_exclusion_log`, `rule_engine_shadow_diffs` y
`work_schedule_template_config_history`.

Es peor que un archivo muerto: parece vigente. Alguien que lo use para crear
una base nueva se lleva una base incompleta y lo descubre tarde.

Dos caminos: borrarlo, o dejarlo con un aviso arriba que diga que la fuente de
verdad es `scripts/exportar-estructura.ps1`. **Recomiendo borrarlo** — un
archivo que hay que mantener sincronizado a mano se va a volver a
desactualizar.

---

## 5. 🔴 El hallazgo más serio: el frontend depende del repo obsoleto

`copy-legacy-assets.js` del frontend tiene esta línea:

```js
const LEGACY_PUBLIC = 'C:\\angular\\horasDedicacionOnline\\public';
```

Una **ruta absoluta al monorepo `horas-dedica-completo`**, el que
`ESTADO_PROYECTO.md` declara obsoleto y recomienda borrar o renombrar.

Ese script corre dentro de `npm run deploy:live`. O sea: **el día que se borre
ese repo, el deploy del frontend deja de funcionar**, y el error va a apuntar
a una carpeta que uno creía que ya no importaba.

De esa carpeta se copian `START.html`, `template-empleados-matching.csv` y las
carpetas `css/` y `js/`. Son pocos archivos y están decididos a propósito (el
comentario del script lo explica bien).

**Qué conviene hacer**: mover esos cuatro al repo del frontend, en una carpeta
propia tipo `legacy/`, y cambiar la ruta a una relativa. Deja de haber una
dependencia entre repos, y el monorepo queda libre para borrarse de verdad.

Además, esa misma carpeta `public/` del monorepo tiene 11 HTML viejos
(`dashboard.html`, `attendance.html`, `importa.html`, `matching-dashboard.html`,
`salidas.html`, `marcadores.html`, etc.) y una copia del **código fuente del
backend** en `public/motor-laboral/`. El script ya evita copiar eso último a
propósito —estuvo expuesto públicamente en el deploy viejo—, pero sigue ahí en
el disco.

---

## 6. La carpeta `legacy/` del frontend — retirada entera (2026-09-23)

Al mover los archivos del monorepo viejo al repo del frontend (punto 5) quedó
una carpeta `legacy/` de 16 archivos y 222 KB. Revisada archivo por archivo,
**no quedaba nada vivo**.

### `START.html` — una página de inicio que mentía

Era la última página HTML plana en pie: una pantalla de "Acceso Rápido" con
tarjetas. El problema no es que fuera vieja, es que **afirmaba cosas falsas** a
quien la abriera:

- *"Base de datos limpia (480 usuarios, 57 empleados)"* — números fijos,
  escritos a mano hace meses.
- *"Backend Node.js funcionando (puerto 3000)"* — localhost, sin ningún
  sentido en el sitio publicado.
- Un botón "Descargar" apuntando a `template-empleados-ejemplo.xlsx`, que **no
  existe en ninguna parte**.
- Un "Flujo Recomendado" que manda a `matching-dashboard-v2.html` — ni existe
  ni tiene redirect (el redirect es para `matching-dashboard.html`, sin `-v2`).
- Cuatro documentos citados (`INSTRUCCIONES-v2.md`, `REDESIGN-v2-SUMMARY.md`,
  `generate_example.py`…) que tampoco existen.

Dos de sus tres tarjetas funcionaban de casualidad, porque `app.routes.ts` ya
tenía redirects para esas URLs viejas. Una estaba rota.

Se retiró y se agregó `{ path: 'START.html', redirectTo: '' }`, igual que las
otras once páginas viejas. Quien tenga el link guardado cae en el inicio real.

### `template-empleados-matching.csv` — huérfana **y mal formada**

Nada en el código de Angular la referencia: el diálogo de importación de
`/empleados` **genera su propia plantilla** en memoria
(`import-dialog.ts:368`, `downloadTemplate()`), con los mismos tres empleados
de ejemplo pero en `.xlsx`.

Y además estaba rota como CSV. El encabezado declara 11 columnas, pero el
campo `nombre` trae una coma sin comillas:

```
employee_id,nombre,documento,...        <- 11 columnas
10000,CERVO, Agustín Julián,12345678,...  <- 12 campos
```

Todas las filas quedan corridas un lugar. Quien la hubiera usado de modelo se
llevaba un archivo que no importa, o peor, que importa las columnas
desplazadas. El `.xlsx` que genera Angular no tiene el problema, porque la
librería escapa el campo sola.

### El resto: 197 KB de código de páginas que ya no existen

De los 16 archivos, `START.html` solo usaba tres (`css/auth.css`,
`js/firebase-config.js`, `js/firebase-auth.js`). Los otros doce eran de las
páginas retiradas en la Fase 6: `js/app.js` (96,9 KB), `js/motor-laboral-admin.js`
(31,8 KB), `js/employee-scheduler.js` (23,6 KB), `js/config.js` y siete hojas
de estilo.

Al no quedar nada que copiar, `copy-legacy-assets.js` dejó de tener sentido y
también se retiró: `build:deploy` era `ng build` más ese paso, así que los
scripts de deploy ahora llaman directamente a `build`.

## Resumen

| Grupo | Cuántos | Estado |
|---|---|---|
| Muertos de verdad (backend) | 10 archivos (~42 KB) | ✅ retirados |
| Bloqueados pero presentes | 4 archivos | ✅ retirados |
| Snapshot desactualizado | 1 archivo | ✅ retirado |
| Dependencia con el repo obsoleto | 1 línea | ✅ arreglada (ruta relativa) |
| `pass-user.py` publicado | 1 archivo | ✅ retirado y republicado |
| Carpeta `legacy/` del frontend | 17 archivos (222 KB) | ✅ retirada entera |
| Herramientas (no obsoletas) | 7 archivos | se quedan |

**Total retirado: 33 archivos.** Todos están en
`C:\angular\horasdedica_archvos_eliminados` y en el historial de git.

Dos de estos no eran higiene sino cosas que iban a fallar: la ruta absoluta
al monorepo (habría roto el deploy del frontend el día que se borrara ese
repo) y `pass-user.py` (un script que imprime las contraseñas del reloj,
accesible públicamente en el sitio).

## Lo que queda sin resolver

El monorepo `C:\angular\horasDedicacionOnline` ya no tiene ninguna
dependencia técnica con los repos vivos, así que **se puede borrar o
renombrar**. Antes de hacerlo conviene mirar su carpeta `public/`: todavía
tiene 11 HTML viejos y una copia del código fuente del backend en
`public/motor-laboral/` (que llegó a estar expuesta públicamente en el deploy
viejo).
