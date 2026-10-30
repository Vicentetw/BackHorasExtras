# Correcciones de fichajes — diseño de la etapa G (2026-10-30)

Estado: **G implementada en LOCAL (2026-10-30), sin commit, sin publicar,
migración corrida solo en la base local.** Diseño aprobado (versión 2) con
L1 aprobada; L2 espera autorización (ver sección 12). Lo que cambió al
implementar está en la sección 12. Aprobado por el dueño
avanzar con G (solo local, sin commits ni migraciones en producción). Origen
y mediciones: `ANALISIS_ENTRADA_PARTICULAR_Y_EDICION.md` (secciones 4 ter y
4 quater).

## Idea en una frase

Corregir un fichaje **no modifica lo que mandó el reloj**: se guarda una
*interpretación administrativa* aparte (quién, cuándo, por qué), y todo el
sistema la respeta porque se aplica en el único momento en que se leen los
fichajes, **antes** de que lleguen a los motores. Los motores no cambian.

## 1. Cómo se identifica un fichaje

`Checkins` tiene clave primaria `id` (autoincremental) y además una clave
única `(tenant_id, USERID, CHECKTIME)`.

- El `id` es estable: la sincronización del reloj inserta con
  `INSERT IGNORE` (`checkinsIngestService.js`), nunca reescribe una fila que
  ya existe. Solo cambia si alguien borra y vuelve a importar (borrado total
  del superadmin o un fichaje manual borrado).
- Por eso la corrección apunta al **`id`** y guarda además una **copia de
  control** (USERID, hora, reloj). Al aplicarla se exige que coincidan las
  dos cosas. Si no coinciden (el fichaje fue borrado o reimportado), la
  corrección **no se aplica** y queda marcada como "huérfana" para revisar.
  Nunca se aplica a un fichaje distinto del que vio el administrador.
- Solo se corrigen **fichajes de personas**. Las lecturas de un marcador (el
  5, el 6…) se corrigen con la herramienta que ya existe ("Corregir
  marcador", tabla `marker_corrections`).

## 2. Tabla nueva: `fichajes_correcciones`

| Columna | Para qué |
|---|---|
| `id` | |
| `tenant_id` | empresa (aislamiento) |
| `checkin_id` | `Checkins.id` del fichaje corregido |
| `checkin_userid`, `checkin_time`, `checkin_machine_ip` | copia de control (ver punto 1) |
| `employee_id` | legajo de la persona al momento de corregir (para listar y para el alcance por áreas) |
| `accion` | `OMITIR`, `QUITAR_MARCADOR`, `CAMBIAR_MARCADOR` |
| `marcador_user_id` | solo para CAMBIAR: el marcador elegido (de los configurados por la empresa) |
| `motivo` | obligatorio |
| `impacto` | resumen de la vista previa que se confirmó (quién cambia y cuánto) |
| `afecta_a_otros` | si se confirmó sabiendo que cambia a otras personas |
| `created_by`, `created_at` | quién y cuándo |
| `deshecha_por`, `deshecha_at`, `motivo_deshacer` | deshacer (nunca se borra la fila) |
| `activa_checkin_id` | columna calculada: el `checkin_id` si está activa, vacía si se deshizo |

- Clave única `(tenant_id, activa_checkin_id)`: **una sola corrección activa
  por fichaje**. Cambiar una corrección = deshacer la anterior + crear otra.
  El historial queda completo.
- **No hay columnas de fecha u hora nuevas**: no se puede mover un fichaje.
- Migración `migrations/20261027_correcciones_fichajes.sql` (la corre el
  dueño). También da los permisos nuevos al rol de sistema "Administrador de
  Empresa".

## 3. Qué hace cada corrección (sin tocar el motor)

El motor de salidas y horas extra (`detectMovements`) le da cada marcador al
siguiente fichaje del mismo reloj. Por eso **no se puede sacar un fichaje de
la lista sin más**: medido en octubre de AVP, eso le cambia el resultado a
otra persona en el 14 % de los casos (el marcador lo agarra el siguiente).
La corrección se traduce así:

| Acción | Para las horas (entrada, salida, presencia) | Para los marcadores |
|---|---|---|
| **Omitir** | el fichaje no existe | sigue en su reloj, pero a nombre de "nadie": se lleva el mismo marcador que antes, y nadie más lo recibe |
| **Quitar marcador** | sigue contando | el original queda en su reloj a nombre de "nadie" (se lleva su marcador) y la persona ficha a la misma hora en un **carril privado** sin marcadores |
| **Cambiar marcador** | sigue contando | igual que quitar, y en ese carril privado, justo antes del fichaje y **con la misma hora exacta**, está el marcador elegido |

Ojo, comprobado con datos: para el motor, **cualquier fichaje propio cierra
una salida abierta**, tenga marcador o no. Quitar un marcador no "une" dos
salidas; para eso hay que omitir el fichaje (Santi 01/10: omitir 12:05 y
12:09 da 12:04→15:06 sin cambiar a nadie más).

### 3.1 Todo es en memoria (reloj aparte = carril privado)

Nada de esto se escribe en la base. No se crea ni se modifica ninguna fila
de `Checkins`. Cuando un lector trae los fichajes, arma en memoria la lista
que le pasa al motor:

- **"A nombre de nadie"**: la misma lectura, mismo reloj, misma hora, con la
  persona reemplazada por un nombre interno `corr:<id>`, que no es ningún
  empleado. Ninguna pantalla lo muestra (se filtra por prefijo y además no
  existe en la lista de empleados).
- **Carril privado**: la copia de la lectura de la persona lleva como reloj
  el texto interno `corr:<id>@<reloj original>`. El motor arma una cola de
  marcadores por cada reloj distinto; ese texto no coincide con ningún reloj
  real, así que en esa cola no puede entrar ningún marcador de un reloj real,
  y lo que haya en ella no puede salir hacia otro. La copia guarda el reloj
  original (`relojOriginal`) para todo lo que se muestre.
- **Marcador elegido (Cambiar)**: una lectura interna con identificador
  propio `corr:<id>:m` (no el número real del marcador, para que nunca se
  confunda con una lectura real del mismo marcador a la misma hora ni con una
  corrección de `marker_corrections`). Se agrega al mapa de marcadores en
  memoria con la categoría y el sentido del marcador elegido.

### 3.2 La hora nunca cambia (respuesta a "un segundo antes")

La versión anterior ponía el marcador elegido un segundo antes. **Se
descartó**: el marcador elegido lleva **exactamente la hora del fichaje**, y
el orden se logra por posición (se inserta justo antes de la copia). El
ordenamiento de JavaScript es estable: dos lecturas con la misma hora
mantienen el orden en que vinieron. Comprobado en el prototipo (caso 4).

Por qué esa hora no puede alterar nada:
- Las horas trabajadas, la entrada y la salida del día salen solo de los
  fichajes de personas; las lecturas de marcadores nunca entran ahí.
- Las salidas y horas extra miden de fichaje a fichaje (`timeOut`/`timeIn`
  son las horas reales de los fichajes). La hora del marcador solo se usa
  para decidir a qué fichaje le corresponde.
- En pantalla, el marcador figura como "marcador por corrección #N", con la
  hora del fichaje.
- Si el motor no le asigna el marcador elegido al fichaje (puede pasar si la
  persona tiene otra lectura en ese mismo segundo), la vista previa lo
  detecta y **no deja confirmar**.

## 3 bis. Multireloj: cada marcador pertenece a su reloj

Cómo funciona hoy el motor (`movementsCalculations.js`, "Un marcador solo lo
puede consumir un fichaje del MISMO reloj"): una cola de marcadores por reloj;
un marcador solo lo consume un fichaje del mismo reloj. G respeta eso:

1. La lectura corregida **queda en su reloj** (a nombre de nadie): la cola de
   ese reloj ve exactamente la misma secuencia de lecturas que hoy.
2. El carril privado nace del reloj original y no comparte cola con ningún
   reloj real (punto 3.1).
3. **Reloj no identificado → se bloquea.** Hay fichajes viejos sin reloj
   (`MACHINE_IP` vacío): en AVP, 46.203, del 22/08/2025 al 28/05/2026 (más
   de la mitad de enero a mayo; desde junio, ninguno). El motor los trata
   como un "reloj desconocido" que se puede cruzar con cualquiera, por
   compatibilidad. Por eso se bloquea corregir un fichaje sin reloj, **y
   también** uno que tenga, dentro de la ventana de marcadores
   (`markerMaxGapSeconds`) antes o después, alguna lectura sin reloj.
4. La vista previa hace además una **auditoría de relojes**: en el resultado
   con la corrección, cada marcador asignado tiene que venir del mismo reloj
   que su fichaje (o del carril privado de esa misma corrección). Si no, no
   se puede confirmar.

**Contradicción con algo ya publicado (no se toca en G):** la corrección
existente "el marcador era de X" (`marker_corrections`) le reserva el
marcador a X y lo consume el próximo fichaje de X **de cualquier reloj**
(dentro de 10 min). Eso va contra la regla "nunca entre relojes". Cambiarlo
es cambiar algo que funciona en producción: queda como pregunta para el
dueño (ver sección 10).

## 3 ter. Convivencia con "Corregir marcador" (`marker_corrections`)

- **No se pisan**: `marker_corrections` corrige lecturas de **marcadores**
  (filas sin persona); G corrige lecturas de **personas**. Una fila nunca
  tiene las dos. G rechaza corregir una lectura que sea de un marcador.
- **No se aplica dos veces**: una sola corrección G activa por fichaje (clave
  única), y cada mecanismo actúa sobre su propia fila.
- **Caso que choca**: un fichaje de X que se llevó un marcador que alguien
  asignó a mano a X ("era de X"). Omitirlo haría que la reserva pase al
  siguiente fichaje de X; quitarle el marcador no funcionaría (la copia lo
  volvería a tomar). Regla: **se bloquea** con el mensaje "este fichaje tiene
  un marcador asignado a mano el dd/mm por N; deshacé esa corrección primero".
  Se detecta en la vista previa (el motor marca esos casos como
  `corregido`).
- **El caso inverso** (alguien hace "era de X" *después*, y el fichaje de X
  que lo tomaría ya tiene una corrección G): para evitarlo hace falta una
  validación nueva en `POST /marker-corrections`. Cambia una herramienta
  publicada: queda como pregunta (sección 10).
- **Campaña "solo afectados"** (`soloPuedenConsumir`): la lectura a nombre de
  nadie hereda el permiso de la persona original, para que siga llevándose
  el mismo marcador de campaña que antes.

## 3 quater. Orden e identificación: casos probados

Prototipo descartable en el scratchpad (`proto_correcciones.js`), sobre el
`detectMovements` real sin tocar. Los 9 casos dieron bien:

| Caso | Resultado |
|---|---|
| 1. Mismo empleado, misma hora, dos relojes | se corrige solo el fichaje elegido (por `id`) |
| 2. Segundos consecutivos en el mismo reloj | quitar el marcador de A no se lo pasa a B |
| 3. Dos empleados en el mismo reloj | omitir A no cambia a B |
| 4. Marcador y fichaje en el mismo segundo | se respeta el orden en que venían; el marcador elegido se asigna con la hora exacta |
| 5. Correcciones sucesivas | deshacer vuelve exacto; rehacer equivale a hacerla de cero |
| 6. Multireloj: 9 en .33, fichaje en .30 un segundo después | el 9 nunca pasa a .30, con ninguna corrección |
| 7. Multireloj: marcadores simultáneos en dos relojes | corregir uno no toca el otro |
| 8. Fichaje sin reloj | se bloquea |
| 9. Marcador del "reloj desconocido" cerca | sin cambios para otros (y en el sistema, además, se bloquea: punto 3 bis.3) |

Sobre el orden: la base devuelve los fichajes `ORDER BY CHECKTIME`; si dos
tienen el mismo segundo, el orden lo da la base, igual que hoy. G no reordena
nada: reemplaza cada lectura en su misma posición.

Estos 9 casos pasan a ser tests del sistema, más los de datos reales
(sección 8).

## 4. Un solo punto de aplicación

Archivo nuevo `motor-laboral/services/correccionesFichajes.js`:
- `leer(db, tenantId, desde, hasta)`: una consulta por período. Si la tabla
  no existe (migración sin correr), devuelve "sin correcciones" y todo sigue
  exactamente como hoy.
- `aplicar(filas, correcciones)`: devuelve las filas transformadas (punto 3).
- `vistaPrevia(...)`: ver punto 5.

Lectores que lo usan (todos los que calculan):

| Lector | Pantallas |
|---|---|
| `attendanceRangeHandler` (`horasdedica.js`) | Presentismo, calendario, resumen, Liquidación, portal, configuración y revisión de horas extra, Fichajes de la persona |
| `campanaService.fetchMovementCheckins` | Salidas, Campaña, autorización de entradas, fichajes del día |
| `/attendance/:date`, `checkinRepository.findByDate` | cálculo diario |
| `fichajesDelDia` | choque de horas extra cargadas a mano con fichajes |
| `cupoMotivoRepository` | días fichados para los cupos |
| `licenciasLargasRepository`, lista de empleados | último fichaje |

Quedan **en crudo**, a propósito: vinculación de números (matching),
diagnósticos del superadmin y conteos de puesta en marcha (hablan de lo que
recibió el reloj, no de lo que se calcula). `/data` (endpoint viejo): se
verifica si alguna pantalla lo usa; si sí, se aplica.

## 5. Vista previa del impacto (obligatoria)

`POST /api/correcciones-fichajes/vista-previa` con el fichaje y la acción (y
lo mismo para deshacer). El servidor calcula **toda la empresa** para el mes
del fichaje (y el siguiente si hay una salida de varios días que cruza el fin
de mes), **con y sin** la corrección, con el mismo cálculo de siempre, y
compara persona por persona:

- el fichaje y la persona;
- para la persona: horas trabajadas y estado de cada día, salidas por tipo
  (cantidad y minutos), horas extra (reales, computables, a liquidar),
  días de campaña;
- **otras personas afectadas**: quiénes y qué les cambia, con el mismo
  detalle;
- si el mes está cerrado y qué pasa con la liquidación (punto 6).

Confirmación:
- La vista previa devuelve un comprobante firmado por el servidor (vence a
  los 15 min) con el resultado calculado.
- Al confirmar, el servidor **vuelve a calcular**. Si da distinto (llegaron
  fichajes nuevos, otra persona corrigió algo), rechaza y pide ver la vista
  previa de nuevo.
- Si afecta a otras personas: hace falta una **segunda confirmación**
  explícita, y queda guardado en la corrección.
- Si el cálculo falla o no termina, **no se puede confirmar**.

## 6. Meses cerrados (comprobado en `routes/liquidacionHorasExtra.js`)

Solo Liquidación de horas extra tiene cierre: guarda una foto del mes. Si un
mes cerrado cambia después, la diferencia se paga como **ajuste** al cerrar
un mes posterior, pero el informe solo revisa los **3 meses anteriores**
(`MESES_AJUSTE`), y los ajustes necesitan la migración 20261009.

Regla:
- Mes del fichaje abierto: se puede corregir.
- Mes cerrado y la corrección **no cambia** lo liquidado de nadie: se puede.
- Mes cerrado y **sí cambia** lo liquidado: se puede solo si la diferencia va
  a entrar como ajuste (el primer mes abierto posterior está a 3 meses o
  menos y la tabla de ajustes existe). La vista previa dice en qué cierre se
  paga. Si no, **se bloquea** explicando por qué (reabrir el mes, o corregir
  antes). El fichaje original y el historial siguen visibles.

## 7. Permisos y seguridad

- Permisos nuevos: **"Fichajes: ver"** (`fichajes:read`: ver correcciones,
  historial y vista previa) y **"Fichajes: corregir"** (`fichajes:update`:
  corregir y deshacer). Se validan en el servidor.
- La migración se los da **solo** al rol de sistema "Administrador de
  Empresa". El jefe o encargado de personal los recibe solo si el
  administrador se los da. Ningún otro rol (tampoco los supervisores por
  área) los recibe automáticamente.
- Si quien corrige tiene alcance por áreas, solo puede corregir a su gente.
- Todo filtrado por empresa: una empresa nunca ve ni corrige fichajes de otra.
- Cada corrección y cada "deshacer" queda también en el registro de actividad.

## 8. Pruebas de la etapa G

- **Sin correcciones, todo igual:** enero a octubre de AVP en la copia,
  Presentismo (toda la empresa, mes por mes) y Salidas (todas las
  categorías), antes y después del cambio: idénticos.
- Suite completa.
- Santi 01/10: omitir 12:05 y 12:09 → 12:04→15:06; nadie más cambia.
- Los 11 casos de octubre en que omitir le cambia el resultado a otra
  persona: la vista previa los muestra y exige la segunda confirmación.
- Quitar y cambiar marcador: casos de prueba y datos reales.
- Los 9 casos de orden y multireloj (sección 3 quater), más: dos o más
  relojes simultáneos con marcadores y fichajes a segundos, sobre datos
  reales de octubre (.30 y .33), comprobando que ningún marcador cambia de
  reloj; bloqueo por reloj no identificado y por lectura sin reloj cerca;
  bloqueo por marcador asignado a mano; ninguna fila de `Checkins` cambia
  (conteo y suma de control antes y después).
- Las mismas cifras con una corrección activa en Presentismo, Salidas,
  Fichajes de la persona, portal y Liquidación.
- Deshacer devuelve exactamente el resultado original.
- Corrección huérfana (fichaje borrado o reimportado): no se aplica.
- Sin la tabla: todo igual, y los endpoints dicen "falta la migración".
- Aislamiento entre empresas, permisos (sin permiso 403, con alcance por
  áreas solo su gente), mes cerrado (los tres casos del punto 6).

## 9. Riesgos

- Que algún lector no aplique las correcciones: lo cubre la prueba de
  "mismas cifras en todas las pantallas" y la lista del punto 4.
- Vista previa lenta en empresas grandes: un mes de toda la empresa (AVP,
  ~480 personas) tarda alrededor de 1 s por cálculo. Se mide; si con 5000
  empleados no alcanza, se acota a las personas que fichan ese día en el
  mismo reloj.
- Corregir varias veces el mismo día: cada vista previa se calcula sobre las
  correcciones que ya están activas.
- Meses sin reloj identificado (AVP, enero a mayo de 2026): la mayoría de
  los fichajes no se van a poder corregir (regla 3 bis.3).

## 10. Preguntas para el dueño (no entran en G sin su sí)

- **L1.** Validación nueva en "Corregir marcador": no permitir "era de X" si
  el fichaje de X que lo tomaría ya tiene una corrección de G. Sin esto, se
  podría llegar a una contradicción haciendo las correcciones en ese orden.
- **L2.** "Corregir marcador" hoy deja que X tome el marcador desde **otro
  reloj**. ¿Se cambia a "solo el mismo reloj", según la regla multireloj?
  Cambia algo publicado; se mediría antes cuántas correcciones existentes
  quedarían distintas.

## 12. Implementación local de G (2026-10-30)

### Archivos

| Archivo | Qué |
|---|---|
| `migrations/20261027_correcciones_fichajes.sql` | tabla + permisos `fichajes:read`/`fichajes:update` solo para "Administrador de Empresa" (idempotente) |
| `motor-laboral/services/correccionesFichajes.js` (nuevo) | leer, aplicar para el motor de marcadores y para las horas, simulación de la vista previa |
| `routes/correccionesFichajes.js` (nuevo) | `/api/correcciones-fichajes`: historial, vista previa, corregir, deshacer |
| `motor-laboral/services/campanaService.js` | `fetchMovementCheckins` aplica las correcciones; `fetchMovementCheckinsCrudos` = lo del reloj; campaña "solo afectados" |
| `horasdedica.js` | Presentismo (`/attendance-range`), día (`/attendance/:date`), fichajes del día, choque de cargas manuales; "Ver el reloj" y las pistas del marcador previo usan lo crudo; L1 en `/marker-corrections`; Salidas se puede correr en proceso (`calcularSalidas`) |
| `motor-laboral/repositories/checkinRepository.js`, `services/attendanceService.js` | motor diario y comparación legacy |
| `cupoMotivoRepository.js`, `licenciasLargasRepository.js`, `routes/employees.js` | días fichados, "volvió a fichar", último fichaje |
| `motor-laboral/services/permisos.js` | módulo `fichajes` (solo Ver y Editar) |
| `registroActividad.js` | corregir y deshacer quedan en el registro de actividad |
| `test-helpers/firebaseTestAuth.js` | borrar usuarios de prueba que corrigieron algo |
| `test/correcciones-fichajes-transformacion.test.js`, `test/correcciones-fichajes.test.js` (nuevos) | 16 + 16 tests |

### Decisiones tomadas al implementar

- **Cómo se reconoce el fichaje en los lectores: número crudo del reloj +
  hora exacta** (únicos por empresa, clave `uq_checkin`), no `Checkins.id`.
  Medido: agregar `c.id` a una consulta cambió el orden en que la base
  devolvía dos fichajes del mismo segundo, y en Campaña el marcador pasó a
  otra persona (02/03/2026 06:53:54, legajos 2485 y 9448; uno sin reloj).
  La corrección guarda el `id` y la copia de control, y se valida al leer.
  Para las consultas que solo cuentan, se agrega `AND c.id NOT IN (...)`
  **solo si hay fichajes omitidos**: sin correcciones, el texto de cada
  consulta es exactamente el de antes.
- **Diferencias de la vista previa**: además de Presentismo (resumen por
  persona y detalle por día), Salidas y Campaña, se comparan los movimientos
  por marcador del día (salidas y horas extra) persona por persona. Hace
  falta: en el caso tipo 2544/2446, a B no le cambian los totales pero sí la
  interpretación de su fichaje.
- **Auditoría de relojes precisa**: el mismo marcador puede apretarse en el
  mismo segundo en dos relojes; hay problema solo si ninguna de esas
  lecturas es del reloj del fichaje.
- **Usuarios limitados por áreas: no entran** (la vista previa muestra gente
  de toda la empresa). `alcance.js` cierra toda ruta que no está en su lista.
- La vista previa usa GET (no queda en el registro de actividad, no cambia
  nada); corregir y deshacer son POST y sí quedan.

### Resultados

- **Sin correcciones, todo igual** — 48 respuestas (Salidas Particular y
  Oficial ene–oct, Campaña, Presentismo de cada mes, Liquidación de cada mes,
  detalle de cada persona de junio y octubre, fichajes del día, día de
  Presentismo y motor diario de 6 días, Fichajes de 5 personas), comparadas
  campo por campo contra la foto de antes: **0 diferencias** sin la tabla, 0
  con la tabla vacía, 0 al final. (Dos fotos seguidas de antes también dan 0:
  el cálculo es estable.)
- **Datos reales de octubre, relojes .30 y .33**: 2.483 fichajes que se
  llevaban un marcador (más una muestra del resto), corregidos de a uno con
  las 3 acciones: **0 marcadores con un fichaje de otro reloj**. A otra
  persona del mismo reloj le cambia algo en ~0,9 % al omitir (22) y en 2
  casos al quitar o cambiar el marcador: la vista previa los muestra y pide
  la segunda confirmación.
- **Santi 01/10 real** (copia local): vista previa en 2,3 s; omitir 12:05 y
  12:09 → Salidas 12:04→15:06, Presentismo y Fichajes del día dicen lo
  mismo y muestran los omitidos; nadie más cambia; deshacer deja todo
  exactamente como estaba.
- Tests: 32 nuevos (todos pasan) + "Corregir marcador" sin cambios.

### Hallazgo que ya existía (no lo causó G; no se tocó)

Dos fichajes del **mismo segundo**: la base los devuelve en un orden que no
está garantizado (`ORDER BY CHECKTIME` con empate) y que puede cambiar
según la consulta o el rango pedido. Si uno se lleva un marcador, el
resultado puede depender de eso (Salidas de un mes vs. de un año podrían
diferir en ese caso). Con relojes identificados solo importa si los dos
fichajes son del mismo reloj y en el mismo segundo. Arreglarlo es cambiar el
orden de lectura del motor: requiere aprobación.

### L2: auditoría de "Corregir marcador" entre relojes

Copia de seguridad de producción del 29/10 23:14: la tabla
`marker_corrections` existe y tiene **0 filas** (su contador está en 5: se
cargaron 4 alguna vez y ya no existen). Cambiar a "solo el mismo reloj" no le
cambia el resultado a ninguna corrección existente. **El dueño eligió L2b
(2026-10-30): "Corregir marcador" solo anula; nunca asigna a otra persona.
Implementado en local.**

### Pendiente para H

El frontend tiene la lista de módulos de permisos escrita a mano
(`users.ts`, `PERMISSION_MODULES`): falta agregar "Corregir fichajes" para que
se pueda dar a un jefe de personal. Guardar un rol conserva los permisos que
la pantalla no conoce, así que hoy no se pierde nada.

## 11. Condiciones que se mantienen

- No se modifican los motores de cálculo ni las reglas de asistencia, salidas
  u horas extra.
- No se modifica ni se crea ninguna fila de `Checkins`.
- Todo cambio es trazable (quién, cuándo, motivo) y se puede deshacer.
- Aislamiento entre empresas y permisos validados en el servidor.
- Solo local: sin migraciones en producción, commits, publicaciones ni
  despliegues.
