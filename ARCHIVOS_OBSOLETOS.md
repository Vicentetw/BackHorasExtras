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

## Resumen

| Grupo | Cuántos | Recomendación |
|---|---|---|
| Muertos de verdad | 10 archivos (~42 KB) | borrar |
| Bloqueados pero presentes | 4 archivos | borrar, ahora que el motivo está escrito acá |
| Snapshot desactualizado | 1 archivo | borrar |
| Dependencia con el repo obsoleto | 1 línea | **arreglar antes de borrar el monorepo** |
| Herramientas (no obsoletas) | 7 archivos | dejar |

Lo único con urgencia es el punto 5: no es limpieza, es algo que se va a
romper. El resto es higiene.
