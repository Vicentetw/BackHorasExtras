# Guion del video de demostración

Duración objetivo: **4 a 5 minutos**. Se graba con la **Empresa Demo S.A.**,
entrando como su administrador (nunca como superadmin, nunca con AVP).

> **Verificado el 2026-10-13** en una copia local idéntica: los 25 pasos de
> este guion se recorrieron solos en Chrome, en computadora (1366 px) y en
> celular (390 px), sin errores, con PDF y Excel descargando bien.

---

## Antes de grabar (el mismo día)

1. **Actualizar la Demo** con tus fichajes copiados (con las variables de
   producción, como `run-sql.js`):
   ```powershell
   node scripts/crear-empresa-demo.js --copiar-legajo 2525 --empresa-origen 6 --como "MÉNDEZ, Martín"
   ```
   Deja fichajes desde el 1/1 hasta hoy: 24 empleados inventados (llegadas
   tarde, ausencias, horas extra, salidas particulares y oficiales, dos
   personas con campañas: TOLEDO de 4 días y URQUIZA de 18) + MÉNDEZ, Martín
   (tus fichajes reales con nombre inventado).
2. **Borrar las empresas de prueba** "prueba2" y "Nueva de prueba" (Empresas).
3. **Usuario de la Demo:** si no existe, crearlo en Usuarios y Roles
   (empresa Empresa Demo S.A., rol Administrador de Empresa), con un alias
   tipo `perrottavicente+demo@gmail.com`.
4. *(Opcional)* Como superadmin, en Empresas → Empresa Demo → tildar
   **"Adicionales de campaña"** para mostrar las noches y la Dedicación
   Funcional Exclusiva.
5. **Despertar el servidor:** abrir el sistema 5 minutos antes (el plan
   gratuito de Render tarda ~1 minuto en arrancar si estuvo dormido).
6. Navegador limpio (sin pestañas ni favoritos a la vista), zoom 100 %,
   ventana grande. Cerrar notificaciones de la PC.

---

## Escenas

| # | Pantalla | Qué hacer | Qué decir (idea) | Tiempo |
|---|---|---|---|---|
| 1 | **Login → Inicio** | Entrar. Mostrar la guía "Puesta en marcha" | "Al entrar, el sistema te guía paso a paso para dejarlo andando." | 20 s |
| 2 | **Presentismo – Diario** | Elegir un día de la semana pasada con llegadas tarde (las tarjetas de arriba muestran cuántas). Señalar los relojes "actualizado hace…" | "Los relojes se sincronizan solos. Cada mañana ves quién llegó a tiempo, tarde o faltó." | 30 s |
| 3 | Presentismo – detalle de fichajes | Mostrar la columna "Detalle fichajes" de alguien con horas extra | "El sistema entiende los botones del reloj: entrada, salida particular, inicio y fin de horas extra." | 20 s |
| 4 | **Justificar una llegada tarde** | En una fila "Tarde" → Justificar. Mostrar que viene sin "día completo" y con la hora de llegada. Elegir motivo, escribir razón, guardar | "Justificar es un clic. Queda registrado quién lo hizo y por qué." | 30 s |
| 5 | **Presentismo – Mensual** | Septiembre. Buscar "MÉNDEZ" → Detalle (calendario) | "Por persona, el mes de un vistazo: trabajados, faltas, licencias, horas extra." | 30 s |
| 6 | Exportar | Botón **PDF** y **Excel** del mensual | "Todo se exporta para liquidar sueldos." | 15 s |
| 7 | **Presentismo – Anual** | 2026, avisos ("faltas seguidas") | "Los avisos te marcan lo que hay que mirar primero." | 15 s |
| 8 | **Salidas – Particular** | Mes septiembre → Buscar. Mostrar "Sin regreso" y el tope mensual | "Salidas personales con su tope de horas por mes." | 20 s |
| 9 | Salidas – Oficial | Lo mismo | "Trámites de la empresa, aparte." | 10 s |
| 10 | **Salidas – Campaña** | Desde 01/08 hasta hoy. TOLEDO y URQUIZA. *(Si el módulo está prendido: tabla de noches y "Dedicación funcional" de URQUIZA)* | "El trabajo de campo de varios días se detecta solo: días, noches fuera y lo que corresponde por convenio." | 30 s |
| 11 | **Horas Extra por Régimen** | Mes actual | "Horas extra según el convenio y el régimen de cada uno, con topes." | 20 s |
| 12 | **Liquidación y cierre de mes** | Mostrar el cierre | "Al cerrar el mes, los números quedan fijos para sueldos." | 20 s |
| 13 | **Plantillas de horario** → **Nuevo horario** | Abrir el asistente, mostrar corrido/cortado y rotativo. Cerrar sin guardar | "Armar un horario, incluso rotativo, es contestar tres preguntas." | 25 s |
| 14 | **Usuarios y Roles** → **Registro de actividad** | Mostrar roles y el registro | "Cada persona ve lo que le corresponde, y todo cambio queda registrado." | 20 s |
| 15 | Cierre | Volver a Inicio | "Horas Dedica: asistencia, salidas y horas extra, sin planillas." | 10 s |

Total ≈ 4 min 35 s.

---

## Lo que NO hay que mostrar

- Pantallas de superadmin (Empresas, Facturación, Planes, Seguridad).
- AVP ni ningún dato real con nombre (MÉNDEZ, Martín es inventado).
- La consola del navegador o la barra de direcciones con `localhost`.

## Si algo no se ve como en el guion

- **Todo vacío o "cargando" largo:** el servidor estaba dormido; esperar y recargar.
- **MÉNDEZ con "faltas seguidas" al final:** sus fichajes llegan con la
  sincronización del reloj de AVP; correr el paso 1 después de que sincronice.
- **Campaña sin URQUIZA:** su campaña de 18 días puede haber terminado antes
  del rango; ampliar "Desde".
