# Ficha: horas extra de quien no está habilitado (2026-10-29)

> Pedido del dueño: "si me olvidé de tildar a alguien y hace 30 h extra, no
> me entero". Sin avisos por 5 o 10 minutos. El tilde de la ficha y la pantalla
> nueva tienen que mostrar siempre lo mismo. **Solo análisis: no se cambió
> nada.** Todo lo de "Hoy" está verificado en el código. Los números de AVP
> **no** sirven de referencia: su lista de autorizados no está al día.

## Hoy (verificado)

**1. Un solo dato, tres lugares.** El dato es la columna
`employees.overtime_authorized`. Los tres lugares lo leen o lo escriben
directamente, así que no se pueden contradecir:

| Dónde | Qué hace |
|---|---|
| Empleados → editar → tilde "Autorizado a hacer horas extras" | Lo cambia de a una persona (`employee-dialog.ts`, `routes/employees.js`) |
| Horas extra → paso 2 → "Elegir quiénes" | Lo cambia para muchas personas juntas (`PUT /autorizados`, `routes/configHorasExtra.js`). El mismo diálogo aclara que es el mismo tilde de la ficha |
| Presentismo → filtro "Solo autorizados" | Solo lo lee |

Campaña usa el mismo esquema. El tilde "Afectado a campaña" de la ficha y la
caja de afectados de Salidas → Campaña escriben la misma columna,
`afectado_campana`. Editar la ficha conserva ese valor si no llega
(`COALESCE`, `routes/employees.js:584`). **Lo de campaña no se toca en esta
propuesta.**

**2. Cuándo tiene efecto.** Solo si la empresa eligió "Solo las personas
autorizadas" en Horas extra → paso 2 (`overtimeAuthorizationMode = 'custom'`).
Con "Todas las personas", el tilde no cambia nada y la ficha lo dice.

**3. Qué hace el cálculo.** En el único cálculo (`horasdedica.js:4626` y
`:4726`), las horas extra del día **se calculan y después se ponen en 0** si
la persona no está habilitada. Las horas cargadas a mano sí cuentan. Como es
el único cálculo, da lo mismo en Presentismo, el detalle, Liquidación, el
régimen y el portal.

**4. Qué no se ve.** En Presentismo, el detalle y Liquidación, la persona
figura con **0 horas extra**. No se ve que no está habilitada ni cuánto se
descartó.

**5. Lo que ya existe y casi sirve.** En el paso 2 está "Ver qué cambiaría"
(`GET /impacto`), con la marca "perdería X h" por persona. Tiene dos límites:
- Aparece **solo mientras se elige otra opción** antes de guardar. Una vez
  guardado "Solo las personas autorizadas", nadie vuelve a ver lo descartado.
- La lista completa por persona incluye solo a quien **perdería** horas, no a
  quien las está perdiendo hoy.

**6. La habilitación no tiene fecha.** Habilitar a alguien hoy le cuenta horas
extra en **todos los meses abiertos**, también los anteriores. Falta verificar
cómo lo muestran los meses cerrados: los cierres congelan las horas extra,
pero queda por medir si lo nuevo aparece como ajuste.

## Propuesta (aditiva, por letras)

**H1. El cálculo informa lo descartado.** El mismo cálculo agrega un dato
nuevo: las horas extra de quien no está habilitado, por día y por mes. Se
calculan igual que las de un habilitado (mismo recorte de plantilla y mismo
mínimo), en los dos caminos del cálculo (el actual y el motor nuevo).
- **Ningún número existente cambia.**
- Prueba: ese dato tiene que dar igual que la diferencia de "Ver qué
  cambiaría". El test "una sola verdad" tiene que seguir igual.

**H2. Tope mensual del aviso, por empresa.** Por ejemplo, "avisar si suma más
de 2 h en el mes". Se configura en Horas extra → paso 2. Así nunca avisa por
5 o 10 minutos. Va en `app_settings`, sin migración.

**H3. Bloque en Liquidación y cierre de mes.** Antes de cerrar: "Hicieron
horas extra sin estar habilitados (no se pagan)".
- Solo quien supera el tope, de mayor a menor.
- Botón **"Habilitar"**: usa el `PUT /autorizados` que ya existe, así que la
  ficha muestra el cambio al instante. La confirmación avisa que cuenta para
  todos los meses abiertos.
- En esta primera versión **no** hay botón "Está bien así": necesitaría una
  tabla nueva. El tope ya filtra el ruido.

**H4. Marcas donde ya se mira a la persona.**
- En Presentismo, una marca "sin habilitar: X h" en la fila (solo si supera el
  tope).
- En el detalle, en el día: "N min de horas extra no se cuentan: no está
  habilitado".
- En la ficha, al lado del tilde: "Este mes hizo X h que no se cuentan".

**H5. Inicio.** Un aviso: "N personas hicieron horas extra sin estar
habilitadas" que lleva a H3.

**H6 (aparte, no ahora). Habilitación con fecha.** "Habilitado desde…", con el
mismo patrón de vigencias que convenios y plantillas. Necesita una migración
y cambia los meses pasados: se decide aparte.

Orden: H1 → H2 → H3 → H4 → H5. Cada una se aprueba y se prueba sola.

## Qué no cambia

- Lo que se paga.
- El tilde de la ficha, "Elegir quiénes", el filtro "Solo autorizados" y
  campaña.
- Con "Todas las personas", nada de esto aparece: nadie descarta horas.

## Riesgos y pruebas

- **H1:** el riesgo es tocar sin querer el número oficial. Se prueba con la
  suite completa, "una sola verdad" y una comparación del mes entero en la
  copia, antes y después: tiene que dar idéntico.
- **H3/H4:** son solo pantalla. Se prueban con el navegador sobre la empresa
  demo, con una persona no habilitada que hace horas.
- **Antes de H3,** verificar cómo se ve un mes cerrado después de habilitar a
  alguien (punto 6).
