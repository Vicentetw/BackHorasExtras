# Campaña: cómo la detecta el sistema y cómo la cuenta Presentismo

Última actualización: 2026-09-28.

## El problema que resolvió esto

OLGUIN (AVP, legajo 2555) se fue al campo el 03/08/2026 y volvió el 15/08.
Presentismo lo mostraba **Ausente los 9 días hábiles del medio**. Había dos
fallas encadenadas:

1. **La campaña ni siquiera se detectaba.** La regla anti-rebote del motor de
   marcadores descartaba su segunda lectura (ver más abajo). Medido en
   producción: **79 de 582 salidas a campaña** de 2026 se perdían así.
2. **Presentismo nunca miraba las campañas.** Solo el reporte de Campaña
   (Salidas > Campaña) las conocía. Un día hábil sin fichaje ni licencia
   terminaba siempre en "Ausente".

## Las dos capas

La idea central es **separar el hecho de su interpretación**:

| Capa | Qué responde | Dónde vive |
|---|---|---|
| **Detección** | "Esta persona salió a campaña el X y volvió el Y" | `detectMovements` (motor de marcadores) + `detectarCampanas` en `horasdedica.js` |
| **Interpretación** | "¿Qué significa ese período para el presentismo?" | `/attendance-range`, según `campanaPresentismoModo` de cada empresa |

`detectarCampanas` es **la única fuente** de campañas: la usan el reporte y
Presentismo, así que ya no pueden contradecirse.

## Detección

Una campaña se arma con los marcadores que la empresa configuró como
`CAMPANA` en la pantalla Marcadores (en AVP: 8 = sale, 7 = vuelve). El
marcador no dice de quién es: se le atribuye al próximo fichaje real **del
mismo reloj** dentro de la ventana (`markerMaxGapSeconds`, 6 s en AVP).

Una empresa **sin marcadores CAMPANA** no tiene campañas y `detectarCampanas`
vuelve sin consultar fichajes: no le cuesta nada.

### La regla de rebote refinada

Dos lecturas de la misma persona separadas por 20 s o menos se toman como
una sola acción (rebote del lector). El problema es que la regla original no
miraba qué había pasado **entre** esas dos lecturas. Los 79 casos perdidos
tenían dos formas:

- **Forma A: marcador, lectura, lectura.** La primera lectura abre la campaña
  y la segunda, 3 s después, la **cerraba**: una campaña de 3 segundos.
- **Forma B: lectura, marcador, lectura** (OLGUIN). La segunda lectura se
  tomaba como rebote y **no se quedaba con el marcador**: no se abría nada.

La regla nueva: *dos lecturas cercanas son una sola acción, salvo que entre
ellas se haya apretado un marcador que esté al menos tan cerca de la segunda
como de la primera*. En ese caso es una acción nueva (apretar el marcador y
poner el dedo).

- En la forma A no hay marcador en el medio: el rebote se ignora y no cierra nada.
- En la forma B el marcador está a 6 s de la primera lectura y a 3 s de la
  segunda, así que es de la segunda.
- **SANTIBAÑEZ (18/08/2026)** sigue protegido: su marcador está a 5 s de la
  primera lectura y a 7 s de la segunda, más cerca de la primera.

La validación con datos reales: en los 79 casos la persona tardó **días** en
volver a fichar (entre 58 y 800 horas), que es lo que se espera de alguien
que se fue al campo.

**Se aplica solo a la detección de campañas** (`reboteRefinado: true`). Las
horas extra y las salidas particulares usan el mismo motor, y ahí cambiaría
números de liquidación ya calculados. Extenderlo a esas categorías es una
decisión aparte, que hay que tomar después de medir su impacto.

## Interpretación en Presentismo

Cada empresa elige en **Salidas > Campaña** (`/config/campana-presentismo-modo`):

| Modo | Días hábiles en campaña sin fichar |
|---|---|
| `ignorar` (**default**) | "Ausente", como siempre. Cero cambios. |
| `trabajado` | Suman a "Días trab." y se muestran "⛺ En campaña" |
| `excusado` | Suman a "Excusado" y se muestran "⛺ En campaña" |

Reglas de interpretación (todas probadas en `test/attendance-range-campana.test.js`):

- **Qué días son hábiles lo sigue decidiendo la plantilla del empleado**, no
  el día de la semana. Un sábado de campaña de alguien que trabaja de lunes
  a viernes sigue siendo "Sin jornada": solo se pinta del color de la
  campaña. Con un patrón que incluya el sábado, contaría.
- **El día de salida** cuenta por su fichaje: ese día la persona se
  presentó a su horario. Los días del medio son los *estrictamente entre*
  la salida y el regreso (`diasInterioresDeCampana`), así nada se cuenta
  dos veces.
- **El día de regreso depende de la hora de corte** (Salidas > Campaña,
  `campanaArrivalCutoffTime`, default 09:00). Es el mismo ajuste que ya
  usaba la columna "Días" del reporte, así el reporte y Presentismo cuentan
  con la misma regla (`regresoCuentaComoCampana`):
  - vuelve **a la hora de corte o después** (OLGUIN, 11/09/2026, 20:39): el
    día lo pasó viajando. Cuenta como campaña según el modo y **no se evalúa
    tardanza**. Antes salía "Tarde" por 13 horas;
  - vuelve **antes** (por ejemplo 08:00): llegó a tiempo para trabajar. Es un
    día normal y su fichaje de regreso es su entrada.
- **Una campaña abierta** (sin regreso todavía) cuenta hasta la fecha
  consultada. No se inventa un regreso.
- **Una licencia o excepción cargada a mano gana** sobre la campaña
  detectada, porque es una decisión humana explícita. Si alguna empresa
  necesita el orden inverso, esto tiene que pasar a ser configurable.
- **No se inventan horas**: el día cuenta como trabajado o excusado, pero no
  se le suman minutos trabajados.

### Por qué el reporte y Presentismo cuentan distinto

El reporte de Campaña cuenta **días corridos** (`computeCampanaDias`: del
03/08 al 15/08 son 13). Presentismo cuenta **días hábiles** según la
plantilla (en el mismo período, 9). No es una inconsistencia: miden cosas
distintas. El reporte mide cuánto tiempo estuvo afuera (sirve, por ejemplo,
para viáticos) y Presentismo mide asistencia a la jornada.

## Corregir a mano de quién era un marcador

Pedido del 2026-09-28: "este marcador era de otra persona", dejando registrado
quién lo corrigió y cuándo.

**Dónde:** en Salidas (Particular, Oficial) y en Campaña, cada marcador tiene
un lápiz al lado. Se elige "era de otra persona" (y quién) o "no era de nadie,
se apretó por error", con un motivo obligatorio. Un ícono de persona con
tilde marca los que ya fueron corregidos; desde el mismo lápiz se deshacen.

**Cómo lo aplica el motor** (`detectMovements`, opción
`correccionesMarcadores`):

- "Era de X": el marcador **no entra en la adivinanza**. Queda reservado
  para el próximo fichaje de X, de cualquier reloj, dentro de 10 minutos
  (`VENTANA_MARCADOR_CORREGIDO_MS`). Nadie más se lo puede llevar, y no toca
  el marcador que otra persona tenga pendiente en ese reloj. No le aplica la
  regla de rebote ni la regla AVILA ("primer fichaje del día"): una persona
  ya confirmó de quién era.
- "No era de nadie": el marcador se ignora, como si no se hubiera apretado.
- Si X no fichó en esos 10 minutos, el backend **rechaza** la corrección al
  cargarla, en vez de guardar algo que no cambiaría nada.

**Vale para todo**, no solo para el reporte donde se corrigió: la misma
corrección se aplica en Salidas, Campaña, Presentismo (salida particular y
horas extra) y las campañas de la vista diaria. Es un hecho sobre el
marcador.

**Auditoría:** `marker_corrections` es el estado actual (lo que lee el
motor) y `marker_correction_log` el historial solo-inserción: alta, cambio y
deshacer, con usuario, fecha, motivo, a quién se lo había dado el sistema y
cómo estaba antes. Deshacer borra la corrección pero no el historial.
Migración `20261003_marker_corrections.sql`. Tests:
`test/marcadores-corregidos.test.js` (motor) y
`test/marker-corrections.test.js` (endpoints, auditoría y aislamiento entre
empresas).

## Quién puede llevarse un marcador de campaña ("Afectado a campaña / viajes")

Un marcador de salida a campaña atribuido a alguien de oficina le abre una
campaña de días. Solución en dos piezas (migración `20261004`):

- **Tilde por empleado** `employees.afectado_campana` (ficha del empleado, o
  en lote desde Salidas > Campaña). Por defecto apagada.
- **Ajuste de la empresa** `campanaSoloAfectados` ("Solo detectar campañas de
  empleados afectados"), apagado por defecto. La tilde sola no cambia nada.

Con el ajuste encendido, un empleado sin tilde **no consume** el marcador de
campaña (`soloPuedenConsumir` en `detectMovements`): el marcador sigue
esperando, dentro de su ventana, a quien lo apretó. No es un filtro posterior:
además de sacarle la campaña a quien no correspondía, se la da al que sí.
Una corrección manual gana igual aunque la persona no tenga la tilde.

No se puede encender con nadie marcado (desaparecerían todas las campañas):
lo frena el backend, no solo la pantalla. Para no tildar a mano entre cientos
de legajos, "Ver quiénes salieron a campaña" lista a quienes tuvieron campañas
en los últimos 6 meses (detectadas **sin** el filtro, si no sería circular) y
preselecciona a los de 2 o más; los de 1 sola conviene mirarlos, porque pueden
ser justamente un marcador mal atribuido. Con los datos de AVP (mar-sep 2026):
381 campañas de 29 personas, 23 con 2 o más y 6 con una sola.

Un PUT de empleado que no manda el campo (un cliente viejo, el import) no
borra la tilde. Tests: `test/campana-afectados.test.js` y los de
`soloPuedenConsumir` en `test/marcadores-corregidos.test.js`.

## Qué NO hace todavía (extensiones previstas)

- **Carga manual de una campaña**, para quien se olvidó el marcador. El
  camino previsto es usar el mismo mecanismo de las licencias
  (`employee_events` con un tipo de novedad), con un origen (marcador /
  manual) para evitar duplicados.
- **Una lista de marcadores que nadie se llevó** (el marcador venció porque
  la persona fichó tarde). Hoy solo se puede corregir un marcador que aparece
  en una fila de Salidas o Campaña.
- **Motor Legacy** (`/attendance/:date`, solo para comparar): queda
  congelado a propósito. El motor diario (`/api/labor-engine/attendance/:date`,
  el de la vista diaria) **sí** conoce las campañas desde `a150523`: usa
  `campanaService`, la misma detección que la vista mensual.
- **Ciclos que no siguen la semana** (10x4, 14x7), comisiones y otros
  regímenes. El modelo de "período con tipo" los admite, pero no se
  implementan hasta que alguna empresa los necesite.

## Diagnósticos

- `DIAGNOSTICO_OLGUIN_MARCADORES.sql`: los marcadores que hubo antes de cada
  fichaje de una persona.
- `DIAGNOSTICO_CAMPANA_REBOTE.sql`: cuántas salidas a campaña se perdían por
  mes.
- `DIAGNOSTICO_CAMPANA_REBOTE_DETALLE.sql`: los casos perdidos uno por uno,
  con los datos que definieron la regla nueva.
