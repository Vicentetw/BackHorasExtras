# Horas extra configurables — diseño (bloque B)

Acordado con el dueño del producto el 2026-09-29. Este documento es la
referencia: cada paso de implementación se verifica contra lo que dice acá.

## El problema

Las horas extra son plata, y hoy el cálculo **no es configurable**:

- Hay dos caminos y dan distinto: con marcadores (9 → 10) y "estimado" (sin
  marcadores). El estimado tiene supuestos fijos de AVP en el código (ej. "hubo
  jornada si fichó entre 07:00 y 14:00").
- No hay topes mensuales/anuales, ni política para el excedente, ni recargos
  aplicados (50 % / 100 %), ni forma de "registrar sin pagar".
- Los bloques "Descanso" y "Hora extra" de las plantillas se guardan pero no se
  usan.
- Existe un "motor de reglas" (Etapas 5–14, `timeClassifier.js`) con convenios,
  recargos por tipo de día y políticas fuera de horario, pero está **apagado**
  (todas las plantillas en `legacy`) y no conoce los marcadores.

Con AVP funciona porque se ajustó a AVP. Otra empresa, con otras reglas,
recibiría números mal liquidados.

## La decisión de arquitectura: horario ≠ reglas de pago

Dos personas con **la misma plantilla** (lunes a viernes, 7 a 14) pueden tener
reglas de pago opuestas: una cobra las horas extra (también sábado y domingo),
otra no cobra nada fuera de su horario pero se lo tiene que registrar. Entonces:

| Concepto | Dónde vive | Responde |
|---|---|---|
| **Plantilla** | `work_schedule_templates` + `shift_blocks` | ¿Cuándo trabaja? Jornada, descansos, ventana de horas extra. Nada de plata. |
| **Régimen** (convenio) | `labor_conventions` + reglas | ¿Cómo se computa y se paga lo que excede la jornada? |
| **Asignación** | `employee_convention_assignments` (con vigencia) | ¿Qué régimen tiene esta persona en esta fecha? Sin asignación: el régimen por defecto de la empresa. |
| **Autorización individual** | nueva | "Esta persona puede hacer hasta N h/mes desde tal fecha" |

Nada de la ley va en el código: todo sale de datos. Para arrancar rápido se
ofrecen **modelos por país** (ej. "Argentina — norma general: 3 h/día, 30 h/mes,
200 h/año") que la empresa copia y ajusta.

## Qué define un régimen

1. **Fuera de horario, por tipo de día** (hábil, sábado, domingo, feriado,
   franco = día no laborable según su plantilla), una de:
   - `EXTRA` — hora extra, con su **recargo** (50 %, 100 %…)
   - `EXTRA_SI_AUTORIZADO` — hora extra solo si la persona está autorizada
   - `REGISTRAR` — **se registra y no se paga** ("fichó fuera de su horario";
     suma a "horas de dedicación", visible, convertible después a mano)
   - `NO_COMPUTAR` — no suma a nada (igual queda en el detalle)

   Reutiliza `day_type_overtime_rules` (day_type + trigger + classification +
   rate + requires_authorization).
2. **Topes** por día / mes / año, cada uno opcional, con vigencia.
3. **Política de excedente** (qué pasa con lo que supera el tope):

   | Política | Efecto |
   |---|---|
   | `TAL_CUAL` | sin tope efectivo: se computa todo |
   | `AVISAR` | se computa todo, con aviso |
   | `NO_COMPUTAR` | computables = tope; el excedente queda registrado y visible |
   | `AUTORIZAR` | el excedente queda "pendiente" hasta que alguien lo apruebe (auditado) |
4. **Fuente**: marcadores / fichajes / marcadores y, si faltan, estimado con
   aviso "a verificar" (el comportamiento de hoy, como default).
5. **Mínimo y redondeo**: "no computar menos de N min", "redondear a 15/30".
   Apagados por default.

## Qué define la plantilla (solo horario)

- **Trabajo**: jornada normal. Nunca es hora extra.
- **Descanso**: nunca cuenta como trabajo ni como hora extra. Un marcador 9
  apretado a las 14:45 dentro de un descanso 14–15 cuenta desde las 15:00 (y
  el detalle lo dice).
- **Hora extra** (opcional): la ventana donde se permite. Sin ella, cuenta
  desde el fin de la jornada o del descanso que la sigue.
- El "Corte HE" actual pasa a ser "las horas extra cuentan desde" (ya se aplica
  a los dos caminos desde d2d28de, 2026-09-29).

Las dos fuentes (marcadores y estimado) pasan por **la misma ventana y el
mismo recorte**: el resultado no depende de si usó el marcador o no.

## El cálculo (funciones puras, en este orden)

1. **Intervalos candidatos del día**: marcadores (9 → 10) como "intervalos
   declarados" + fichajes fuera de la jornada según la fuente del régimen.
2. **Recorte por la plantilla**: sacar jornada y descansos; limitar a la
   ventana de horas extra.
3. **Clasificación por tipo de día** con las reglas del régimen: `EXTRA` (con
   recargo), `REGISTRAR`, `NO_COMPUTAR`, `EXTRA_SI_AUTORIZADO`.
4. **Mínimo y redondeo**.
5. **Topes en capas** (empresa → régimen → persona; gana el más restrictivo),
   consumidos **en orden cronológico** dentro del período: las primeras horas
   del mes son computables, el resto excedente. Así queda definido qué horas
   van al 50 % y cuáles al 100 %.
6. **Política de excedente** y aprobaciones puntuales.

Resultado por persona y período:

```
Reales 62 h  →  Computables 40 h (32 h al 50 % · 8 h al 100 %)
                Excedente 22 h ⚠ pendiente de autorización
                Registradas sin pago: 3 h
```

## Cómo se activa sin romper nada

- Todo lo nuevo es **opt-in por empresa**. Sin régimen configurado, el
  resultado oficial sigue siendo el de hoy.
- Antes de activarlo para una empresa: **un mes entero calculado en paralelo**
  con los dos motores (modo sombra, que ya existe) y cada diferencia explicada.
  Recién ahí se activa.
- Las funciones puras llevan tests con los casos reales (MARTENSEN con
  descanso y corte, CHINELI con 62 h y tope de 40, una persona que ficha un
  sábado sin régimen de horas extra).

## Pasos

| Paso | Qué | Terminado cuando… |
|---|---|---|
| B1 | Modelo de datos: topes y política de excedente por régimen (con vigencia), autorización individual, aprobaciones de excedente, fuente/mínimo/redondeo. Migración. | Migración idempotente + tests de repositorio |
| B2 | Funciones puras: recorte por plantilla (descansos/ventana), clasificación por tipo de día, mínimo/redondeo, topes en capas cronológicos, política de excedente | Tests con los casos reales, incluidos los de este documento |
| B3 | Integración en el cálculo mensual: opt-in por empresa; sin régimen, idéntico a hoy (comparado contra toda AVP) | Resultado idéntico sin configuración; comparación en sombra de septiembre |
| B4 | Pantallas: régimen (con modelos por país), asignación por persona, autorización individual, Presentismo (reales / computables / excedente / sin pago), aprobación de excedente | Recorrido completo probado en navegador |
| B5 | Informe para liquidación: por persona, por recargo, exportable | Coincide con Presentismo al minuto |

## Preguntas ya respondidas por el dueño del producto

- El tope de Vialidad es **mensual** (40 h). Otras empresas pueden tener otros.
- El excedente tiene que ser configurable (tal cual / avisar / no computar /
  autorizar).
- Hay regímenes donde sábados y domingos van al 50 % y feriados/domingos al
  100 %, y otros donde lo fuera de horario **no se paga pero se registra**
  (posible "hora de dedicación" a futuro).
