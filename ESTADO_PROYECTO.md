# Estado del proyecto — Motor de reglas de asistencia configurable

Última actualización: 2026-09-18

Este documento es para cualquier programador (yo mismo en el futuro, u
otra persona) que retome este trabajo. Resume qué se hizo, por qué, qué
quedó funcionando, y qué falta.

## Repos y deploys

- **Backend**: `BackHorasExtras` (GitHub: `Vicentetw/BackHorasExtras`), rama `main`. Deploy: Render (`https://academypruebadep.onrender.com`), auto-deploy al pushear a `main`. Base de datos: MySQL en Clever Cloud (credenciales en `.env` de producción del servicio en Render; hay una copia de solo-lectura en `motor-laboral/.env` de este repo, pensada solo para verificaciones puntuales, **nunca** para correr tests contra ella).
- **Frontend**: `horas-dedica-angular` (GitHub: `Vicentetw/horas-dedica-angular`), rama `main`. Deploy: Firebase Hosting, proyecto `horasdedicacionavp`, sitio real `https://horasdedicacionavp.web.app`. El deploy **no es automático** — hay que correr `npm run deploy:live` a mano después de cada push a `main`.
- **Base de test local** (para desarrollo/tests, NO es producción): MySQL en `localhost:3307`, base `horas_dedica2`, user `root`, password `0113333`. El `.env` en la raíz de `BackHorasExtras` apunta ahí.

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
```

**Ya corridas en producción** (confirmado por el usuario el 2026-09-18).
Para correr una migración nueva contra producción: pestaña **Actions**
del repo → workflow "Correr migracion SQL en produccion (manual)" →
`migration_files` con el/los archivo(s), separados por coma. Nadie
(ni el asistente de IA) tiene acceso directo a escribir en la base de
producción por fuera de ese workflow — es una restricción de entorno
intencional.

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

Backend: **513/513 tests** al momento del merge (1 flake preexistente
de MercadoPago, no relacionado a nada de esto — ver
`test/billing-client-panel.test.js`, llama a la API real de MercadoPago
y a veces esa llamada externa falla en este entorno).

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

## Trabajo pendiente (backlog, ninguno arrancado)

1. **Resolver el problema de lentitud de arriba.**
2. **Plan "Camino al 100%"** (guardado en
   `C:\Users\EURO\.claude\plans\staged-sauteeing-starfish.md` en la
   máquina del desarrollador que usó Claude Code — si no se tiene
   acceso a ese archivo, esto resume lo que falta):
   - **Fase 2**: reescribir ~31 tests que hoy dependen de datos reales
     de producción, para que el CI corra 100% en una base nueva/limpia.
   - **Fase 3**: activar branch protection en ambos repos (nadie
     pushea directo a `main` sin pasar por PR + CI en verde) — esto lo
     puede activar el usuario mismo desde GitHub, no requiere código.
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
