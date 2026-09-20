# Estado del proyecto — Motor de reglas de asistencia configurable

Última actualización: 2026-09-18

Este documento es para cualquier programador (yo mismo en el futuro, u
otra persona) que retome este trabajo. Resume qué se hizo, por qué, qué
quedó funcionando, y qué falta.

## Repos y deploys

- **Backend**: `BackHorasExtras` (GitHub: `Vicentetw/BackHorasExtras`), rama `main`. Deploy: Render (`https://academypruebadep.onrender.com`), auto-deploy al pushear a `main`. Base de datos: MySQL en Clever Cloud (credenciales en `.env` de producción del servicio en Render).

  ⚠️ **`motor-laboral/.env` tiene acceso TOTAL a producción, no de solo lectura.** Este documento decía antes que era "una copia de solo-lectura"; se verificó el 2026-09-19 con `SHOW GRANTS` y es falso: el usuario tiene `ALL PRIVILEGES` sobre la base entera, o sea que puede modificar y borrar cualquier cosa. El archivo está fuera de git (lo cubre el `.gitignore`), pero **cualquier script que se corra apuntando a ese `.env` está escribiendo en producción**. Nunca correr tests contra él. Si se quiere que sea de verdad de solo lectura, hay que crear un usuario aparte en Clever Cloud con permiso `SELECT` solamente y usar ese.
- **Frontend**: `horas-dedica-angular` (GitHub: `Vicentetw/horas-dedica-angular`), rama `main`. Deploy: Firebase Hosting, proyecto `horasdedicacionavp`, sitio real `https://horasdedicacionavp.web.app`. El deploy **no es automático** — hay que correr `npm run deploy:live` a mano después de cada push a `main`.
- **Base de test local** (para desarrollo/tests, NO es producción): MySQL en `localhost:3307`, base `horas_dedica2`, user `root`, password `0113333`. El `.env` en la raíz de `BackHorasExtras` apunta ahí. **El `.env` local NO tiene credenciales de producción** — Clever Cloud solo se toca desde el workflow de migraciones.
- **Repo viejo `horas-dedica-completo`** (local: `C:\angular\horasDedicacionOnline`): era el monorepo donde vivía todo junto. **Ya no se usa para el backend.** Quedó en el commit del 2026-09-17 y su carpeta `backendonline2/` está congelada en la migración `20260920` — le faltan las 7 migraciones siguientes y todo el motor de reglas. El backend se separó a `BackHorasExtras` para el deploy en Render, y el frontend a `horas-dedica-angular` para la migración a Angular. **No portar cambios hacia atrás**: si algo falta ahí, es a propósito.
- **Agente de descarga de fichajes** (programa Python que corre en una PC Windows 10 junto al reloj biométrico, se compila a `.exe` con PyInstaller vía `main.spec` y deja el ejecutable en `dist/`): desde el **2026-09-19 vive en este mismo repo**, en `descarga-fichaje-py/`. Además de generar los dos CSV (`CHECKINOUT.csv` y `USERINFO.csv`), **sube los fichajes a la nube** por su cuenta (ver `api_client.py` y `agent_runner.py`).

  Antes andaba suelto en dos carpetas del disco, sin versionar acá. **Las dos quedan obsoletas** y conviene borrarlas o renombrarlas a `-VIEJO-NO-USAR`, porque tocar la copia equivocada de un programa que sube fichajes a producción sería un problema serio:
  - `C:\angular\horasDedicacionOnline\descarga-fichaje-py` — era la vigente; es la que se trajo acá.
  - `C:\angular\descarga-fichaje-py` — desactualizada desde principios de septiembre.

  Qué cambió al traerlo, y por qué:
  - **Solo se trajo el código (86 KB).** En el repo anterior la carpeta pesaba 100 MB porque estaban commiteados los dos entornos virtuales (`.venv` y `zk-env`), `dist/` con el `.exe` y una base de 19 MB, y los CSV. Eso hacía que cada `git status` mostrara cientos de archivos de `pip` como modificados — se ve en el historial. El `.gitignore` nuevo lo evita.
  - **Los CSV no se versionan**: `CHECKINOUT.csv` y `USERINFO.csv` son nombres de empleados reales y sus fichajes. Son datos personales, no código.
  - **`config.ini` sí se versiona, pero como plantilla** con `url =` y `clave =` vacíos (así estaba). La clave de agente de cada empresa se carga en la PC donde corre el agente.
  - **Se agregó `requirements.txt`, que no existía.** El proyecto dependía de que el `.venv` siguiera vivo en esa máquina; si se borraba, no había forma de saber qué instalar para recompilar el `.exe`. Las versiones se sacaron leyendo el `.venv` real, no de memoria: `pyzk==0.9` (habla con el reloj), `tzdata` (sin esto `zoneinfo` no funciona en Windows), `sv-ttk` (tema visual, opcional), `pywin32` (solo para `enrolar.py`) y `pyinstaller==6.22.2` para compilar.
  - Verificado al traerlo: los 9 archivos `.py` compilan y los 6 módulos sin interfaz gráfica importan sin errores (Python 3.12.3).

## Qué es "el motor de reglas configurable"

Iniciativa grande (documento fuente: `Actúa como arquitecto de software
senior motor de horas.docx`, guía de ejecución: `fases para impletentar
avance.txt`, ambos en la raíz de este repo) para agregar una capa
configurable de horarios/tolerancias/horas extra/convenios **sin romper
ni duplicar** el sistema de asistencia existente.

**Regla de oro de todo el diseño**: el motor viejo (Legacy, el de
siempre) sigue siendo el único que calcula el resultado oficial de
horas extra/tardanzas para **cualquier plantilla que no se toque**. Todo
lo nuevo es opt-in vía la columna `work_schedule_templates.rules_engine_mode`:

- `legacy` (default, **todas las plantillas de producción están así
  hoy** — verificado en la base real: 4 de 4): cero cambio de
  comportamiento, el motor nuevo ni siquiera se ejecuta.
- `shadow`: el motor nuevo corre EN PARALELO al Legacy, solo para
  comparar (queda en `day.shadowResult` en la respuesta de
  `/attendance-range`, y las diferencias encontradas se guardan en la
  tabla `rule_engine_shadow_diffs`). El resultado oficial sigue siendo
  el de Legacy.
- `active`: el resultado del motor nuevo **pasa a ser el oficial** para
  esa plantilla (mismos nombres de campo de siempre: `status`,
  `overtimeMinutes`, `lateMinutes`, etc. — solo cambia quién los
  calcula). Si el motor nuevo tira un error un día puntual, cae
  automáticamente a Legacy para ese día (nunca rompe el cálculo
  oficial de nadie).

Ambos modos (`shadow`/`active`) se configuran por plantilla desde
"Plantillas de Horario" → editar plantilla → sección "Motor de reglas
(avanzado)", **visible solo para superadmin**.

### Piezas del motor nuevo (todas en `motor-laboral/`)

- `services/scheduleResolver.js` — arma segmentos de horario (soporta
  turno partido, nocturno) a partir de `shift_blocks`.
- `services/toleranceResolver.js` — tolerancia de entrada/salida
  anticipada y las 4 políticas de tiempo antes/después del horario.
- `services/timeClassifier.js` (`computeAttendanceResult`) — junta
  todo lo anterior en un resultado clasificado (normal/HE
  reconocida/HE no autorizada/incidencias). Es el corazón del motor.
- `services/dayTypeRuleResolver.js` — resuelve tasas de HE por tipo de
  día (feriado/franco/sábado/domingo), con desempate por especificidad
  (plantilla > convenio > tenant > global). Nunca hardcodea `if
  holiday => 100`, todo sale de la tabla `day_type_overtime_rules`.
- `services/shadowComparator.js` — compara Legacy vs motor nuevo y
  clasifica diferencias (esperada / nueva funcionalidad / inesperada /
  posible regresión).
- `services/templateConfigHistoryResolver.js` +
  `repositories/templateConfigHistoryRepository.js` — vigencia
  histórica de la configuración de tolerancia de una plantilla (para
  que cambiar la config hoy no altere el recálculo de un mes ya
  cerrado).
- `services/checkinNormalizer.js` — detecta y corrige fichajes
  duplicados/de más antes de clasificar (ver Hallazgo #2 más abajo).
- `repositories/conventionAssignmentRepository.js` +
  `repositories/dayTypeRuleRepository.js` — resuelven qué convenio
  tiene un empleado en una fecha y qué reglas de HE le aplican.

### Migraciones (en orden, todas idempotentes — se pueden re-correr sin romper nada)

```
migrations/20260921_template_tolerances.sql
migrations/20260922_day_type_overtime_rules.sql
migrations/20260923_employee_convention_assignments.sql
migrations/20260924_rules_engine_mode_and_shadow_diffs.sql
migrations/20260925_template_config_history.sql
migrations/20260926_shadow_diffs_unique_key.sql
migrations/20260927_manual_entries_exclusions_audit.sql   <-- PENDIENTE en producción
```

Las seis primeras están **ya corridas en producción** (confirmado por el
usuario el 2026-09-18). La `20260927` es del 2026-09-19 y **todavía no se
corrió** — ver la sección "Auditoría de cargas manuales" más abajo.
Para correr una migración nueva contra producción: pestaña **Actions**
del repo → workflow "Correr migracion SQL en produccion (manual)" →
`migration_files` con el/los archivo(s), separados por coma. Nadie
(ni el asistente de IA) tiene acceso directo a escribir en la base de
producción por fuera de ese workflow — es una restricción de entorno
intencional. El `.env` local apunta a `localhost` (MySQL de desarrollo),
no a Clever Cloud.

> **Requisito que se descubrió el 2026-09-19**: ese workflow necesita que
> **este repositorio** tenga cargados sus cinco secrets
> (`MYSQL_ADDON_HOST`, `MYSQL_ADDON_USER`, `MYSQL_ADDON_PASSWORD`,
> `MYSQL_ADDON_DB`, `MYSQL_ADDON_PORT`) en *Settings → Secrets and
> variables → Actions*. Cada repositorio tiene su propio almacén: apuntar
> a la misma base que otro repo **no** los comparte. Al intentar correr la
> migración `20260927` llegaron los cinco vacíos y el workflow moría
> mostrando literalmente `ERROR:` y nada más, porque `run-migration.js` no
> validaba las credenciales y el error de conexión de Node venía con el
> mensaje vacío. Eso ya está corregido: ahora explica exactamente qué
> falta y dónde cargarlo. Los valores son los mismos que ya tiene el
> servicio de backend en Render (pestaña Environment).

### Frontend nuevo (en `horas-dedica-angular`, todo bajo `src/app/motor-laboral/`)

- `conventions-page/` — CRUD de convenios (`labor_conventions`) y
  reglas de HE por tipo de día (`day_type_overtime_rules`). Ruta:
  `/convenios-horas-extra`.
- `convention-dialog/`, `day-type-rule-dialog/` — diálogos de alta/edición.
- `simulator-dialog/` — simulador de solo lectura (nunca escribe nada),
  para ver cómo clasificaría el motor nuevo un fichaje hipotético.
- `template-dialog` — suma el selector de `rules_engine_mode` (solo
  superadmin) y los 4 campos de tolerancia.
- `assign-employees-page` — suma la sección "Encuadramiento a
  convenio" en el detalle de cada empleado.
- `onboarding-page` — el tutorial de Inicio menciona el paso de
  "Convenios y horas extra especiales (opcional)".

## Auditoría final (Etapa 14) — 9 hallazgos, todos corregidos

Se hizo una auditoría exhaustiva antes de mergear a producción
(arquitectura, datos, histórico, seguridad, performance, etc.). Los 9
problemas encontrados y sus commits:

1. **Convenios sin efecto real en el cálculo** — el `RuleResolver` que
   conecta convenio→reglas nunca se había construido. Corregido +
   de paso se arregló una fuga real de `tenant_id` en el filtro de
   reglas (una regla de una empresa podía aplicarle a otra en un
   pedido cross-empresa de superadmin). Commit `57e5b64`.
2. **Fichajes duplicados/de más se perdían en silencio** — un rebote
   de reloj podía truncar el día entero a cero horas sin ningún aviso.
   Nuevo `checkinNormalizer.js`. Commit `e57cc7a`.
3. **Configuración de plantilla sin vigencia histórica** — cambiar la
   tolerancia de una plantilla alteraba el recálculo de meses ya
   cerrados. Nueva tabla `work_schedule_template_config_history`.
   Commit `e57cc7a`.
4. **Nada operable desde el frontend** — convenios/reglas de HE solo
   se podían cargar por SQL directo. CRUD + pantallas nuevas. Commits
   `4b54729` (backend) + `5dece91` (frontend).
5. **`rules_engine_mode` no editable por API + modo `active` sin
   implementar de verdad** — corregido, ver arriba. Commit `e0e7dcf`.
6. **Diferencias de modo sombra se duplicaban** en cada refresco.
   Clave única + upsert. Commit `96b2d14`.
7. **Sin tests de aislamiento de tenant** para el CRUD nuevo — 12 tests
   agregados en el mismo commit que el CRUD. Commit `4b54729`.
8. **Recálculo redundante** de segmentos de horario por cada empleado
   — memoizado con un `WeakMap` por request. Commit `96b2d14`.
9. **Modo `active` sin ningún test** — agregado junto con el punto 5.

Backend: **513/513 tests** al momento del merge (más 1 que fallaba y que
se venía anotando como "flake preexistente de MercadoPago").

**Ese "flake" no era un flake** (resuelto el 2026-09-19, commit
`53223d9`). El endpoint de checkout de MercadoPago chequeaba
`MERCADOPAGO_ACCESS_TOKEN` **antes** de validar los datos del request, así
que en cualquier entorno sin ese token (local, CI) un `billing_period`
inválido devolvía 503 "token no configurado" en lugar del 400 que
corresponde — y el test que espera 400 fallaba siempre. Nunca llamó a la
API real: los dos tests que sí la usan ya tenían su guarda
`if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return`. Se invirtió el orden
(primero validar lo que manda el cliente, después la configuración del
servidor), que además es lo correcto: un dato inválido es 400 tenga o no
tenga el servidor configurado el servicio externo.

**Lección**: un flake de verdad falla a veces; éste fallaba idéntico
siempre, en las ~15 corridas. Esa consistencia era la pista, y se dejó
pasar durante días por tenerlo catalogado como "falla conocida". Conviene
desconfiar de esa etiqueta.

Estado al 2026-09-19: **526/526, la suite completa en verde**.

## Bugs encontrados DESPUÉS del deploy (ya corregidos)

1. **Export de "Horas Extra por Régimen" mostraba minutos crudos**
   (ej. "1639" en vez de "27h 19m") en el detalle día-por-día de un
   empleado. El total en pantalla siempre pasaba por `HoursMinutesPipe`,
   pero el CSV/PDF exportaba el número sin formatear. Commit `4717996`.

2. **El menú rápido de un día en el calendario de Presentismo rompió
   el calendario MENSUAL** al agregarle una tercera opción
   ("Justificar"). Causa: el botón nuevo mostraba un texto dinámico
   `{{ actionLabel(activeDay()!) }}` en el template — Angular evalúa
   eso en CADA ciclo de detección de cambios (a diferencia de un
   `(click)`, que solo corre cuando ya hay un día elegido), y
   `activeDay()` arranca en `null` hasta el primer clic → tiraba un
   error antes de que nadie tocara nada. Se revirtió (`a41b86c`) y se
   reimplementó bien (`5aa78c1`) con el MISMO patrón que los otros 2
   botones del menú: etiqueta fija en el template, `activeDay()`
   usado únicamente dentro del `(click)`. **Lección para el futuro**:
   nunca leer una señal que puede ser `null` en una interpolación de
   un `<mat-menu>` compartido — solo dentro de manejadores de evento.

## Auditoría de cargas manuales + agujero de empresa (2026-09-19)

**Qué se hizo y por qué.** Hasta ahora, si alguien cargaba 8 horas extra a
mano o marcaba un día como Vacaciones, quedaba el dato pero no quedaba
**quién** lo hizo ni **cuándo**. Ante un reclamo ("yo no pedí esa
licencia", "esas horas no las autorizó nadie") no había con qué responder.
Los fichajes manuales ya tenían esto desde la migración `20260920`
(`manual_checkin_log`); ahora lo tienen también las otras dos cosas que se
cargan a mano y que impactan en la plata.

**Hallazgo grave que apareció en el camino.** `ManualEntries` **no tenía
`tenant_id`** y ninguno de sus 4 endpoints validaba la empresa. Un
administrador de la empresa A podía cargarle horas extra a un empleado de
la empresa B, o borrarle las suyas, mandando su `USERID` de reloj (que es
secuencial, o sea adivinable). Es el mismo tipo de hueco ya tapado en las
tablas crudas del reloj (migración `20260909`); esta tabla se había pasado
por alto. Verificado leyendo el código anterior con `git show`: cero
menciones de empresa en esos endpoints.

Los dos temas se arreglaron juntos porque **el primero necesita el
segundo**: una fila de auditoría sin empresa no sirve para nada.

**Qué se agregó**

- `migrations/20260927_manual_entries_exclusions_audit.sql`:
  `ManualEntries` suma `tenant_id` (con backfill seguro), `created_by`,
  `updated_by`, `updatedAt`; `userexclusions` suma `created_by`,
  `updated_by`, `updatedAt`; y se crean dos tablas de log append-only,
  `manual_entry_log` y `user_exclusion_log`, con una columna `previous_data`
  (JSON) que guarda **cómo estaba la fila antes** de cada modificación o
  borrado.
- `auditLog.js` (nuevo): el helper que usan los endpoints. Lo importante
  es `inTransaction`: el cambio de datos y su fila de auditoría se
  confirman **juntos o ninguno**. Si fueran dos queries sueltas, un error
  entre medio dejaría una carga sin autor (justo lo que esto viene a
  evitar) o un historial que miente.
- 9 puntos de escritura instrumentados en `horasdedica.js` (3 de
  `ManualEntries`, 6 de `userexclusions`).
- `test/manual-entries-audit.test.js` (13 tests): el ciclo completo
  alta→edición→borrado deja el rastro esperado, y los 4 cruces entre
  empresas dan 404 sin tocar nada.

**Sobre el backfill de `tenant_id`.** `users.USERID` no es único entre
empresas, así que un `JOIN` directo podría asignar una fila a la empresa
equivocada. El backfill sólo resuelve los `USERID` que pertenecen a **una
sola** empresa; las filas ambiguas quedan en `NULL` a propósito. La
migración informa al final cuántas quedaron así (en desarrollo: 1, de un
usuario borrado hace tiempo). **Al correrla en producción hay que mirar
ese número** — esas filas dejan de verse desde la aplicación.

**Efecto secundario correcto, no un bug.** Ahora no se puede borrar un
`app_users` que tenga historial de auditoría (lo impide la foreign key de
`performed_by`). En producción eso no molesta: la app nunca borra usuarios,
los deshabilita (`is_active = 0`, ver `routes/appUsers.js`). Sí afectaba al
*teardown* de los tests, que sí borran de verdad — resuelto en
`test-helpers/firebaseTestAuth.js`.

**Código muerto detectado.** `routes/manual.js` y `routes/dashboard.js`
**no los monta nadie** (el único servidor es `horasdedica.js` y no los
requiere). Contienen escrituras SQL sin permisos, sin empresa y sin
auditoría. Ya se había gastado trabajo de seguridad en ellos al pepe: el
commit `fd36be5` los "arregló" sin que eso protegiera nada real. Quedaron
marcados con un cartel arriba de todo; **conviene borrarlos** (decisión del
dueño del repo, git conserva el historial igual).

**Migración aplicada en producción el 2026-09-19.** Resultado verificado:
7 columnas nuevas, las 2 tablas de log, el índice y las 4 foreign keys de
autoría creados; 26 de 27 filas de `ManualEntries` quedaron asignadas a la
empresa 6 (AVP); y **ningún campo preexistente cambió** (se comparó fila
por fila contra una copia tomada antes de migrar). Falta **desplegar el
código** para que el filtro de empresa y el log empiecen a actuar.

Todavía no hay pantalla para *ver* el historial: una vez desplegado los
datos se guardan, pero por ahora se consultan por SQL.

**Una fila quedó sin empresa** y hay que decidir qué hacer:
`ManualEntries` id 40 — `userId` 2926, 2 h de HE del 2026-06-05, nota
"corte de energía". Su `USERID` no existe en `users`, por eso el backfill
no pudo resolverla. Como producción tiene **una sola empresa** (id 6,
AVP), asignarle `tenant_id = 6` es casi seguro lo correcto; mientras siga
en `NULL` esa entrada no se ve desde la aplicación.

## 🔴 Hallazgo GRAVE sin resolver (2026-09-19): fichajes sin usuario

Encontrado por casualidad al investigar la fila huérfana de arriba.
**81.622 de los 156.732 fichajes de producción (52 %) pertenecen a 104
`USERID` que no tienen ninguna fila en `users`.** No es un problema de
empresa mal asignada: se verificó que esos `USERID` no existen en `users`
para *ninguna* empresa (0 casos de desajuste de `tenant_id`). Tampoco
están en `user_employee_map`, o sea que no se pueden resolver a ningún
empleado.

Lo preocupante es que **no son historia vieja**: 96 de esos 104 ficharon
en los últimos 60 días (10.533 fichajes), varios el 2026-09-18.

Por qué importa: toda la cadena de reportes va
`Checkins → users → user_employee_map → employees`. Si falta el eslabón
`users`, esos fichajes no aparecen en Presentismo ni en los cálculos de
horas extra. Y peor: la pantalla de **Matching**, que existe justamente
para detectar usuarios de reloj sin vincular, lee de `users` — así que
estos casos **no aparecen ni siquiera como pendientes**. Son invisibles
para la herramienta hecha para encontrarlos.

Hipótesis a verificar (no confirmada): el agente inserta fichajes con
`insertCheckinsBatch` para `USERID` que `upsertUsersBatch` no cubrió —
por ejemplo si la subida de la lista de usuarios falla o viene parcial
mientras la de fichajes sigue. Ver `checkinsIngestService.js` y
`routes/agent.js`.

Primer paso sugerido: contrastar esos 104 `USERID` contra la nómina real.
Si son empleados actuales, hay horas trabajadas que no se están
liquidando. Números de contexto: 499 filas en `users`, 457 vínculos en
`user_employee_map`, 160 empleados con `activo = 1`.

## Problema ABIERTO ahora mismo (sin resolver, 2026-09-18)

**Síntoma reportado por el usuario**: al abrir el detalle
mensual/anual de un empleado en Presentismo, a veces (no siempre)
tarda hasta 10 segundos en mostrar algo, y a veces el calendario no
llega a cargar (quedan solo los 3 resúmenes de arriba). No es la
primera consulta la que falla — pasa en la 3ra o 4ta.

**Descartado con evidencia dura** (consulta de solo lectura a la base
de producción real, 2026-09-18): NINGUNA plantilla está en modo
`shadow`/`active` (4 de 4 en `legacy`), y la tabla
`rule_engine_shadow_diffs` tiene 0 filas. El motor nuevo no se está
ejecutando para nadie en producción hoy — **no es la causa**.

**Hipótesis todavía sin confirmar** (por orden de probabilidad):

1. **Pool de conexiones MySQL agotado bajo uso concurrente.** Ver
   comentario en `db.js`: el plan de Clever Cloud limita
   `max_user_connections` a 5, y el pool de este proceso usa
   `connectionLimit: 4` (con 1 de margen para scripts manuales). Si
   varias pantallas/usuarios piden datos a la vez (Presentismo,
   sincronización, etc.), las consultas nuevas pueden quedar en cola
   esperando una conexión libre — esto encajaría con "en la 3ra/4ta
   consulta, no en la primera".
2. **Costo intrínseco de `/attendance-range` para un rango anual** —
   365 días de un empleado, con varias sub-consultas (feriados,
   exclusiones, licencias, HE manual, marcadores). No debería tomar
   10 segundos por sí solo, pero no se descartó con una medición
   directa.
3. Algo en el propio Render/Clever Cloud (latencia de red variable,
   no relacionado al código).

**Se descartó también** un "cold start" de Render (el plan gratuito/de
entrada duerme el servicio tras inactividad) porque el usuario
confirmó que NO es la primera consulta la que falla.

**Próximos pasos para diagnosticar** (nadie los hizo todavía):
- Pedirle al usuario que abra la pestaña Network del navegador (F12)
  y mida cuánto tarda específicamente la petición a `attendance-range`
  cuando pasa esto, y si termina en 200 o en error/timeout.
- Revisar los logs de Render en el momento exacto de la lentitud
  (requiere acceso a la consola de Render, que el asistente de IA no
  tiene).
- Si se confirma la hipótesis del pool de conexiones: considerar subir
  el plan de Clever Cloud (más conexiones permitidas), o revisar si
  hay conexiones que no se liberan bien en algún camino de código.

## CI — tests automáticos (arrancado 2026-09-18)

### Qué es y por qué

"CI" (integración continua) significa que los tests corren **solos, en
los servidores de GitHub, cada vez que alguien sube código** — no
dependen de que alguien se acuerde de correrlos en su máquina. Si algo
se rompe, GitHub lo marca en rojo.

Esto no es teoría: el 2026-09-18 se pusheó a `main` (que Render
despliega automáticamente) sin correr los tests y antes de aplicar las
migraciones. Si alguien hubiera editado una plantilla de horario en esa
ventana, le habría dado un error de SQL. Con CI + branch protection eso
deja de ser posible.

### Qué quedó configurado

`.github/workflows/tests.yml` — corre en cada push a `main` y en cada
Pull Request. Ejecuta `npm run test:unit`.

### Qué cubre y qué NO (importante entender la diferencia)

De los **77** archivos de test del repo:

- **18 son "puros"**: no necesitan base de datos, ni el servidor
  levantado, ni internet. Son 207 tests que corren en ~2 segundos.
  **Estos son los que corren en CI hoy.** Y no es poca cosa: son los
  del motor de cálculo (tolerancias, clasificación de horas extra,
  turno partido, cruce de medianoche, fichajes duplicados) — o sea, la
  parte que define cuánto cobra cada persona.
- **59 son de integración**: necesitan MySQL con el esquema completo,
  el backend corriendo en `localhost:3000`, y credenciales reales de
  Firebase (piden un token de verdad a Google). **Estos NO corren en CI
  todavía** — hacerlo es la "Fase 2" del backlog.

La razón de arrancar solo con los puros: un CI que falla por problemas
de infraestructura (y no por bugs reales) se vuelve ruido, la gente
aprende a ignorarlo, y termina siendo peor que no tenerlo. Mejor
empezar con algo que siempre es señal verdadera, y ampliarlo después.

### Cómo agregar un test nuevo a CI

Si el test nuevo **no** usa base ni servidor (o sea, no tiene
`require('dotenv')`, ni `require('../db')`, ni `TEST_BASE_URL`, ni
`mysql.createConnection`), agregá su nombre a la lista del script
`test:unit` en `package.json`. Si sí los usa, por ahora queda fuera de
CI y solo corre con `npm test` en local.

### Lo que falta hacer A MANO en GitHub (no se puede por código)

**Branch protection** — hoy cualquiera (incluida una IA, o vos apurado
un viernes) puede pushear directo a `main` y disparar un deploy. Para
cerrarlo, en **cada uno de los dos repos**:

1. GitHub → repo → **Settings** → **Branches** → **Add branch ruleset**
   (o "Add rule" según la versión).
2. Branch name pattern: `main`.
3. Tildar **"Require a pull request before merging"** (obliga a que todo
   cambio pase por un PR, aunque lo apruebes vos mismo).
4. Tildar **"Require status checks to pass before merging"** y elegir el
   check **"Tests de lógica (sin base de datos)"** (aparece en la lista
   recién después del primer push que dispare el workflow).
5. Guardar.

A partir de ahí: si los tests fallan, GitHub no deja mergear. Y como
Render despliega desde `main`, no puede llegar a producción algo con
los tests en rojo.

## Trabajo pendiente (backlog, ninguno arrancado)

1. **Resolver el problema de lentitud de arriba.**
2. **Plan "Camino al 100%"** (guardado en
   `C:\Users\EURO\.claude\plans\staged-sauteeing-starfish.md` en la
   máquina del desarrollador que usó Claude Code — si no se tiene
   acceso a ese archivo, esto resume lo que falta):
   - **Fase 2 (parcialmente hecha)**: ✅ CI andando con los 18 tests
     puros (ver sección "CI" arriba). ⏳ Falta llevar a CI los 59 tests
     de integración: hay que levantar MySQL como *service container* en
     el workflow, cargar el esquema (`schema/full_schema_snapshot.sql`)
     + todas las migraciones en orden, arrancar el backend en segundo
     plano, y guardar el service account de Firebase como *secret* del
     repo (`firebaseTestAuth.js` ya soporta leerlo de la variable de
     entorno `FIREBASE_SERVICE_ACCOUNT`). Ojo con dos cosas al hacerlo:
     el test de MercadoPago falla siempre porque llama a la API real
     (hay que aislarlo o excluirlo), y los tests piden tokens reales a
     Google, que rate-limitea si se corre la suite muchas veces
     seguidas (pasó durante el desarrollo).
   - **Fase 3**: ⏳ activar branch protection en ambos repos — pasos
     exactos documentados en la sección "CI" de arriba. **Lo tiene que
     hacer el usuario a mano en GitHub**, no se puede por código.
   - **Fase 4**: disciplina de "definición de terminado" (cada cambio
     con su test antes de mergear) — ya se venía siguiendo de hecho
     durante todo el desarrollo del motor de reglas.
3. **Si en algún momento se activa `rules_engine_mode='active'` en una
   plantilla real**: hacerlo con cautela, idealmente después de un
   período en `shadow` sobre esa misma plantilla para comparar contra
   Legacy sin sorpresas (ver Hallazgo #5/#9 arriba). Al día de hoy
   nunca se corrió `shadow` contra datos reales de producción.

## Cómo correr todo localmente

```
cd BackHorasExtras
npm install
npm test              # usa la base de test local (ver .env), 513+ tests
node horasdedica.js   # levanta el backend en localhost:3000

cd horas-dedica-angular
npm install
npm run build          # build de producción
npm run deploy:preview # publica a un canal de Firebase preview (no toca el sitio real)
npm run deploy:live    # publica al sitio real -- usar con cuidado
```
