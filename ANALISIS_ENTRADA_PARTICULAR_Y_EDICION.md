# Entrada particular a media jornada y edición de fichajes — análisis (2026-10-29)

Solo análisis: **nada aprobado ni publicado.** El cambio de la regla A está
escrito en local, sin commit (`movementsCalculations.js` + 3 tests); se
deshace con `git checkout` si no se aprueba.

## 1. El problema

Caso real: SANTI, legajo 2616, 01/10/2026.

| Hora | Qué fichó |
|---|---|
| 06:54 | dedo (entrada) |
| 12:04 | 6 + dedo (salida particular) |
| 12:05 | 5 + dedo (regreso) |
| 12:09 | 5 + dedo, **sin haber salido** |
| 15:06 | 5 + dedo, y a los 10 s 9 + dedo (inicio de horas extra) |

Salidas mostró **tres** salidas: la real (1 min) y dos "desde las 07:00"
(5 h y 8 h). Esas dos salen de la regla "entrada particular": un 5 sin un 6
antes se toma como "llegó tarde con permiso" y la salida se arma desde el
horario de entrada.

**No lo rompió un cambio reciente.** Se corrieron las 6 versiones del cálculo
desde el 02/09/2026 sobre ese día: todas dan lo mismo. La regla nunca miró si
la persona ya estaba trabajando.

**Cuánto pasa (AVP, ene–oct 2026, copia local):**

| Entradas particulares | Cantidad |
|---|---|
| El 5 es su primer fichaje del día (llegada real) | 613 |
| El 5 llega cuando ya había fichado ese día | **113** |

## 2. Por qué es un error para cualquier empresa, no solo para AVP

La salida inventada dice "estuvo afuera de 07:00 a 12:09", pero la persona
**fichó a las 06:54**: el sistema afirma que estuvo afuera mientras tiene un
fichaje que prueba que estaba adentro. Es una contradicción con los datos,
igual que la regla ya existente "nadie tiene una salida antes de haber
llegado". Por eso la corrección puede ir en el código para todas las empresas
y no hace falta una opción por empresa: ninguna empresa quiere que un fichaje
de presencia cuente como ausencia.

Cómo afecta a otras empresas:
- **Sin marcadores:** no cambia nada (la regla nunca se activa).
- **Con marcadores y bien usados:** no cambia nada (el 5 a media jornada
  siempre viene después de un 6).
- **Con teclas apretadas de más:** dejan de generarse salidas falsas.

## 3. Opciones para la regla automática

| Opción | Qué hace | Santi 01/10 | Opinión |
|---|---|---|---|
| **A1 — solo al llegar** (escrita en local) | La entrada particular vale si el 5 es su primer fichaje del día o está dentro de los 2 min siguientes. Si no, el 5 se consume y no genera salida | queda solo 12:04–12:05 | **Recomendada.** Simple, explicable, sin contradicciones |
| A2 — salida desde su fichaje anterior | El 5 suelto cierra una salida que empieza en su fichaje anterior | 12:05→12:09 (4 min) y 12:09→15:06 (**3 h falsas**) | Mala: inventa otra cosa |
| A3 — no cuenta, pero queda "a revisar" | Igual que A1, y además avisa | igual que A1 | Es A1 + C (abajo) |
| A4 — opción por empresa | Cada empresa elige | — | No hace falta (punto 2); sumaría una opción que nadie entendería |

Detalles de A1:
- Solo para salida **particular**. Oficial y Campaña no se tocan: pueden
  durar días, y un regreso a media jornada puede cerrar una salida de días
  anteriores.
- La ventana de "llegada" de 2 min es la que ya se usa para las horas extra
  al llegar (`VENTANA_LLEGADA_HE_MS`). Cubre a quien pone el dedo y enseguida
  se acuerda del 5.
- Se aplica en el único lugar donde se detectan las salidas
  (`detectMovements`), así que Salidas, resumen, calendario, portal,
  autorización de entradas y Fichajes de la persona dan lo mismo (una sola
  verdad).
- **Riesgo:** quien realmente salió sin apretar el 6 y volvió con el 5
  pierde esa salida. Hoy tampoco queda bien, porque se cuenta desde las
  07:00 (dato falso). Con A1 no se suma nada falso; si hace falta, se carga.

**B — llegó con el 5 pero antes de su horario de entrada.** No llegó tarde,
así que tampoco debería contar. Hoy Salidas la muestra con "—" y sin
duración, pero el calendario y la autorización de entradas sí la cuentan.
Necesita el horario de la persona, que `detectMovements` no conoce: habría
que aplicarlo en una función común a las 4 pantallas para que no diverjan.
**Medir antes de proponerla.**

**Medición (2026-10-30, copia de AVP, enero–octubre, ya con A1):** de 2526
salidas particulares, 617 son entradas particulares. **Ninguna** llegó antes
de su horario: 616 llegaron tarde y se cuentan desde la entrada del horario
(5 min a 4 h; la más larga, 9347 el 13/03, un único fichaje a las 20:08 con el
5). La que queda no tiene jornada en su horario ese día (5010, 24/05).
Conclusión: en AVP la B no cambia ningún número. Queda como regla universal
para otras empresas (que Presentismo y la autorización de entradas no cuenten
lo que Salidas ya muestra sin duración); se hace solo si el dueño lo aprueba.

**Clasificación de las 616 (2026-10-30)**, para ver usos raros del 5 (el dueño
sospecha serenos mal fichados o "devolución de horas" con el mismo marcador):
- Turno de noche (serenos): **0**.
- Llegó **después del fin de su horario**: **1** (9347, 13/03, horario
  07–14, llega 20:08). Hoy suma una salida de 13 h que no existe.
- Llegó pasada la mitad del turno (10:30–11:24): 6. Parecen permisos reales.
- Sin plantilla propia (se usa el horario de la empresa): 12, 10 de ellas de
  1409. El cálculo depende de un horario supuesto.
- Primer fichaje **después de una salida oficial sin regreso**: 20 (16
  personas, 34 h). Casi todas son "oficial a las 12, al día siguiente entra
  tarde con el 5", que puede ser real. 9347 es el caso claro: oficial el
  09/03, nada hasta el 13/03 a las 20:08 con el 5 (volvió de la comisión con
  el marcador equivocado). No se puede corregir solo sin adivinar.

**C — que se vea.** En Fichajes de la persona, ese 5 dejaría de tener
etiqueta. Mejor mostrarlo como "Regreso sin salida: no cuenta (ya estaba
trabajando)", para que el encargado entienda por qué no aparece.

## 4. Editar u omitir un fichaje, con quién y cuándo

### Qué existe hoy

| Herramienta | Qué hace | Rastro |
|---|---|---|
| Corregir marcador (Salidas, columna Marcador) | El marcador era de otra persona, o "no era de nadie" | motivo, quién, cuándo, historial |
| Cargas a mano (`ManualEntries`) | Agregar horas extra, licencia, "omitir horas extra del día" | quién y cuándo |
| Omitir horas extra de un día | El día no suma horas extra | sí |

**Falta:** decir "este fichaje de la persona no vale". Ejemplos: un dedo
repetido que el sistema toma como salida, o un fichaje de prueba.

### Cómo lo hacen otros sistemas

Lo habitual es no borrar nunca el fichaje original del reloj. Se agrega una
corrección encima, con quién, cuándo y por qué, que se puede deshacer, y en
pantalla el fichaje se ve tachado o marcado como "editado". Así el registro
sigue sirviendo como prueba ante un reclamo, porque se ve qué marcó el reloj y
qué decidió la empresa.

### Diseño propuesto ("Omitir fichaje")

1. **Nunca tocar `Checkins`.** Es lo que manda el reloj: una
   resincronización lo volvería a traer y se pierde la prueba. La corrección
   va en una tabla aparte, por ejemplo `fichajes_ajustes`:
   - columnas: `tenant_id`, legajo, hora exacta, reloj, motivo (obligatorio),
     quién, cuándo, deshecho por y cuándo;
   - un ajuste por fichaje.
2. **Se aplica en un solo lugar:** la lectura de fichajes que usan todas las
   pantallas. Si hoy hay más de una lectura, primero unificarlas. Es el mayor
   riesgo: si una pantalla lo aplica y otra no, vuelven los "dos números
   distintos". Lleva un test "una sola verdad" que compare Presentismo,
   Salidas, Liquidación y portal con un fichaje omitido.
3. **Trampa de marcadores:** un fichaje omitido igual tiene que "consumir" el
   marcador que tenía delante. Si no, ese marcador pasaría al fichaje
   siguiente de **otra persona** y le cambiaría el resultado (está en
   `MARCADORES_Y_SALIDAS.md`). O sea: se omite el **efecto** del fichaje, no
   su paso por el reloj.
4. **Qué afecta:** omitido, el fichaje no cuenta para la entrada/salida del
   día, las salidas ni las horas extra. Se ve tachado: "Omitido por X el
   29/10 — motivo — Deshacer".
5. **Mes cerrado en Liquidación:** omitir un fichaje de un mes cerrado no
   cambia la foto del cierre; la diferencia sale como ajuste del mes
   siguiente, con el mecanismo que ya existe.
6. **Permisos y alcance:**
   - permiso "Presentismo: Editar";
   - un supervisor por áreas solo omite fichajes de su gente;
   - queda en el registro de actividad.
7. **Portal del empleado:** ve su fichaje tachado con "omitido por la
   empresa" y el motivo. Es más transparente y evita reclamos.
8. **Migración:** el dueño la corre a mano. Sin la migración, el botón no
   aparece y todo sigue igual.
9. **Escala (5000 empleados):** los ajustes del período se leen en una sola
   consulta y se aplican en memoria, no fichaje por fichaje.

**¿Reemplaza a la regla A?** No, se complementan. La regla automática evita
los 113 casos al año sin que nadie tenga que hacer nada; la edición queda para
lo raro que ninguna regla prevé. Sin la regla, el encargado corregiría a mano
unas 11 salidas por mes, que es justo lo que el dueño no quiere ("no quiero
que me estén llamando por esos errores").

### ¿Y si alguien engaña al reloj a propósito? (pregunta del dueño, 2026-10-30)

El día de Santi 01/10, completo:

| Hora | Marcador | Hoy |
|---|---|---|
| 06:54 | — | llegada |
| 12:04 | 6 | salida particular |
| 12:05 | 5 | regreso (salida de 1 min) |
| 12:09 | 5 | no cuenta (tachado) |
| 15:06 | 5 | no cuenta (tachado) |
| 15:06 | 9 | inicio de horas extra |
| 17:40 | 10 | fin de horas extra |

Hay dos lecturas posibles y el reloj no alcanza para elegir:
- **Error:** apretó el 5 de más. La salida real es de 1 min (lo que cuenta hoy).
- **Picardía:** volvió a las 12:05, se fue sin marcador y volvió a las 15:06
  con el 5. La salida real sería de **3 h** (12:05→15:06), y hoy queda en 1 min.

Ninguna regla automática puede saber cuál fue. Inventar 3 h castiga a quien
se equivocó; descartarlo premia a quien engaña. Además, quien quiera
engañar puede directamente no apretar ningún marcador: eso ya pasaba antes
de A1, y ninguna regla de marcadores lo detecta.

**Propuesta: nada se pierde en silencio, y el encargado decide en un clic.**
1. **Lista "Para revisar"** (en Salidas, por mes): cada 5 descartado por A1
   (~110 al año en AVP, unos 9 por mes), cada 5 después del fin del horario,
   y cada 5 que es el primer fichaje después de una salida oficial abierta.
2. **Acciones**, todas con quién, cuándo, motivo y "Deshacer":
   - **No cuenta** (confirmar el descarte). Sale de la lista.
   - **Contar como salida desde el fichaje anterior** (Santi: 12:05→15:06) o
     desde una hora que elige el encargado.
   - **Corregir marcador** (ya existe: era de otra persona / de nadie).
   - **Omitir fichaje** (diseño de arriba).
3. Las decisiones se guardan en una tabla de ajustes (no se toca `Checkins`)
   y se aplican en el único lugar del cálculo, así Salidas, Presentismo,
   Liquidación y portal dan lo mismo. Lleva migración, y sin ella todo sigue
   como hoy.
4. **Opcional, por empresa:** qué hace el sistema solo con un 5 en el medio
   sin 6: "no cuenta, a revisar" (lo de hoy, por defecto) o "salida desde el
   fichaje anterior". Una empresa estricta elige la segunda.

**Varias salidas particulares el mismo día:** ya funcionan. Cada 6 abre una
salida y el 5 siguiente la cierra. En la copia de AVP hay 4 días con 2
salidas completas (ej. 2530 el 03/02: 07:44–08:22 y 10:02–10:16). Falta un
test que lo fije.

## 4 bis. Plan propuesto (2026-10-30, "ningún fichaje debe quedar escondido")

Principio aprobado por el dueño: lo que una regla descarta se ve tachado, con
motivo, y va a "Para revisar". Nada desaparece en silencio.

| Letra | Qué | Cambia números | Migración |
|---|---|---|---|
| **A** | 5 al llegar **antes** de su horario: no cuenta en ninguna pantalla, tachado con motivo | no en AVP (0 casos) | no |
| **B** | 5 **después del fin** de su horario: no cuenta, tachado con motivo | AVP: −1 salida (9347, 13 h) | no |
| **C** | Test que fija "dos salidas particulares el mismo día" | no | no |
| **D** | Lista **"Para revisar"** en Salidas, solo lectura: 5 descartados, A, B, 5 después de una oficial abierta; con enlace a Fichajes de la persona y a "Corregir marcador" | no | no |
| **E** | Decisiones del encargado sobre cada caso: No cuenta / Contar desde el fichaje anterior o desde una hora / Omitir fichaje; con quién, cuándo, motivo, deshacer; visible en el portal | solo cuando alguien decide | **sí** (tabla de ajustes) |
| **F** | Opción por empresa: qué hace solo un 5 en el medio sin 6 ("a revisar", por defecto, o "salida desde el fichaje anterior") | no, salvo que la empresa lo cambie | no (va en `app_settings`) |

Cómo se hace A y B: una sola función ("¿esta entrada particular cuenta?")
que recibe el regreso y el horario de la persona y responde cuenta / antes
del horario / después del horario / sin horario. La usan Salidas,
Presentismo, la autorización de entradas y Fichajes de la persona.

Cómo se hace E: tabla nueva de ajustes (nunca se toca `Checkins`), leída en
una consulta por período y aplicada en el mismo lugar que el cálculo, así
todas las pantallas dan lo mismo (test "una sola verdad"). El fichaje omitido
sigue consumiendo su marcador. En un mes cerrado, la decisión sale como
ajuste del mes siguiente. Permiso "Presentismo: Editar"; un supervisor por
áreas solo decide sobre su gente. Sin la migración, los botones no aparecen.

Verificación de cada paso: tests del caso nuevo y de los que ya andaban,
suite completa, antes/después de Salidas ene–oct en la copia y comparación
Salidas = Presentismo = Fichajes de la persona = portal.

## 4 ter. Lo que pasó de verdad con Santi y el plan revisado (2026-10-30)

El dueño averiguó: el ejecutivo autorizó salir a comer. Les dijeron "fichen
salida particular al mediodía y el regreso tipo 15", y los que hicieron horas
extra ficharon el inicio y el fin. O sea, la salida real de Santi fue
**12:04 → 15:06**; los 5 de 12:05 y 12:09 son errores. Ninguna regla podía
saberlo: lo decide el administrador.

Pedidos del dueño:
- No se oculta nada; el administrador decide qué tipo de fichaje fue, con
  quién lo cambió y el motivo (omitir, o cambiar/quitar el marcador).
- **No tocar los motores de cálculo** sin autorización; todo con tests y
  coordinado en todas las pantallas.
- Una salida particular se corta al terminar el horario de la plantilla.
  Medido (copia AVP, ene–oct): **59 de 2494** salidas pasan el fin del
  horario, 34 personas, **93 h de más**. Es un cambio de cálculo: va aparte
  y con aprobación.

Idea clave: las correcciones se aplican a lo que **entra** al motor (los
fichajes y sus marcadores), no al motor. Ya funciona así "Corregir marcador".
Para Santi: el administrador marca los 5 de 12:05 y 12:09 como "marcador
apretado por error", y el motor, sin cambios, arma solo 12:04 → 15:06.
Omitir un fichaje también anula su marcador (si no, el marcador pasaría al
fichaje de otra persona).

| Letra | Qué | Toca el motor | Migración |
|---|---|---|---|
| **G** | Tabla de correcciones de fichajes: omitir / cambiar o quitar el marcador; motivo obligatorio, quién, cuándo, deshacer. Se aplica en la lectura común de fichajes, así todas las pantallas dan lo mismo | no | sí |
| **H** | En Fichajes de la persona (se abre desde Presentismo y Salidas): todos los fichajes a la vista y botón "Corregir" en cada uno; se ve "corregido por X, fecha, motivo" | no | — |
| **I** | Pantalla "Fichajes del reloj" (en crudo): todos los fichajes y marcadores de la empresa por día, incluidos los que no son de nadie; mismas correcciones. Solo con un permiso nuevo para el administrador y jefe de personal | no | — |
| **J** | Lista "Para revisar" (antes D) | no | no |
| **K** | Cortar la salida particular al fin del horario (59 salidas, 93 h) | **sí** | no |

A y B quedan en espera: con G el administrador corrige esos casos sin tocar
el motor.

### Definición del dueño (2026-10-30)

1. Pantalla central **"Fichajes del reloj"**.
2. Solo el administrador de la empresa y el jefe/encargado de personal
   expresamente autorizado (permiso nuevo, que no tienen los supervisores
   por áreas salvo que se lo den).
3. Todos los registros originales, sin ocultar ninguno, incluidos los
   números del reloj sin persona asociada.
4. Acciones: omitir fichaje, cambiar marcador, quitar marcador, restaurar
   original, ver historial. Cambiar el marcador cambia la interpretación;
   omitir quita el efecto laboral.
5. Motivo obligatorio; quién y cuándo en cada cambio. Las correcciones nunca
   se borran: se marcan como deshechas.
6. La misma corrección se abre desde Presentismo y Salidas (mismo diálogo,
   mismo mecanismo), sin duplicar.
7. **No se puede cambiar la fecha ni la hora** de un fichaje: el reloj es la
   prueba.
8. Corregir no modifica `Checkins`: es una interpretación administrativa que
   todo el sistema respeta.

Cómo se respeta "sin tocar el motor": las correcciones se traducen a la
entrada que el motor ya entiende.
- Quitar marcador = el marcador que se llevó ese fichaje queda "no era de
  nadie" (mecanismo que ya existe).
- Cambiar marcador = lo anterior + un marcador elegido entre los
  configurados por la empresa, puesto justo antes de ese fichaje y marcado
  como corregido.
- Omitir = el fichaje no entra al cálculo y su marcador queda "de nadie"
  (si no, pasaría al fichaje de otra persona).

Cuidados:
- Números sin persona: mostrar si es un marcador configurado o un número
  desconocido; "asignarlo a una persona" se resuelve con la pantalla de
  vinculación que ya existe, no con otra.
- Escala: período acotado y paginado en el servidor; filtros primero
  fecha, persona, reloj, sin persona, corregidos/omitidos; el resto después.
- Mes cerrado: la corrección sale como ajuste del mes siguiente.
- Un fichaje que falta (se olvidó de fichar) no se arregla acá: sería un
  "fichaje cargado a mano", claramente distinto. Se analiza aparte.

## 4 quater. Investigación previa a la etapa G (2026-10-30, aprobado G+H+I)

**Punto 8 — ¿omitir un fichaje le pasa su marcador a otra persona?** Prueba
sobre la copia de AVP, octubre (1 al 28): se omitió de a uno cada fichaje que
se llevaba un marcador (2444) más 100 al azar, y se comparó el resultado de
TODAS las demás personas del día contra el cálculo sin omitir. El motor no se
tocó. El script está en el scratchpad de la sesión (`prueba_omitir.js`).

| Forma de omitir | A otra persona le cambia el resultado |
|---|---|
| (a) Sacar el fichaje de la lista | **358 de 2544** (14 %): su marcador pasa al siguiente |
| (b) Sacarlo y dejar su marcador "de nadie" (corrección existente) | 19 (0,7 %) |
| (c) Dejarlo en el reloj a nombre de "nadie" (se lleva lo mismo que antes) | **11 (0,4 %)** |

Los 11 de (c) son todos iguales: se omitió el **primer fichaje del día**. Sin
él, el motor toma como llegada el siguiente fichaje de la persona (ej. 13:41
con el 9), le aplica la regla "mientras está llegando" de horas extra, la
persona ya no se lleva ese 9 y el 9 pasa al que fichó detrás (le queda una
hora extra de segundos). No es el marcador del fichaje omitido: es el motor
releyendo el resto del día de esa persona. Llegar a 0 sin tocar el motor no se
puede garantizar. Propuesta: **vista previa obligatoria** (ver abajo).

**Santi 01/10 con la herramienta:**
- Quitar el marcador de 12:05 y 12:09 **no alcanza**: para el motor, cualquier
  fichaje propio cierra la salida abierta, tenga marcador o no. Sigue 12:04→12:05.
- **Omitir** 12:05 y 12:09 da **12:04 → 15:06**, y nadie más cambia.

**Punto 9 — meses cerrados (comprobado en `routes/liquidacionHorasExtra.js`):**
solo Liquidación de horas extra tiene cierre. Al cerrar se guarda una foto
(`overtime_period_results`). Un mes cerrado se puede seguir corrigiendo: la
diferencia (hoy menos lo pagado) se paga como ajuste al cerrar el mes
siguiente, pero **solo se revisan los 3 meses anteriores** (`MESES_AJUSTE`).
Una corrección en un mes cerrado más viejo nunca se pagaría. Presentismo,
Salidas y portal no tienen cierre: muestran el cálculo en vivo.

**Quién lee `Checkins`** (además de matching, diagnósticos y conteos):
- `attendanceRangeHandler` (2 consultas): Presentismo, calendario,
  Liquidación, portal (`/api/mi`), configuración y revisión de horas extra,
  Fichajes de la persona.
- `campanaService.fetchMovementCheckins`: Salidas, Campaña, autorización de
  entradas, fichajes del día, validación de "Corregir marcador".
- `/attendance/:date` y `checkinRepository.findByDate` (motor diario).
- `fichajesDelDia` (choque de horas extra cargadas a mano con fichajes).
- Cupos de motivos (días fichados), licencias largas (último fichaje),
  lista de empleados (último fichaje).
- Ya existen fichajes cargados a mano (`Checkins.source = 'manual'`,
  `/api/manual-checkins`).

## 5. Orden recomendado

| Paso | Qué | Cambia lo publicado | Migración |
|---|---|---|---|
| 1 | **A1 + C**: regla "solo al llegar" y mostrar el 5 como "no cuenta" | sí: ~113 salidas falsas menos en el año | no |
| 2 | Medir **B** (llegó con el 5 antes de su horario) y decidir | — | no |
| 3 | **Omitir fichaje** con rastro (punto 4) | no: es nuevo | sí |

Verificación del paso 1, antes de publicar:
- tests: Santi, llegada tarde real, llegada con el 5 dentro de los 2 min,
  Oficial sin cambio;
- suite completa;
- antes/después de Salidas ene–oct sobre la copia, con la lista de quiénes
  cambian;
- comparar Salidas, calendario y portal para Santi y dos casos más.
