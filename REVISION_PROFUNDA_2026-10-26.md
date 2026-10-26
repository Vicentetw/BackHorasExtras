# Revisión profunda: qué simplificar, qué mejorar y qué estética cambiar (2026-10-26)

> Pedido del dueño: "revisa en forma muy profunda y no hagas ningún cambio
> antes de preguntar". **Hechos y publicados (26/10): H, G y J.** El resto
> espera aprobación. Cada punto lleva letra para
> aprobarlo por separado. Medido sobre el código de `main` y capturas de la
> app local (empresa 6) en computadora (1366 px) y celular (390 px).

## 1. Lo más importante: dos cálculos para el mismo día

| Pantalla | Qué calcula | Código |
|---|---|---|
| Presentismo **diario** | estado del día (a tiempo, tarde, ausente) | `motor-laboral/services/attendanceService.js` (770 líneas) vía `/api/labor-engine/attendance/:date` |
| Presentismo **mensual/anual**, detalle, Horas extra, Liquidación, portal | lo mismo, más horas extra | `/attendance-range` (`attendanceRangeHandler`, **2.076 líneas** dentro de `horasdedica.js`) |

Son **dos implementaciones** de "cómo estuvo esta persona este día". Se
mantienen iguales a mano (los comentarios lo dicen: "mismo criterio que el
motor diario"). Cada regla nueva hay que escribirla dos veces; si una se
olvida, el diario y el mensual dicen cosas distintas (va contra "una sola
verdad"). Además quedan, solo "para comparar": el cálculo viejo
`/attendance/:date`, `/attendance/:date/compare`, y el "motor de reglas nuevo"
con modos `legacy/shadow/active` por plantilla (lo cambia solo el superadmin;
todas las plantillas de AVP están en `legacy`).

**A.** Que el diario salga del mismo `/attendance-range` (un día = rango de un
día) y retirar el motor diario, el viejo y la comparación. Es el cambio con
más valor y más riesgo: se hace en rama, comparando día por día el antes y el
después sobre la copia de producción, y se publica solo con 0 diferencias
explicadas.

**B.** Partir `horasdedica.js` (6.773 líneas, 83 rutas) en archivos por tema
(asistencia, salidas, configuración, importación), **sin cambiar
comportamiento**. Hoy es el archivo que más cuesta tocar sin romper algo.

**C.** Unificar ayudantes repetidos: `formatLocalDate` y `nextDayStr` están
definidos 4 veces, `timeToMinutes` y `extractTime` 3 veces.

## 2. Configuraciones duplicadas o que confunden

**D. Dos "horarios por defecto".** Configuración General tiene "Horario por
defecto 07:00–13:40", y además hay una plantilla marcada "por defecto"
(Administración en AVP). Si existe la plantilla, el de Configuración **no se
usa**, pero sigue editable: parece que anda y no hace nada (el mismo problema
que ya se corrigió con los "modos" de plantilla). Propuesta: que Configuración
muestre la plantilla por defecto y lleve a ella; el horario suelto queda solo
para una empresa sin plantillas.

**E. Límites en dos lugares.** "Límite de licencia personal" se edita en
Configuración General y el de salidas particulares en Salidas. La pantalla
única "Llegadas tarde y salidas" está hecha en la rama
`justificaciones-y-limites` (pausada para la etapa E4). Retomarla.

**F. Dos pantallas de horas extra para pagar.** "Horas Extra por Régimen" y
"Liquidación y cierre de mes" muestran lo mismo agrupado distinto. En
Liquidación, sin régimen configurado, 4 columnas quedan vacías (A mano,
Excedente, Pendiente, Dedicación) y cada fila dice "sin régimen". Propuesta:
una sola pantalla "Liquidación de horas extra" que muestre las columnas de
régimen **solo si la empresa usa régimen**.

## 3. Menú

Hoy: 11 opciones arriba + 12 en "Administración" (+8 de superadmin). El
orden no sigue el uso: lo que se configura una vez (Marcadores, Matching,
Importar Fichajes) está arriba, y lo de todos los días (Justificaciones,
Licencias, Saldos de vacaciones) está escondido en Administración. Además se
muestran opciones a quien no tiene permiso (el guard lo frena recién al
hacer clic).

**G.** Menú por tarea, en 4 grupos:
- **Día a día:** Inicio, Presentismo, Salidas, Cargar ausencia /
  Justificaciones, Licencias, Saldos de vacaciones.
- **Horas extra y pago:** Liquidación (con régimen adentro, ver F), Horas
  extra (reglas).
- **Personas y horarios:** Empleados, Horarios de empleados, Plantillas,
  Feriados, Motivos.
- **Configuración (se usa poco):** Importar fichajes, Matching (→ "Vincular
  reloj y empleados"), Marcadores, Configuración General, Usuarios, Registro
  de actividad, Portal.
Y ocultar lo que la persona no puede abrir.

## 4. Textos y palabras

**H.** Vocabulario que quedó viejo o técnico:
- Presentismo diario dice **"Excusado"**; el detalle y el portal dicen
  **"Justificado"** (se unificó el 15/10, faltó este).
- Empleados: "Matcheados", "Sin Match", y la ayuda dice "los fichajes se
  importan desde el **Dashboard**" (ya no existe). Propuesta: "Vinculados
  con el reloj", "Sin vincular", "desde Importar fichajes".
- "Bajas y Exclusiones" → ¿"Excluidos de informes"? (verificar qué hace hoy).
- Títulos con mayúsculas mezcladas ("Importar Fichajes", "Plantillas de
  Horario") → una sola regla: solo la primera palabra.

**I. Marca.** La app dice **"Sistema de Asistencia"** (login, menú, pie
"© 2026 Sistema de Asistencia"), y el producto se llama **Horas Dedica**.
Poner el nombre y un logo propio.

## 5. Estética (capturas en `scratchpad/estetica/`, no en el repo)

**J. Menú lateral más liviano.** Hoy es un bloque azul fuerte de 248 px con
cada opción en una "pastilla": pesa más que el contenido. Propuesta: fondo
claro (el mismo gris del sistema), ícono + texto en gris oscuro, la opción
activa marcada con el color principal. Ocupa lo mismo y deja respirar las
tablas.

**K. Tablas más limpias.**
- Presentismo diario: columnas "Fichajes" (un número) y "Detalle fichajes"
  dicen casi lo mismo; "Justificar" + ⋮ en cada fila: un solo menú de
  acciones por fila.
- Empleados: por defecto muestra **también los inactivos** y con avisos en
  rojo ("Sin asignar", "Sin horario propio") que no importan para un
  inactivo. Propuesta: filtro por defecto "Activos" y avisos solo para
  activos. Las acciones (Editar, Fichajes, Eliminar) ocupan 3 renglones por
  fila: pasarlas a íconos o a un menú.
- Liquidación: ver F (columnas vacías).

**L. Tarjetas de números arriba de cada pantalla.** Presentismo, Empleados y
Liquidación usan cajas distintas para lo mismo. Un solo estilo (número grande,
etiqueta corta, color solo si hay algo que mirar). En Empleados, 6 cajas
(Total, Activos, Matcheados, Sin Match, sin ciudad, sin horario) mezclan datos
de inventario con alertas: dejar 3 (Activos, Para revisar, Inactivos) y que
"Para revisar" abra la lista filtrada.

**M. Celular.** Presentismo en el celular ya está bien adaptado (tarjetas por
persona). Lo que estorba: los avisos de relojes ocupan 2 renglones arriba de
todo y las 6 cajas de números empujan la lista hacia abajo. Propuesta:
números en una fila deslizable y los avisos en un solo renglón.

## 6. Limpieza de la carpeta del backend

**N.** En la raíz hay 17 archivos `.sql` sueltos de diagnósticos y arreglos
puntuales (varios sin subir a git) y `medir8.tmp.js`. Moverlos a
`diagnosticos/` (o borrarlos los que ya se aplicaron) para que la raíz tenga
solo lo que corre.

## 7. Lo que está bien y no tocaría

Inicio con la puesta en marcha paso a paso; el formulario único "Cargar
ausencia"; la ventana de fichajes de una persona; la ayuda (?) en cada
concepto; Presentismo en el celular; 157 archivos de test (1.180 casos).

## 8. Roles (probado el 26/10, sin cambios)

Prueba real en la base local, empresa 6: un usuario por rol (Administrador,
Solo lectura, RRHH, Feriados) entra, recorre el menú y prueba las 27
pantallas por URL directa.

**Funciona bien:**
- Cada rol ve en el menú exactamente lo que puede abrir.
- Lo demás va a "No tenés permiso".
- Ninguna pantalla recibe rechazos del servidor a medias (respuestas 403).
- No hay errores de JavaScript.
- Solo lectura no ve botones de crear, editar ni borrar.
- Las pantallas de plataforma quedan cerradas para todos.

Script: `scratchpad/qa_roles.js`.

**Lo que falta (diseño, no errores):**

**O. La empresa no puede armar sus roles.** Los roles son de toda la
plataforma y solo el superadmin los crea (`routes/roles.js`). Va contra
"el administrador configura todo lo de su empresa". Además, un rol
personalizado (hoy existe "lector") lo ven en la lista todas las empresas.
Propuesta: roles por empresa (`tenant_id`). Los 4 de sistema siguen globales.

**P. Cerrar el mes sin ser administrador (prioridad baja).** Ver
Liquidación con `attendance:read` está bien: el sistema muestra horas, no
dinero (corrección del dueño, 26/10). Lo único que falta: cerrar el mes y
autorizar horas extra piden `attendance:update`, y entre los roles de
sistema solo lo tiene el Administrador. Un permiso propio para esas dos
acciones permitiría un rol "Liquidación".

**Roles propuestos (charla del 26/10, sin aprobar):**
- Administrador.
- Encargado de presentismo: justifica, carga licencias, fichajes a mano y
  feriados. Absorbe al rol "Feriados" suelto.
- Liquidación: autoriza horas extra y cierra el mes (necesita P).
- Supervisor de sector: solo su gente (necesita Q).
- Solo lectura.
- Empleado (portal).

Antes de cambiar nada: ver cuántos usuarios tienen cada rol en producción.

**Q. No hay "encargado de un sector".** Los permisos valen para toda la
empresa. Un supervisor que solo debería ver a su gente ve a todos. Para
empresas grandes (5000 empleados) es lo que van a pedir. Propuesta: limitar
un usuario a un sector o ciudad.

## Orden recomendado

H e I (textos y marca: cero riesgo, se nota mucho) → G y J (menú) → K, L, M
(tablas y números) → D, E, F (configuraciones duplicadas) → N → B y C (ordenar
código) → A (un solo cálculo, el más delicado, con comparación sobre la copia
de producción).
