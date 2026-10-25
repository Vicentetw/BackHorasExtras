# Salidas, llegadas y horas extra cuando NO se usa marcador (análisis, 2026-10-22)

> Análisis previo, **sin cambios de código**. Pedido del dueño: "hacer un
> análisis muy profundo de lo que está actualmente" antes de agregar algo como
> "salida anticipada". Leer junto con `MARCADORES_Y_SALIDAS.md`.

## 1. Cómo funciona hoy (todo depende de los marcadores)

| Concepto | Cómo se detecta | Límite mensual | Qué muestra el día |
|---|---|---|---|
| Llegada tarde | primer fichaje > entrada + tolerancia | cantidad y/o minutos (Administración → "Llegadas tarde y salidas"); solo avisa | Tarde |
| Llegada tarde justificada | justificación cargada, o "entrada particular" (tecla 5) autorizada/justificada | bolsa "licencia personal" (`personalLeaveMonthlyLimitMinutes`); un motivo puede "no descontar" | Tarde justificada |
| Salida particular (6 → 5) | marcador | cantidad y/o minutos (`particularExitMonthly*`); solo avisa | indicador; el estado no cambia |
| — sin regreso (se fue antes) | tecla 6 y no vuelve; se cierra a la salida del horario | idem | idem |
| — entrada particular | llega con el 5 sin haber salido | idem | Tarde (o justificada si se autoriza) |
| Salida oficial (4 → 3) | marcador; autorizada por la empresa | **no cuenta** para ningún límite | — |
| Campaña (8 → 7), horas extra (9 → 10) | marcador | — | — |

Opciones por empresa que ya existen: autorización de salidas particulares
(E1), justificar una salida con un motivo que descuenta o no (E2).

**Sin marcador, nada de esto se ve.** Si alguien se va antes o sale y vuelve
sin apretar una tecla, el día queda "A tiempo" y no suma a ningún límite.
Las empresas con reloj sin teclas (o de rostro) no pueden controlar salidas.

## 2. Medido: septiembre 2026, copia de producción (AVP, 160 personas)

| | Días |
|---|---|
| Días trabajados con horario de día | 2.477 |
| Con salida particular por marcador | 245 |
| Se fue más de 10 min antes de su salida **sin marcador** | 258 (89 personas, 551 h) |
| Salió y volvió en el medio (> 30 min) sin marcador particular | 41 (130 h; aproximado: puede incluir oficiales) |
| Un solo fichaje en el día | 222 |

**Ojo:** muchas de las 258 "salidas antes" son **plantillas que no coinciden**,
no salidas reales. Ej.: legajo 3076, plantilla 07:00–14:00, sale **todos los
días** 13:45; serenos con plantilla de día. Si se marcara "salida antes" hoy,
la mayoría serían falsas alarmas.

## 3. Conclusiones

1. **"Salida anticipada" no es un concepto nuevo:** es una salida particular
   sin regreso que no se marcó. Un hueco en el medio sin marcador es una
   salida particular completa que no se marcó. Tienen que entrar al **mismo**
   circuito (Salidas, límites, autorización, justificación con motivo,
   oficial), no a uno paralelo.
2. **Primero las plantillas tienen que coincidir** (punto 4b: "su plantilla no
   coincide con cómo ficha"). Si no, las salidas sin marcador serían ruido.
3. Propuesta (a decidir): opción por empresa **"Salidas sin marcador"**,
   apagada por defecto (= hoy). Encendida, una salida antes de hora o un hueco
   en el medio sin marcador aparece en Salidas como **particular "sin
   marcar"**, y el encargado la deja particular (cuenta para el límite), la
   pasa a **oficial** (no cuenta) o la **justifica con un motivo**. Mismo
   motor (`detectMovements`), mismas pantallas, misma verdad.
4. Pendientes chicos ya vistos: fichar la salida y reingresar a horas extra
   en menos de 3 minutos sin marcador queda "a revisar" todos los días (regla
   par/impar); y "llegó tarde y se quedó": ¿se compensa la tardanza con las
   horas extra? (opción por empresa, apagada por defecto).

## 4. Orden propuesto

4a "Todavía no llegó" → 4b plantilla que no coincide → "Salidas sin marcador"
→ regla par/impar → opción de compensar. Cada uno: todas las variantes con
datos de prueba, impacto real sobre la copia de producción, aprobación.
