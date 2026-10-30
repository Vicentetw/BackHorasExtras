# Guion del video de demostración

**Versión 2 (2026-10-30).** Reemplaza la del 2026-10-13: suma lo que se agregó
después (fichajes de cada persona, días a revisar, horas extra sin habilitar,
cierre con ajustes, roles por áreas, ayuda en cada pantalla, temas, portal).

Duración objetivo: **6 a 7 minutos**. Lo que hay que transmitir (Plan listo
para vender, 5.6): **un solo número** (todas las pantallas dicen lo mismo),
**cada número se explica**, **lo dudoso se marca para revisar**, **el cierre
del mes no se pierde** y **cada persona ve lo suyo**.

El nombre del producto que se dice en el video queda a confirmar por el
dueño (hoy: "Horas Dedica"). **Ojo:** arriba a la izquierda el sistema dice
"Sistema de Asistencia" (`core/shell/shell.html`): si la marca cambia, hay
que cambiar ese texto antes de grabar.

---

## ¿Con la Demo o con AVP?

**Recomendado: con la Empresa Demo**, entrando como su administrador.

- La Demo tiene 24 personas inventadas y, si se corre el paso 1, a
  **MÉNDEZ, Martín**: los fichajes reales del dueño con un nombre inventado.
  Se ve real y no expone a nadie.
- Con AVP hay nombres de personas reales en casi todas las pantallas
  (tablas, ventanas, buscadores, avisos, PDF y Excel). Taparlos cuadro por
  cuadro es mucho trabajo y un solo cuadro que se escape publica datos
  personales de terceros (Ley 25.326), además de datos de un cliente que no
  dio permiso. Si igual se usa AVP: grabar solo pantallas de una persona
  (el dueño), sin listas, y revisar el video entero cuadro por cuadro antes de
  publicarlo.

---

## Antes de grabar (el mismo día)

Verificado en la copia de seguridad de producción del 29/10: la Demo existe
(24 empleados) pero **sus fichajes terminan el 09/10** y **no tiene usuario**.

1. **Actualizar la Demo** (escribe en producción: lo corre el dueño, con las
   variables de producción, como `run-sql.js`):
   ```powershell
   node scripts/crear-empresa-demo.js --copiar-legajo 2525 --empresa-origen 6 --como "MÉNDEZ, Martín"
   ```
   Deja fichajes desde el 1/1 hasta hoy.
2. **Usuario de la Demo:** como superadmin, en Usuarios y roles, crear uno
   para "Empresa Demo S.A." con el rol **Administrador de Empresa** (un alias
   tipo `perrottavicente+demo@gmail.com`).
3. *(Opcional)* Como superadmin, en Empresas → Empresa Demo:
   - prender **"Adicionales de campaña"** (escena 9);
   - prender el **Portal del empleado** (escena 15).
4. **Recorrido automático en la copia local** (ver "Cómo se prueba antes")
   para saber que ninguna pantalla del guion da error.
5. **Despertar el servidor:** abrir el sistema 5 minutos antes (el plan
   gratuito de Render tarda ~1 minuto en arrancar si estuvo dormido).
6. Navegador limpio, zoom 100 %, ventana grande, notificaciones de la PC
   apagadas. Tema verde (el de siempre).

**No grabar el día de HOY en Presentismo – Diario:** el turno que todavía no
empezó figura "Ausente" (error conocido, sin arreglar). Usar un día de la
semana pasada.

---

## Escenas

| # | Pantalla | Qué hacer | Qué decir (idea) | Tiempo |
|---|---|---|---|---|
| 1 | **Inicio** | Entrar. Mostrar la "Puesta en marcha" con el avance y el botón **?** (tutoriales) | "Al entrar, el sistema te dice qué falta configurar y te enseña cada pantalla." | 25 s |
| 2 | **Presentismo – Diario** | Un día de la semana pasada. Las tarjetas de arriba (a tiempo, tarde, ausentes) y "relojes actualizados hace…" | "Los relojes se sincronizan solos. Cada mañana sabés quién llegó, quién llegó tarde y quién faltó." | 30 s |
| 3 | **Justificar** | En una fila "Tarde" → Justificar: motivo y razón. Guardar | "Justificar es un clic, y queda registrado quién lo hizo y por qué." | 25 s |
| 4 | **Presentismo – Mensual** | Mes pasado. Buscar "MÉNDEZ" → **Detalle** (calendario del mes) | "El mes de cada persona de un vistazo: trabajados, faltas, licencias, horas extra." | 30 s |
| 5 | **Detalle → Ver todos los fichajes** | Abrir la pestaña de fichajes de MÉNDEZ: cada fichaje dice qué es (entrada, salida particular, inicio de horas extra) y qué marcador tenía | "Cada número se explica: ves cada fichaje y por qué el sistema lo tomó así." | 35 s |
| 6 | **Detalle → Días a revisar** | Bajar a "Días a revisar" | "Lo dudoso no se esconde: el sistema te marca qué días mirar." | 20 s |
| 7 | **Presentismo – Mensual: exportar** | **PDF** y **Excel** | "Todo se exporta para sueldos." | 15 s |
| 8 | **Salidas – Particular** | Período **Mes** (abre en "Día" de hoy, que suele estar vacío) → mes pasado → Buscar. Tope mensual y "sin regreso" | "Las salidas personales, con su tope de horas por mes. Si la empresa lo pide, se autorizan." | 25 s |
| 9 | **Salidas – Campaña** | Desde el 01/08. TOLEDO y URQUIZA (si está prendido: noches fuera y "Dedicación funcional") | "El trabajo de campo de varios días se detecta solo, con lo que corresponde por convenio." | 25 s |
| 10 | *(Solo si la empresa paga horas extra solo a habilitados)* **Presentismo – Mensual → Más filtros → "Ver horas extra sin habilitar"** | Tocar el botón. En la Demo no aparece: hay que poner antes "solo habilitados" en Reglas de horas extra (paso 2) | "Si alguien hace horas extra sin estar habilitado, te enterás antes de pagar." | 20 s |
| 11 | **Horas extra por régimen** | Mes actual | "Horas extra según el convenio y el régimen de cada uno, con sus topes." | 20 s |
| 12 | **Liquidación y cierre de mes** | Mostrar un mes y el cierre. Señalar "ajustes de meses anteriores" | "Al cerrar, lo pagado queda fijo. Si después se corrige algo, la diferencia se paga sola el mes siguiente. Y todas las pantallas dan el mismo número." | 35 s |
| 13 | **Plantillas de horario → Nuevo horario** | Abrir el asistente (corrido, cortado, rotativo). Cerrar sin guardar | "Armar un horario, incluso rotativo, es contestar tres preguntas." | 25 s |
| 14 | **Usuarios y roles** | Roles (Encargado de presentismo, Liquidación) y áreas de un supervisor. Después **Registro de actividad** | "Cada uno ve lo que le toca: un supervisor, solo su gente. Y todo cambio queda registrado." | 30 s |
| 15 | *(Opcional)* **Portal del empleado** | Mostrar la pantalla de administración del portal | "Cada empleado puede ver su propia asistencia desde el celular." | 15 s |
| 16 | **Celular** | Achicar la ventana o mostrar el celular: Inicio y Presentismo | "Funciona igual en el celular." | 15 s |
| 17 | **Cierre** | Volver a Inicio | "Asistencia, salidas y horas extra, sin planillas y con un solo número." | 10 s |

Total ≈ 6 min 30 s (sin la 15).

---

## Lo que NO hay que mostrar

- Pantallas de superadmin (Empresas, Facturación, Planes, Seguridad,
  Solicitudes de alta).
- AVP ni ningún dato real con nombre (MÉNDEZ, Martín es inventado).
- La consola del navegador o la barra de direcciones con `localhost`.
- El día de hoy en Presentismo – Diario (ver arriba).

## Si algo no se ve como en el guion

- **Todo vacío o "cargando" largo:** el servidor estaba dormido; esperar y recargar.
- **Los últimos días salen todos "Ausente":** la Demo no se actualizó (paso 1).
- **MÉNDEZ con "faltas seguidas" al final:** sus fichajes llegan con la
  sincronización del reloj de AVP; correr el paso 1 después de que sincronice.
- **Campaña sin URQUIZA:** su campaña de 18 días puede haber terminado antes
  del rango; ampliar "Desde".

---

## Cómo se prueba antes (recorrido automático)

Un programa abre Chrome **sin ventana** contra la copia local (backend local +
`ng serve`), entra como el administrador de la Demo local y recorre las
escenas del guion, en computadora (1366 px) y en celular (390 px). En cada una
anota:

- si la pantalla tardó o quedó vacía;
- los errores del navegador (los que se verían en la consola);
- cualquier pedido al servidor que falló;
- si la página se sale de la pantalla (barra horizontal en el celular);
- una captura, para mirar antes de grabar.

No guarda nada en la base salvo lo que hace una escena (justificar), y eso
es en la copia local. El resultado es una lista "escena → bien / problema" y
una carpeta de capturas. Si algo falla, se arregla antes de grabar.

**Primera corrida (2026-10-30, Demo local actualizada al 30/10):** escenas 1
a 6, 9, 11, 12, 13 y 17 bien en PC y celular, sin errores del navegador ni
del servidor y sin salirse de la pantalla. Lo demás no es error del sistema:
Salidas abre en "Día" (escena 8 ajustada), el botón de la escena 10 solo
existe en modo "solo habilitados", el Portal (15) está apagado para la Demo,
y las descargas de PDF/Excel no se pueden capturar sin ventana (el 13/10 se
verificaron a mano). Script: `recorrido_video.js` (scratchpad de la sesión).
