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
| **Autorización individual** | `employee_overtime_authorizations` | "Esta persona puede hacer hasta N h/mes desde tal fecha". **Reemplaza** el tope del régimen para esa persona (existe justamente para dar más o menos horas que el régimen). |

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
5. **Topes**: los de la persona si tiene una autorización individual (la
   reemplaza, tope por tope); si no, los de su régimen; si su régimen no tiene,
   los de la empresa. Se consumen **en orden cronológico** dentro del período: las primeras horas
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
| B1 ✅ | Modelo de datos (migración `20261006`): `overtime_regime_policies` (no `overtime_policies`: esa ya existía, vacía y sin uso), `employee_overtime_authorizations`, `overtime_excess_approvals`. Lectura en lote: `regimenHorasExtraRepository.js` | Migración idempotente + `test/regimen-horas-extra-repo.test.js` |
| B2 ✅ | Funciones puras (`horasExtraRegimen.js`): recorte por plantilla, mínimo/redondeo, clasificación por tipo de día, topes cronológicos, política de excedente | `test/horas-extra-regimen.test.js` (20 casos, con MARTENSEN, CHINELI y RAMÍREZ) |
| B3 ✅ | Integración en `/attendance-range`: solo los días cubiertos por una política (del régimen de la persona o de la empresa) pasan por el régimen; el resto queda como hoy. Reemplaza solo la parte automática (las cargas manuales quedan igual). Fines de semana y feriados con fichajes se clasifican por tipo de día. Fila: `regimenHorasExtra`; día: `regimen` | Septiembre de la copia de producción (479 empleados, 13.891 días): sin régimen, 0 diferencias; con un régimen para 3, los otros 476 sin diferencias y los 3 con los mismos minutos reales día por día. `test/regimen-horas-extra-mensual.test.js` |
| B4 ✅ | Pantallas: régimen (con modelos por país), asignación por persona, autorización individual, Presentismo (reales / computables / excedente / sin pago), aprobación de excedente | Recorrido completo probado en navegador |
| B4b ✅ | Regímenes **dentro** del convenio (migración `20261007`, tabla `labor_convention_regimes`). Ver la sección de abajo | `test/regimenes-dentro-del-convenio.test.js`; copia de producción sin regímenes: 0 diferencias en 479 empleados |
| B5 | Informe para liquidación: por persona, por recargo, exportable | Coincide con Presentismo al minuto |

## Empresa → convenios → regímenes → persona

Una empresa puede tener **varios convenios**, por ejemplo camioneros y comercio. En Vialidad hay uno solo: al ser parte del Estado, todos están bajo el mismo convenio, pero eso no vale para cualquier empresa ni para cualquier país. Dentro de cada convenio puede haber **regímenes**, que son variantes como "con horas extra" o "solo se registra". Cada persona se encuadra en un convenio y, opcionalmente, en uno de sus regímenes.

Cada regla vale en el nivel **más específico** en que esté cargada: **persona > régimen > convenio > empresa**. La idea es cargar lo común una sola vez, en el convenio, y que el régimen cambie solo lo que es distinto.

- **Topes y excedente** (`overtime_regime_policies.regime_id`): se busca la política del régimen; si no hay, la del convenio; si tampoco, la de la empresa. La autorización individual de una persona reemplaza los topes.
- **Reglas por tipo de día** (`day_type_overtime_rules.regime_id`): se resuelven **por cada tipo de día**. Por ejemplo, un régimen puede cambiar solo el sábado y heredar del convenio el domingo y los feriados.
- **Motor anterior** (`dayTypeRuleResolver`): los pesos son binarios (plantilla 8, convenio 4, régimen 2, empresa 1). Así, la regla de un régimen le gana a la de su convenio sin cambiar el orden entre las reglas que ya existían. Además, la regla de un régimen se aplica solo a quien está en ese régimen.
- Un régimen que está en uso no se borra, se desactiva: borrarlo cambiaría en silencio cómo se liquida a su gente.
- No hay que confundirlo con `employee_convention_assignments.category_id`, que es la **categoría** laboral (el escalafón), otro concepto.

Arreglo encontrado al hacer esto: las reglas de convenio que se cargan desde la pantalla se guardan con `tenant_id` NULL, porque el convenio ya pertenece a la empresa. Por eso el cálculo del régimen (B3) no las leía. Ahora las lee por el convenio.

## Preguntas ya respondidas por el dueño del producto

- El tope de Vialidad es **mensual** (40 h). Otras empresas pueden tener otros.
- El excedente tiene que ser configurable (tal cual / avisar / no computar /
  autorizar).
- Hay regímenes donde sábados y domingos van al 50 % y feriados/domingos al
  100 %, y otros donde lo fuera de horario **no se paga pero se registra**
  (posible "hora de dedicación" a futuro).

## Limitaciones conocidas (a resolver en B5, cierre de mes)

- **Tope anual**: hoy se acumula dentro del período consultado. Para que
  cuente los meses anteriores hace falta guardar el resultado de cada mes
  cerrado (cierre de mes), que es parte del informe de liquidación.

