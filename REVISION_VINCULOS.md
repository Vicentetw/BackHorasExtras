# Revisión de los vínculos reloj ↔ empleado (2026-09-23)

Disparada por un reporte concreto: el badge `10000` "ECHEGARAY Aldo" quedó
unido al empleado con legajo `10000` "CERVO, Agustín Julián" —dos personas
distintas— con `match_type = auto_employee_id`.

## ¿Sigue pasando hoy? No

Hay **un solo lugar** en todo el código que crea vínculos:
`routes/matching.routes.js:602`, y siempre con `match_type = 'manual'`.

El que escribía `auto_employee_id` era `endpoints-employees.js`, que unía por
legajo sin mirar el nombre y **sin `ORDER BY`**, quedándose con una fila
arbitraria cuando había más de una. Ese archivo ya no lo monta nadie y se
retiró del repositorio el 2026-09-23.

O sea: **nada se vincula solo**. Lo que quedó es la herencia de esos 454
vínculos automáticos viejos.

## Qué hay en producción

De **466 vínculos**:

| | |
|---|---|
| El nombre del reloj coincide con el del empleado | 436 |
| El reloj no tiene nombre útil (dice `9370`, `NN-3042`) | 13 |
| **Nombres que de verdad no se parecen** | **17** |

## De esos 17, la mayoría NO son errores

**Nueve son el bug de codificación** que se corrigió en el agente el
2026-09-20 (el reloj mandaba los nombres en cp1252 y se leían como UTF-8, y
la ñ o la vocal acentuada se borraba):

```
IBAEZ          -> IBAÑEZ, Héctor Marcelo
LABRAA         -> LABRAÑA, Juan
MUOZ           -> MUÑOZ, Adrian Gustavo
NUEZ           -> NUÑEZ, Walter
PEIPIL         -> PEÑIPIL, Isabelina Dora
MAROAS         -> MAROÑAS, Gastón
TORTOLA Hernn  -> TORTOLA Hernán
CERVO, Agustn  -> CERVO, Agustín
San Martn Luca -> SAN MARTIN, Luciana
```

Son la misma persona. El vínculo está bien; lo que estaba mal era el nombre
guardado.

> ⚠️ **Corrección del 2026-09-23.** Acá decía que estos nombres "se corrigen
> solos en la próxima sincronización". **Era falso con el código de ese
> momento**, y conviene dejarlo escrito porque es el tipo de error que hace
> perder tiempo esperando algo que no iba a pasar.
>
> `upsertUsersBatch` no actualizaba el nombre cuando el USERID y el badge ya
> existían iguales — justo el caso de estos nueve. O sea que `IBAEZ` se iba a
> quedar `IBAEZ` para siempre por más veces que se sincronizara. Era
> incoherente con el propio código, que sí actualizaba el nombre cuando el
> badge venía con otro USERID.
>
> Corregido junto con el arreglo de los dos relojes: ahora el reloj vuelve a
> ser la fuente de verdad del nombre, con la única excepción de que un nombre
> que no identifica a nadie (`NN-105`, el propio número, vacío) no pisa a uno
> bueno. Recién **ahora** sí se corrigen sincronizando.

**Tres son diferencias de ortografía** entre el reloj y la lista de personal
(`CAMUSO`/`CAMUSSO`, `BARRIOS`/`BARRIO`, `ZORRILLA`/`ZORRILA`). También la
misma persona.

## Los cuatro que sí están mal

Personas distintas unidas porque coincidía el número:

| Reloj | Empleado | Fichadas |
|---|---|---|
| badge 115 — **AGUILAR GABRIEL** | legajo 2454 — BEHR, Angel Enrique | 0 |
| badge 201 — **VARGAS Maximiliano** | legajo 3032 — ROSELLI, Domingo Paulo | 0 |
| badge 10000 — **ECHEGARAY Aldo** | legajo 10000 — CERVO, Agustín Julián | 0 |
| badge 9461 — **RODRIGUEZ** | legajo 9461 — GARCIA, Fátima | 0 |

**Los cuatro tienen 0 fichadas.** Eso importa: **ninguna hora de nadie se
atribuyó a otra persona.** Son vínculos incorrectos, no horas mal pagadas.

## Un dato para el caso del legajo 105

Buscando esto apareció algo relacionado: **el badge 115 del reloj se llama
"AGUILAR GABRIEL"**, y está vinculado por error a BEHR.

O sea que hay dos candidatos para la misma persona:

- **badge 115**, que *tiene el nombre* pero **0 fichadas**;
- **usuario 105 (`NN-105`)**, que *tiene 240 fichadas* pero ningún nombre.

Cuál de los dos es el que Aguilar Gabriel usa para fichar no se puede deducir
de los datos: hay que preguntarle o mirar el reloj. Vincular el equivocado
dejaría sus 240 fichadas sin llegar a ningún informe, que es exactamente el
problema que se quería resolver.

## Qué conviene hacer

1. **Desvincular los cuatro.** No hay horas en juego, así que es seguro. Cada
   uno queda como "usuario de reloj sin asociar" y aparece en la pantalla de
   Matching para resolverlo bien.
2. **Sincronizar usuarios** desde el agente, para que los nueve nombres con
   ñ/acento se corrijan en `users` y dejen de verse como sospechosos.
3. **Decidir el caso 105 vs 115** con información de afuera del sistema.

Nada de esto se ejecutó: son escrituras en producción.
