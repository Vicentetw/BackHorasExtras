# Horas extra: una sola verdad (análisis y correcciones, 2026-10-18)

> El dueño lo pidió así: "cómo vas a tener dos informes distintos cuando se
> utiliza para pagar, eso no es serio para ningún cliente".

## La regla

Para la misma persona y el mismo período, **todas** las pantallas dan el mismo
número:
- Presentismo: listado, detalle, calendario, PDF y Excel.
- Horas Extra por Régimen: mes, quincena y semana, más sus exportes.
- Liquidación y el portal del empleado.
- Días a revisar.
- Las vistas previas ("Ver qué cambiaría").

La suma de los días del calendario es el total del mes.

**Cómo se logra:** hay un único cálculo, `/attendance-range`, y todas las
pantallas lo usan. Liquidación, el portal, Días a revisar y las vistas previas
lo llaman desde adentro del servidor (`calcularAsistencia`). No existe una
segunda fórmula.

**Cómo se controla:** `test/una-sola-verdad-horas-extra.test.js` corre en cada
`npm test` con una empresa de prueba que tiene régimen (mínimo propio y tope
mensual que no computa el excedente), horario partido y la "fuente" vieja
guardada. Si alguien rompe la regla, el test falla.

## Qué se encontró y cómo se corrigió

| # | Diferencia | Comprobado | Corrección |
|---|---|---|---|
| 1 | Con régimen, el calendario mostraba el número **antes** del mínimo, el redondeo y los topes del régimen, y el total ya los aplicaba. | En producción: las 2 personas con régimen. Una tenía 6:21 h en el calendario contra 2:09 h de total. | Cada día muestra lo que de verdad cuenta (lo computable del régimen), con el motivo si no suma ("24 min, menos del mínimo de 25"). |
| 2 | La "fuente" del régimen (solo marcas, solo fichajes) cambiaba el informe por régimen pero no Presentismo (punto F). | Por código. | El régimen parte del mismo resultado del día. Cómo se cuentan se elige en un solo lugar (Horas extra → paso 1). Se agregó el método "Solo con las marcas del reloj" para no perder esa opción. La columna `fuente` queda sin uso. |
| 3 | El recorte de la plantilla (nada dentro de la jornada ni del descanso) se hacía **solo** con régimen. | Copia de producción, septiembre: −73 h en 60 personas. Ejemplo: marcador 9 a las 05:10 y salida a las 13:52 con horario de 7 a 14 contaba 8 h 42 min de horas extra **dentro** de su jornada. | Regla universal para todos (`recortarDelDia`). El detalle dice qué se descontó ("se descontaron 22 min dentro de la jornada"). Si la plantilla está mal (dice 14:00 y salen 13:38), se corrige la plantilla. |
| 4 | Los topes del mes dependían del rango pedido: la 2da quincena sola no llegaba a un tope que sí se alcanzaba dentro del mes. | Por código y en el test. | Si el rango no es de meses enteros, el régimen se calcula sobre el mes completo y se toma la parte del rango (`recortarAlRango`). |
| 5 | El tope anual acumulaba lo calculado en vivo de los meses anteriores **del rango**: septiembre solo y septiembre dentro de agosto-septiembre podían dar distinto. | Por código. | Lo ya computado en el año = lo **liquidado** (meses cerrados), siempre. Es el criterio contable: el tope anual se controla contra lo pagado. |
| 6 | Meses cerrados: Liquidación muestra la foto del cierre y las demás pantallas el cálculo de hoy, sin avisar. | Por código. Las tablas de cierre ya están en producción (backup del 17/10). | Aviso de "mes cerrado" en Presentismo, en Horas Extra por Régimen y en los detalles. La diferencia no se pierde: se paga o descuenta como ajuste en el mes siguiente. El portal ya mostraba "lo liquidado". |
| 7 | Los totales de pantallas, PDF y Excel sumaban **horas ya redondeadas** a 2 decimales. | Por código. | El servidor manda también `overtimeMinutes` (minutos enteros). Los totales, Liquidación y el portal suman minutos. |
| 8 | Una hora extra cargada a mano en un día no laborable, feriado o sin horario sumaba al total pero el calendario no la mostraba en ese día. | Por código. | Esos días también traen `overtimeMinutes`. |
| 9 | "Ver qué cambiaría" reimplementaba parte del cálculo y no veía el régimen. | Por código. | Corre el cálculo completo dos veces y compara día por día (`compararHorasExtra.js`). El test comprueba que lo que promete es lo que pasa al guardar. Solo se acepta desde adentro del servidor: desde afuera nadie puede pedir un cálculo "simulado". |

Lo que ya estaba bien (medido sobre la copia de producción, 480 personas):
listado = detalle = suma de días sin régimen (132 personas con horas extra en
septiembre) y Liquidación en vivo = Presentismo.

## Impacto en los números (copia de producción, código publicado vs nuevo)

- Septiembre 2026: 2918,84 h → 2845,57 h (−73,27 h). Cambian 60 personas y
  todas bajan, por el recorte de la plantilla (punto 3).
- Octubre 2026 (1 al 17): sin cambios.

## Pendiente o a decidir
- Plantillas que no coinciden con el horario real (ej. dicen 14:00 y la gente
  sale 13:38): ahora se ve en el detalle. Hay que corregir la plantilla.
- El tope anual cuenta lo liquidado: conviene cerrar los meses en orden en
  Liquidación (las tablas ya están en producción).
