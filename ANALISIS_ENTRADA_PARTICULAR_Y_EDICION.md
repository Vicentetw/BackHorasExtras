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
