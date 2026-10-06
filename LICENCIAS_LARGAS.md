# Licencias largas (gremial y otras) — análisis (2026-10-06)

> Pedido del dueño: "cómo agregar una justificación, por ejemplo una licencia
> gremial, para que no aparezca como ausente, porque suelen durar años".
> **Análisis y propuesta; NADA implementado.** Cada letra espera aprobación.

## Cómo funciona hoy

Hay dos formas de justificar:

| | Licencias (`employee_events`) | Justificaciones / Bajas (`userexclusions`) |
|---|---|---|
| Se guarda | **una fila por licencia** (desde–hasta) | **una fila por día** |
| Pensado para | vacaciones, enfermedad, comisiones | un día o unas horas |
| Para años | ✅ adecuado | ❌ 730 filas por persona cada 2 años |

El cálculo de asistencia (`/attendance-range`, motor diario) toma las
licencias por rango y solo expande los días del período que se mira: una
licencia de 3 años no pesa más que una de 3 días. Esos días salen
**Excusado**, no Ausente. Los motivos son por empresa (Motivos de Ausencia),
con "descuenta vacaciones" y cupos configurables.

**O sea: hoy ya se puede cargar una licencia gremial como Licencia con un
rango de años, y deja de figurar como ausente.** Pero aparecen problemas.

## Problemas encontrados

1. **Fecha de fin obligatoria** (`fecha_hasta NOT NULL`). Una licencia
   gremial suele ser "mientras dure el mandato" o "hasta nuevo aviso": hay que
   inventar una fecha.
2. **Bug: no se ve en la lista de Licencias en los años del medio.** El filtro
   por año es "año de inicio O año de fin" (`routes/employeeEvents.js`): una
   licencia 2025–2028 no aparece al mirar 2026 (sí se aplica en el cálculo).
3. **Avisos falsos todos los días que ficha.** Muchos delegados van algunos
   días. Cada fichaje con licencia cargada genera "fichó teniendo una licencia"
   (`resolverAvisoLicencia`), durante años.
4. **Infla "Excusado".** Una persona en licencia todo el mes suma ~22 días
   excusados: distorsiona el presentismo del área. El encargado necesita verla
   aparte ("en licencia"), no mezclada con justificaciones del día a día.
5. **Nadie avisa cuando termina.** Si la licencia vence y la persona no vuelve
   a fichar, empieza a figurar Ausente sin ninguna alerta.
6. **Sin respaldo documental.** Solo hay un texto de observaciones (no se
   puede adjuntar la nota de la entidad gremial o la resolución).

Lo mismo vale para **otras licencias largas**: cargo electivo o público (LCT
art. 215), reserva de puesto por enfermedad (art. 211), ART, excedencia,
licencia sin goce. El diseño tiene que servir para todas, configurable por
empresa, no solo para "gremial".

Aparte, distinto: el **crédito horario gremial** (horas por mes para tareas
gremiales sin dejar el puesto) es una justificación de horas, no una licencia.

## Propuesta (para aprobar letra por letra)

- **A. Corregir la lista de Licencias** para que muestre toda licencia que
  toque el año elegido (condición de superposición). Es un bug; no cambia
  ningún cálculo.
- **B. Licencias "hasta nuevo aviso"**: fecha de fin opcional (migración:
  `fecha_hasta` admite NULL; el código trata NULL como "sigue vigente"). Se
  cierra cargando la fecha cuando se conoce. Código tolerante a la migración.
- **C. Opciones por motivo** (Motivos de Ausencia, las configura el
  administrador de cada empresa, valor por defecto = lo de hoy):
  - "En Presentismo se muestra como": Excusado (hoy) / **En licencia**
    (aparte: no suma a excusados ni a ausentes).
  - "Puede fichar durante la licencia sin aviso" (delegados que van algunos días).
- **D. Presentismo**: el día dice "En licencia gremial (desde 01/03/2025)";
  el resumen mensual muestra los días "en licencia" aparte.
- **E. Avisos** (sistema de avisos que ya existe): "licencia por vencer en
  30 días" y "licencia vencida y no volvió a fichar".
- **F. (Después)** Adjuntar documentación a una licencia; crédito horario
  gremial.

Orden sugerido: A → B → C+D → E. Antes de C/D, verificar con la copia de
producción que AVP no cambie (por defecto todo sigue como hoy).

## Preguntas para el dueño

1. ~~En AVP, ¿los delegados con licencia gremial van algunos días o no van?~~
   **Respuesta (2026-10-06): con licencia gremial NO fichan.** Los "permisos
   gremiales por salidas" (salir unas horas por tareas gremiales) son otra
   cosa: no son licencia. Consecuencia: la opción "puede fichar durante la
   licencia sin aviso" (letra C) no hace falta para la gremial; al revés, si
   alguien con licencia gremial ficha, el aviso que ya existe es útil (o se
   cargó mal la licencia, o el fichaje es de otro).
2. ~~¿Tienen fecha de fin (fin del mandato) o es "hasta nuevo aviso"?~~
   **Respuesta (2026-10-06): sí tienen fecha de fin**: son períodos de
   mandato que se votan. Consecuencia: la letra B ("hasta nuevo aviso") deja
   de ser necesaria para la gremial y baja de prioridad (puede servir para
   otras licencias, se decide después). Sube la E: al terminar el mandato
   puede haber reelección (se extiende la licencia) o la persona vuelve; si
   nadie lo carga, empieza a figurar Ausente sin aviso.
3. ~~¿Esos días tienen que contar como trabajados para algún premio o
   presentismo?~~ **Respuesta (2026-10-06): probablemente sí, pero depende de
   cada convenio.** Consecuencia: no se decide en el código; es una opción
   más **por motivo** (letra C), que configura el administrador de cada
   empresa: "para premios / presentismo cuenta como: día trabajado / día
   justificado (hoy)". Por defecto, lo de hoy.

## Propuesta ajustada con las respuestas (para aprobar)

- **A. Corregir la lista de Licencias** (bug de los años del medio). Sin
  cambios de cálculo.
- **C. Opciones por motivo**, por defecto = hoy: "En Presentismo se muestra
  como Excusado / En licencia (aparte)" y "Para premios y presentismo cuenta
  como día trabajado / justificado".
- **D. Presentismo**: "En licencia gremial (hasta 30/04/2027)" en el día y
  los días en licencia aparte en el resumen.
- **E. Avisos**: "licencia por vencer en 30 días" (para cargar la
  reelección a tiempo) y "licencia vencida y no volvió a fichar".
- **B** queda en espera (no hace falta para la gremial). **F** después.

Orden: A → C+D → E, verificando cada paso contra la copia de producción.
