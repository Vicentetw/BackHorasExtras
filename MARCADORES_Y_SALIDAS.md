# Marcadores, salidas y horas extra — cómo funciona y qué NO romper

> **Para cualquier sesión (persona o IA) que vaya a tocar Presentismo,
> Salidas, horas extra, campaña o el portal del empleado: leer esto entero
> antes de cambiar código.** Resume errores reales que ya cometimos, con
> datos de producción, para no repetirlos.

---

## 1. Qué es un marcador

Un **marcador** es un usuario especial del reloj biométrico. No es una persona,
es una **orden**: el empleado aprieta el número del marcador en el reloj y
**después** pone su propio dedo. El sistema une las dos cosas: "el próximo
fichaje después del marcador es una salida particular (o una hora extra, o
una campaña)".

Están en la tabla `specialusers` (categoría + dirección). En AVP:

| Número | Significa |
|---|---|
| 5 | Particular — REGRESO |
| 6 | Particular — SALIDA |
| 3 / 4 | Oficial — REGRESO / SALIDA |
| 7 / 8 | Campaña — REGRESO / SALIDA |
| 9 / 2 | Hora extra — inicio / fin |

**El punto clave:** el marcador **no dice de quién es**. Nadie se identifica
al apretarlo. El sistema se lo asigna al **siguiente fichaje real**, sea de
quien sea. Todo lo demás de este documento sale de ahí.

## 2. Un solo motor, una sola verdad

La detección la hace **una sola función**: `detectMovements` en
`motor-laboral/services/movementsCalculations.js`. La usan:

| Pantalla | Endpoint | Para qué |
|---|---|---|
| Salidas | `GET /movements-range` | Lista de salidas (es la referencia) |
| Presentismo, resumen mensual | `GET /attendance-range` (sin `employeeId`) | Horas extra por marcador de cada empleado |
| Presentismo, detalle de un empleado (calendario) | `GET /attendance-range?employeeId=…` | Días con salida particular (`hasParticularExit`) y horas extra |
| Portal del empleado | `routes/miPortal.js` | Lo que ve el empleado |

**Regla de oro: las cuatro tienen que dar EXACTAMENTE lo mismo para la misma
persona y el mismo día.** Si una pantalla muestra una salida o una hora extra
que otra no muestra, hay un error, aunque cada una "parezca" bien sola.

## 3. Las reglas que NO se pueden romper

### Regla 1 — La detección necesita los fichajes de TODA la empresa

Como el marcador se lo lleva el siguiente fichaje de **cualquiera**,
`detectMovements` tiene que recibir **todos** los fichajes del período, no
solo los de la persona que se está mirando.

**Error real (corregido el 2026-10-05, commit `1b49b13`):** para que el
detalle de una persona cargara rápido, `/attendance-range?employeeId=…` traía
solo los fichajes de esa persona más los de los marcadores. Si otra persona
fichaba entre el marcador y la persona del detalle, para el detalle "no
existía", y el marcador se le asignaba a quien se estaba mirando.

Consecuencias medidas en la copia de producción:
- el calendario mostraba salidas particulares que Salidas no mostraba
  (ej. legajo 2542, 01/04/2026);
- **las horas extra del detalle no coincidían con las del resumen** en 13
  empleados en abril y 11 en agosto de 2026 (ej. legajo 2329: 30,00 h en el
  resumen, 34,03 h en el detalle).

Cómo quedó: en `horasdedica.js`, dentro de `/attendance-range`, la variable
`checkinsParaDeteccion`. En modo detalle trae, con una consulta liviana (hora,
número y reloj), todos los fichajes de la empresa del período **solo para la
detección**. El cálculo de asistencia de la persona sigue usando solo sus
fichajes (esa optimización es correcta y se mantiene).

**Atajos que se probaron y NO sirven (no volver a intentarlos):**
- Traer solo los fichajes ajenos dentro de la tolerancia de cada marcador:
  quedaban 7 diferencias por mes.
- Un JOIN de `Checkins` contra sí misma por rango de tiempo: 30-45 segundos,
  MySQL no usa el índice cuando el rango depende de otra fila.

**Si alguna vez hay que optimizar `/attendance-range` o cualquier consulta
que alimente a `detectMovements`: NUNCA filtrar los fichajes de otras
personas antes de la detección.**

### Regla 2 — Nadie tiene una salida antes de haber llegado (regla AVILA)

Si un marcador de salida se pega al **primer fichaje del día** de una persona,
eso es su **llegada**, no una salida. Se descarta, lo haya apretado otra
persona o ella misma por error. Función:
`filterEventsOpenedByFirstCheckinOfDay`.

Caso real: AVILA Natalia, legajo 9006.

| Día | Marcador 6 | Su primer fichaje |
|---|---|---|
| 08/04/2026 | 07:22:57 | 07:23:05 (8 s) |
| 14/04/2026 | 07:23:19 | 07:23:26 (7 s) |

Se aplica a las salidas completas **y** a las salidas sin regreso, en
Salidas **y** en el calendario.

### Regla 3 — Tres tipos de salida particular, todos cuentan

| Tipo | Ejemplo | Cómo se llama en el código |
|---|---|---|
| Completa | sale con el 6, vuelve con el 5 | `closedEvents` |
| Sin regreso | sale con el 6 y no vuelve; se cierra con el fin del horario ("Sin regreso — fin de horario") | `openEvents` + `closeOpenEventsAtScheduleExit` |
| Entrada particular | llega con el 5 sin haber salido (la autorizaron el día anterior) | `orphanReturns` |

Hasta el 2026-10-05 el calendario solo contaba la primera (caso real:
PERROTTA, legajo 2525, 29/09/2026, salida a las 10:15 sin regreso). Decisión
del dueño: las tres son salida particular; el encargado revisa en Salidas si
estaba autorizada.

### Regla 4 — La tolerancia en segundos NO separa marcadores ajenos

`markerMaxGapSeconds` (en `app_settings`; hoy **25 s** en AVP) es cuánto
puede pasar entre el marcador y el dedo. Parece tentador bajarla para
"filtrar marcadores de otra persona". **No sirve.** Medido con 8.423
marcadores desde junio de 2026:

| Demora marcador → dedo | Marcadores |
|---|---|
| 0 a 6 s | 6.366 (76 %) |
| 7 a 10 s | 601 |
| 11 a 15 s | 410 |
| 16 a 25 s | 226 |

Los casos de AVILA (7 y 8 s) están en el rango normal: con tiempo no se
distinguen. Bajarla a 10 s haría perder 636 marcadores legítimos; a 6 s, más
de mil. Lo que protege son las reglas 1, 2 y 5.

### Regla 5 — Un marcador solo lo consume un fichaje del mismo reloj

Desde el 2026-09-23, cada reloj tiene su propia cola de marcador pendiente
(`MACHINE_IP`). Un marcador apretado en el reloj `.33` no lo puede consumir
alguien que fichó en el `.30`. Los fichajes viejos sin reloj guardado no se
pueden comparar y siguen la regla anterior. Detalle y datos:
`ANALISIS_MARCADORES_MULTIRELOJ.md`.

### Otras protecciones que ya existen (no duplicarlas)

- **Rebote** (`ownCheckinBounceMs`, 20 s): si la misma persona ficha dos veces
  seguidas, el segundo fichaje no consume otro marcador.
- **Marcadores corregidos a mano** (`POST /marker-corrections`): valen igual
  en todas las pantallas.

## 4. Cómo verificar que no se rompió nada

Un test aislado no alcanza: los errores de arriba pasaban todos los tests y
aparecieron recién al **comparar pantallas entre sí con datos reales**.

1. **Tests**: `test/attendance-range-particular-exit.test.js` cubre los tres
   tipos de salida, la regla AVILA y el marcador que se lleva otra persona.
   `test/marcadores-mismo-reloj.test.js` cubre los relojes.
2. **Comparación con la copia de producción** (`horas_prod_copia` en el MySQL
   de Docker; nunca contra producción):
   - levantar un segundo backend contra la copia:
     `MYSQL_ADDON_DB=horas_prod_copia PORT=3001 RATE_LIMIT_REPORTES_POR_MINUTO=100000 node horasdedica.js`;
   - para un mes completo, pedir `/attendance-range?employeeId=X` de **cada**
     empleado y comparar:
     - días con `hasParticularExit` contra las filas de
       `/movements-range?category=PARTICULAR` → tienen que ser **iguales**;
     - `overtimeHours` del detalle contra el del resumen
       (`/attendance-range` sin `employeeId`) → tienen que ser **iguales**.
   - Resultado esperado: 0 diferencias. Así se verificó el 2026-10-05
     (abril: 271 = 271 días; agosto: 281 = 281; horas extra: 0 diferencias).
3. Medir el tiempo del detalle de una persona (mes y año) antes y después.
   Referencia 2026-10-05: ~450 ms un mes, ~1,4 s nueve meses.

## 5. Pendiente de decisión (2026-10-06): doble lectura y serenos

Caso real: AGUILAR, legajo 3056, sábado 03/10/2026, turno de 15 a 23.
Apretó el 9 (inicio HE) a las 14:54:57, puso el dedo a las 14:54:59 **y otra
vez** a las 14:55:02 (el lector lo leyó dos veces). La segunda lectura cerró
lo que la primera abrió: quedó "HE de 14:54 a 14:55". A la salida apretó el 10
y fichó dos veces más (23:02:52 y 23:02:55).

- La solución técnica de la doble lectura ya existe (`reboteRefinado` en
  `movementsCalculations.js`) pero está **activada solo para Campaña**.
  Medido sobre la copia de producción, activarla para horas extra sumaría
  +1.060 h en enero-septiembre 2026 (+5,6 %, 495 empleado-mes). **No está
  verificado caso por caso que esas horas sean reales** y cambia
  liquidaciones: no activarla sin revisar casos y sin aprobación del dueño.
- El dueño aclaró que el sereno usa el 9 y el 10 **para indicar que entra y
  sale**, igual que los demás marcan inicio y fin de hora extra. Si su turno
  asignado es de 15 a 23, ¿esas horas son extra o normales? Es una regla de
  negocio de AVP: tiene que resolverse como **configuración por empresa**
  (ver el principio en `CLAUDE.md`), no con un caso especial en el código.
- Además: en la medición de demoras de la regla 4 quedó afuera la tecla 10
  (en `specialusers` figura con `userId` 2 y `badgeNumber` 10; el reloj la
  registra como USERID 10). Rehacer la tabla cruzando por `badgeNumber`.

## 6. Antes de cambiar algo de esto, preguntarse

- ¿Cambia **qué fichajes** recibe `detectMovements`? → Regla 1.
- ¿Una pantalla va a calcular algo "a su manera" en vez de usar el mismo
  motor y los mismos filtros? → Regla de oro (sección 2).
- ¿Se quiere "arreglar" un marcador mal atribuido bajando segundos? → Regla 4.
- ¿Cambia lo que ya ven los clientes? → listarlo con letras y pedir
  aprobación al dueño antes (regla de trabajo del proyecto).
