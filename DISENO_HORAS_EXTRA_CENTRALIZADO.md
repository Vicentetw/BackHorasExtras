# Horas extra: configuración en un solo lugar (diseño, 2026-10-17)

Estado: **D, A, B y C implementados en la rama `horas-extra-centralizado`**
(backend y frontend), sin publicar. E y F siguen pendientes. Ver "Qué quedó
hecho" al final.

## Pedido del dueño

- Que sirva para cualquier empresa y cualquier reloj, incluidos los de rostro,
  que no tienen teclas de marcador.
- Que el administrador de cada empresa vea y configure todo. Hoy el "modo del
  motor" lo ve solo el superadmin.
- Que esté **centralizado**: no en cinco pantallas.
- Que los marcadores sigan funcionando y que, si el reloj no los tiene, se
  calcule igual.
- No romper nada de lo que ya funciona (AVP).

## Dónde se configura hoy (relevado en el código)

| Qué | Dónde | Quién lo ve |
|---|---|---|
| Corte HE y tope por día | Plantilla (`overtime_cutoff_time`, tope) | admin |
| Qué pasa antes y después del horario (políticas) y modo del motor | Plantilla (`politica_*`, `rules_engine_mode`) | **solo superadmin** |
| Corte general de respaldo (13:40) y tope general | `app_settings` `overtimeCutoffTime` y `overtimeCapMinutes` | nadie (sin pantalla) |
| Quién puede hacer HE: todos o solo autorizados | `app_settings` `overtimeAuthorizationMode` | **nadie** ("consultá con soporte") |
| Autorizado a HE | Empleado (`overtime_authorized`) | admin |
| Mínimo por día | Convenios (empresa) y política del convenio o régimen | admin |
| De dónde salen (marcas, fichajes o ambos) | Política del régimen (`fuente`) | admin |
| Máximos y qué hacer con el excedente | Política del convenio o régimen | admin |
| Recargos por tipo de día | Convenios (`day_type_rules`) | admin |
| Teclas 9 y 10 del reloj y brecha | Marcadores (`specialusers`, `markerMaxGapSeconds`) | admin |
| "Fichó entre 7 y 14" | **escrito en el código** (`overtimeCalculations.js:131`) | nadie |

Problemas:
1. Está repartido en 5 pantallas.
2. Dos opciones clave no tienen pantalla.
3. La `fuente` del régimen solo cambia el informe "Horas Extra por Régimen",
   no Presentismo: es una segunda verdad posible.
4. Sin marcadores, todo es "estimado" y usa la lógica de AVP: salir y volver
   a entrar después del corte, más el "fichó entre 7 y 14".

## Propuesta: una pantalla "Horas extra"

La actual "Convenios, regímenes y horas extra" pasa a llamarse **"Horas
extra"** y se ordena en 3 pasos. Las otras pantallas solo muestran un resumen
y un link "Se configura en Horas extra →".

### Paso 1. Cómo se cuentan
Una fila "Toda la empresa" y, debajo, una fila por plantilla que tenga
excepción. Cada fila tiene:
- **Método:**
  - *Marcas del reloj; si faltan, estimado desde el corte*: lo de hoy,
    **por defecto**, AVP sigue igual.
  - *Marcas del reloj; si faltan, lo que supere el horario*.
  - *Lo que supere el horario*: cualquier reloj, incluidos los de rostro.
- **¿Llegar antes cuenta?** No (por defecto) o sí.
- **Desde qué hora:** el corte. Vacío = la salida de la plantilla.
- **Mínimo de minutos por día:** se mueve acá el de la empresa, con los mismos
  datos guardados.
- **Tope por día:** se mueve acá desde la plantilla.

El orden de prioridad es plantilla, después régimen o convenio, después
empresa. La `fuente` del régimen se muestra en esta misma tabla. Además pasa a
valer también en Presentismo, y eso cambia algo que ya funciona: hay que
pedirle el sí al dueño (punto F).

### Paso 2. Quién puede hacer horas extra
Todos (por defecto) o solo los autorizados en la ficha del empleado. Es la
opción que hoy no tiene pantalla.

### Paso 3. Cuánto y cómo se paga
Máximos, excedente y recargos por tipo de día (convenios y regímenes), como
hoy.

Cada cambio del paso 1 tiene **"Ver qué cambiaría"**: cuántos días, personas y
horas cambiarían el mes anterior, igual que el mínimo.

## Cómo no romper nada
- Todo lo nuevo tiene valor por defecto igual al comportamiento actual. Se
  guarda en `app_settings` y en una columna nueva de la plantilla. Sin la
  migración, todo funciona como hoy.
- "Lo que supere el horario" usa el motor de reglas que ya existe
  (`timeClassifier`), con las políticas armadas a partir de las opciones del
  paso 1. El "modo del superadmin" queda solo para pruebas internas.
- Una sola verdad: el mismo cálculo alimenta Presentismo, el portal,
  Liquidación, Horas Extra por Régimen y Días a revisar.

## Antes de implementar: probar el motor (D)
Nunca se usó como cálculo oficial con datos reales. Prueba con una empresa
sintética, sin datos de AVP:
- horario corrido y partido;
- fichajes repetidos;
- salida particular en el medio;
- turno noche y rotativo;
- franco o feriado trabajado;
- día sin salida.

Riesgo conocido: empareja los fichajes por orden (entrada, salida, entrada…).
Un fichaje de más puede desordenar el día.

## Orden propuesto (cada letra se aprueba por separado)
- **D.** Probar el motor (solo medir).
- **A.** Pantalla "Horas extra" con el paso 1 y el método nuevo, con "Ver qué
  cambiaría".
- **B.** Paso 2 (autorización) visible para el admin.
- **C.** Resúmenes y links en Plantilla, Configuración, Marcadores y la ficha
  del empleado.
- **E.** El "fichó entre 7 y 14" pasa a configuración, con 7 a 14 por
  defecto.
- **F.** (Cambia algo publicado.) Que la `fuente` del régimen también valga
  en Presentismo.

## Qué quedó hecho (2026-10-17, rama `horas-extra-centralizado`)

### D: resultado de la prueba del motor viejo
`timeClassifier` (el motor de reglas) **falló en 5 de 12 casos típicos**:
- almuerzo fichado en un horario corrido;
- rebote del reloj a 1 minuto;
- salida particular en el medio;
- turno noche (tal como el sistema le pasa los fichajes);
- franco trabajado.

Empareja los fichajes por posición, así que un fichaje de más desordena el
día. No se usa para esto.

### Cálculo nuevo: `motor-laboral/services/excesoSobreHorario.js` (puro)
1. Junta las lecturas repetidas (menos de 3 minutos entre una y otra).
2. Con fichajes en número **par**, arma los tramos entrada-salida y cuenta lo
   que cae después del horario (o del "Corte HE" de la plantilla). Si la
   opción está prendida, también lo que cae antes de la entrada.
3. Con fichajes en número **impar** (falta uno), mide del primero al último y
   el día queda "a revisar".
4. Si trabajó **todo el día fuera de su horario**, cuenta pero el día queda "a
   revisar" con el motivo "¿tiene el horario correcto?". Caso real en la copia
   local: una persona con horario de 7 a 14 que hace turnos de 15 a 23.

Pasa los 13 casos de prueba: los 12 de D, más corte, llegada anticipada y
"sale y vuelve".

### Configuración: `motor-laboral/services/configHorasExtra.js`
- **Empresa:** `app_settings` `overtimeMethod` y `overtimeCountEarlyArrival`.
  No necesitan migración. Sin cargar = `MARCAS_O_ESTIMADO`, que es lo de
  siempre.
- **Excepción por plantilla:** tabla `plantilla_horas_extra` (migración
  **20261023**). Sin la migración, la pantalla avisa y todo usa lo de la
  empresa.
- **Mínimo:** plantilla, después convenio o régimen, después empresa.
- Se aplica dentro de `/attendance-range`, el mismo cálculo que usan
  Presentismo, el portal, Liquidación, Horas Extra por Régimen y Días a
  revisar.
- En el informe por régimen, la `fuente` "Solo fichajes" pasa a usar "lo que
  supera el horario" cuando la empresa lo eligió.

### Rutas: `routes/configHorasExtra.js` (`/api/config-horas-extra`)
- `GET /`: config de la empresa, autorización, mínimo, marcadores de horas
  extra configurados y plantillas con su excepción.
- `POST /empresa`: método, llegar antes y autorización. Queda en el registro
  de actividad.
- `PUT /plantillas/:id`: la excepción. Todo vacío = se quita. Valida que la
  plantilla sea de la empresa.
- `GET /impacto`: "Ver qué cambiaría". Compara día por día con el mismo
  cálculo y no guarda nada.

### Pantalla (frontend)
`/convenios-horas-extra` pasa a llamarse **"Horas extra"** y en el menú
**"Horas extra (reglas)"**. Está ordenada en 3 pasos:
1. **Cómo se cuentan:** método, llegar antes, mínimo de la empresa (movido
   acá, mismos datos) y excepciones por plantilla, cada una con "Ver qué
   cambiaría".
2. **Quién puede hacer horas extra:** todos o solo autorizados. Antes no
   tenía pantalla.
3. **Convenios, máximos y recargos**, como antes.

Se actualizaron los textos que mandaban a "Convenios" en Plantilla,
Configuración, Presentismo, Horas Extra por Régimen, la ficha del empleado
(que decía "consultá con soporte") y Inicio.

### Medido en la copia local (empresa 6, septiembre)
"Lo que supera el horario" cambiaría 1569 días de 132 personas (de 2444 h a
2968 h). Es esperable: esa empresa usa las marcas del reloj y muchos
horarios asignados no coinciden con los turnos reales. **No se le cambia
nada**: sigue con su opción de siempre.

### Pendiente
- **E.** "Fichó entre 7 y 14", escrito en el código del estimado (solo afecta
  al método de siempre).
- **F.** Que la `fuente` del régimen valga también en Presentismo. Cambia algo
  publicado.
- **Franco o feriado trabajado** con "lo que supera el horario": hoy solo
  cuenta en el cálculo por régimen (días fuera de jornada), igual que antes.
