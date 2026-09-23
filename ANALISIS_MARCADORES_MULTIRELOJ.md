# Marcadores con varios relojes — análisis (2026-09-23)

Respuesta a las diez preguntas del análisis, sobre el código real y con datos
de producción. **El hallazgo principal: el escenario que se imaginó ya está
pasando, 272 veces.**

---

## El hallazgo, primero

`detectMovements` (`motor-laboral/services/movementsCalculations.js:60`) usa
**una sola variable global** para el marcador pendiente:

```js
let lastMarker = null;   // línea 64 — NO es por empleado
```

El marcador lo consume **el próximo fichaje real, sea de quien sea y venga
del reloj que venga**. La única protección es una ventana de tiempo
(`markerMaxGapSeconds`, hoy **6 segundos** para AVP).

Medido sobre los 111.529 fichajes con reloj identificado:

| | |
|---|---|
| Fichajes de marcador | 24.664 |
| Alguien fichó dentro de los 6 s | 20.369 |
| **Cruzados: el marcador se fichó en un reloj y lo consumió un fichaje del otro** | **272** |

Casi todos son el **marcador 9 (inicio de hora extra)**. Ejemplos reales:

```
2026-06-01 13:49:21  marcador 9 en .33  ->  usuario 2679 en .30 (mismo segundo)
2026-06-04 13:51:14  marcador 9 en .33  ->  usuario 9995 en .30 (1 s después)
2026-06-09 13:47:44  marcador 9 en .30  ->  usuario 2107 en .33 (4 s después)
```

Si los dos relojes están en lugares distintos, **la persona que apretó el
marcador no puede ser la que fichó un segundo después en el otro aparato**.

Y no es la primera vez que muerde: el código ya tiene un parche por un caso
así con un solo reloj (AVILA Natalia, 08/04/2026, comentario en
`movementsCalculations.js:234`) — *"Alguien más fichó el marcador de Salida
justo antes de que Natalia marcara su propia entrada"*.

---

## Las diez preguntas

### 1. ¿Cómo se almacenan los relojes?

No existen como entidad. No hay tabla de relojes. Lo único que queda es
`Checkins.MACHINE_IP` y `Checkins.MACHINE_SN`, que el agente anota en cada
fichaje. Hoy: `172.155.0.30` (89.394 fichajes) y `172.155.0.33` (22.135), más
46.203 viejos sin IP.

### 2. ¿Cómo se almacenan los usuarios de cada reloj?

**En una sola lista, sin distinguir el reloj.** `users` tiene clave
`(tenant_id, USERID)` y ninguna columna de aparato. Los listados de los dos
relojes se mezclan en las mismas filas. De ahí salió el caso del 105
(corregido el 2026-09-23: ahora un nombre vacío no pisa a uno bueno).

### 3. ¿Cómo se relaciona un usuario del reloj con un empleado?

`user_employee_map (USERID, employee_id, tenant_id)`. **Un usuario de reloj
apunta a un solo empleado, por empresa.** No hay forma de decir "el 105 del
reloj A es Fulano y el 105 del reloj B es Mengano".

### 4. ¿Cómo se guarda cada fichaje?

`Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP, MACHINE_SN, source, …)`,
con clave única `(tenant_id, USERID, CHECKTIME)`.

**Ojo con esa clave**: no incluye el reloj. Si la misma persona fichara en los
dos relojes exactamente en el mismo segundo, el segundo registro se descarta
como duplicado. Con segundos distintos, entran los dos.

### 5. ¿Cómo se determina el empleado de un fichaje?

`horasdedica.js:4085`:

```sql
LEFT JOIN users u ON (u.USERID = c.USERID
                  OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR))
                 AND u.tenant_id = c.tenant_id
```

Por número, **no por reloj**. Respondiendo la pregunta del análisis: el
sistema usa `(empresa, número)` como identidad, **no** `(reloj, número)`.

Para AVP eso es correcto: se verificó que los dos relojes comparten
numeración. De 195 usuarios solo 11 fichan en los dos, y los que más se
solapan son los marcadores (USERID 3 al 10), que están en ambos a propósito.
Personas reales en los dos relojes: **una**.

Pero es una **suposición no declarada**: si una empresa numerara cada reloj
por su cuenta, el sistema fusionaría personas distintas sin avisar.

### 6. ¿Cómo se ordenan los fichajes de distintos relojes?

**Bien.** `fetchMovementCheckins` termina en `ORDER BY c.CHECKTIME`
(`horasdedica.js:4094`), y `detectMovements` vuelve a ordenar por las dudas
(`movementsCalculations.js:63`).

**El orden de descarga no influye.** Los fichajes se importan primero y se
interpretan después, leyéndolos ordenados desde la base. La preocupación del
análisis sobre "descargar A y después B" no aplica acá.

### 7. ¿Cómo se detectan duplicados?

Por la clave única `(tenant_id, USERID, CHECKTIME)`: el mismo usuario en el
mismo segundo entra una sola vez. **No hay ninguna regla de "dos fichajes con
pocos segundos de diferencia son el mismo"** a nivel de datos.

Sí hay una en la interpretación: `ownCheckinBounceMs` (20 s,
`movementsCalculations.js:58`) — un segundo fichaje de la misma persona
dentro de 20 s no consume el marcador activo, para que un rebote no se robe
el marcador de otro.

### 8. ¿Cómo funciona exactamente el marcador?

Es **una orden para el sistema, no una persona**. `specialusers` le da
significado a un USERID (categoría + dirección). Hoy hay ocho: 2=HE/REGRESO,
3=OFICIAL/REGRESO, 4=OFICIAL/SALIDA, 5=PARTICULAR/REGRESO,
6=PARTICULAR/SALIDA, 7=CAMPANA/REGRESO, 8=CAMPANA/SALIDA, 9=HE/SALIDA.

El fichaje del marcador **no se atribuye a nadie**: se guarda el estado y se
sigue de largo (`continue`, línea 74).

### 9. ¿El marcador afecta al próximo fichaje GLOBAL o al del empleado?

**Al próximo fichaje global.** Es la respuesta a la pregunta central, y es el
problema.

El marcador no puede saber a qué empleado pertenece —nadie se identifica al
apretarlo—, así que el sistema lo atribuye al primer fichaje real que llegue
después. Las tres defensas que existen son todas heurísticas:

1. **la ventana de 6 segundos** (`maxMarkerGapMs`): pasado ese tiempo, el
   marcador vence;
2. **el resguardo de rebote de 20 s**: el re-fichaje de la misma persona no
   consume el marcador;
3. **`filterEventsOpenedByFirstCheckinOfDay`**: descarta un evento abierto
   por el primer fichaje del día de alguien (el parche del caso AVILA).

Ninguna de las tres mira de qué reloj vino cada cosa.

### 10. ¿Cómo se decide entrada / salida / hora extra?

Dos caminos distintos, y conviene no confundirlos:

- **Salidas particular/oficial/campaña**: por marcadores, vía
  `detectMovements` (lo de arriba).
- **Horas extra**: hay un camino por marcadores 9/10 y un heurístico
  "clásico" por horario de corte (`horasdedica.js:1100` y siguientes). El
  marcador tiene prioridad cuando existe ese día.

---

## Lo que conviene hacer

### Primero: un marcador solo lo puede consumir un fichaje del MISMO reloj

Es la corrección más directa, y elimina los 272 casos de una. Físicamente un
marcador apretado en un aparato solo puede referirse a alguien parado frente
a *ese* aparato.

`MACHINE_IP` ya está guardado en cada fichaje: alcanza con seleccionarlo en
`fetchMovementCheckins` y compararlo en `detectMovements` antes de consumir
el marcador.

**No es gratis**: cambia números históricos. Los 272 casos dejan de generar
el movimiento que hoy generan. Algunos de esos movimientos hoy están mal
—son el bug— pero puede que alguno estuviera bien por casualidad. Por eso
conviene correrlo primero en modo comparación y ver qué cambia, antes de
activarlo.

### Segundo: el problema de fondo no se arregla con heurísticas

Un marcador seguido de un fichaje es **una convención frágil**: depende de
que nadie se cruce en el medio. La ventana de 6 segundos la hace poco
probable, no imposible — y con dos relojes, menos improbable todavía.

La forma robusta es que **el fichaje mismo lleve el tipo**. Los relojes ZK
suelen tener teclas de función o "work codes" que el empleado aprieta antes
de su propia huella, y eso viaja **en su propio registro**, no en uno
separado de otra persona. Si el modelo de AVP lo soporta, cambia el problema
de raíz: se termina la atribución por cercanía.

Vale la pena averiguarlo antes de seguir agregando parches al esquema actual.

### Tercero: declarar la suposición de numeración

Hoy el sistema asume que un número identifica a la misma persona en todos los
relojes de una empresa. Para AVP es cierto y está verificado. Para un cliente
nuevo puede no serlo, y hoy nada lo detecta.

Con `MACHINE_IP` ya guardado se puede avisar: "el usuario 105 aparece en dos
relojes con nombres distintos" es una consulta, no un rediseño.

---

## Las pruebas que propone el análisis

Son las correctas y se pueden escribir como tests sin tocar el reloj:
`detectMovements` es una función pura que recibe una lista de fichajes. Basta
armar las secuencias (marcador en A, persona en B un segundo después; al
revés; con dos personas distintas) y comprobar a quién se le atribuye.

La prueba de "descargar primero A y después B" **ya está respondida por el
código**: la interpretación lee de la base ordenada por hora, no en orden de
llegada. Igual conviene un test que lo congele, para que nadie lo rompa sin
enterarse.
