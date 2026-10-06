# Estado del proyecto — Horas Dedica

> ## ⏩ EMPEZÁ ACÁ (actualizado 2026-10-03)
>
> **Si sos una sesión nueva: leé este bloque entero antes de tocar nada.**
> (`CLAUDE.md`, en la raíz de este repo, lo carga Claude Code solo al empezar
> y manda acá. Si vas a tocar Presentismo, Salidas, horas extra o el portal:
> leé también `MARCADORES_Y_SALIDAS.md`.)
> Las conversaciones se cortan y la siguiente no sabe en qué estábamos. Este
> bloque es la memoria del proyecto. **Regla del dueño: al terminar cada
> bloque de trabajo se actualiza acá** el estado, las metas y la bitácora.
>
> ### En qué carpeta se trabaja
>
> ```
> C:\angular\horasdedicacion-back-deploy\BackHorasExtras        ← BACKEND. Todo acá.
> C:\angular\horasDedicacionOnlineAngular\horas-dedica-angular  ← FRONTEND Angular
> C:\angular\horas-dedica-landing                               ← LANDING aparte (repo landing-horas-dedica)
> C:\angular\horas-dedica-db-backup                             ← respaldo diario de la base (repo privado)
> C:\angular\horasDedicacionOnline                              ← OBSOLETO, no usar
> ```
>
> El último es el monorepo viejo (`horas-dedica-completo`). **Suele ser el
> directorio por defecto de la sesión**, así que el `git status` inicial
> muestra SUS archivos aunque el trabajo real sea en los otros. No portarle
> nada.
>
> ### Cómo se despliega
>
> | | |
> |---|---|
> | Backend | `git push origin main` → Render despliega solo. Verificar con `https://academypruebadep.onrender.com/health` (devuelve la versión) |
> | Frontend | `git push origin main` + **`npm run deploy:live`** (no es automático) |
> | Landing aparte | `git push` en `horas-dedica-landing` |
> | Migraciones | **Las corre el dueño a mano** (phpMyAdmin de Clever Cloud, o `node run-sql.js` desde su PC). NO desde GitHub Actions: el repo es público y no se guardan credenciales ahí |
>
> Como Render publica antes de que se corra la migración, **todo código nuevo
> tiene que funcionar también sin la migración** (leer NULL si falta una
> columna, responder 503 claro en lo nuevo). Ya rompimos esto una vez.
>
> ### Reglas de trabajo que pidió el dueño
>
> 1. **No cambiar nada que ya funciona en producción sin preguntar.** Listar
>    cada cambio (A, B, C…) y esperar el sí. Lo nuevo y aditivo sí se puede.
> 2. **Lo grande va en una rama aparte** y se une a `main` cuando lo aprueba.
> 3. **Todo módulo nuevo nace apagado** y lo habilita el superadmin por
>    empresa (`motor-laboral/services/modulos.js`): se paga por lo que se usa.
> 4. **Dejar todo probado**, y decir qué NO se pudo probar.
> 5. **Explicar el por qué**, no solo el qué: el dueño está aprendiendo.
> 6. Diseñar para 5000 empleados: cálculos en lote, listas con filtro.
> 7. La base de pruebas es el contenedor Docker `mysql_local` (puerto 3307).
>    Si cientos de tests fallan de golpe, es que Docker está caído.
> 8. Si hay cambios sin commitear que no son tuyos (otra sesión), no los
>    mezcles ni los publiques: apartalos, hacé lo tuyo y devolvelos.
>
> ### Estado al 2026-10-03
>
> - Backend en producción: (ver git log). **894/894 tests.**
> - Frontend en producción: `e4fe61f`. Landing aparte: `ee40f10`.
> - Única empresa real: **AVP** (id 6, ~480 empleados). Titular:
>   `tupctw@gmail.com`.
> - Repos: backend **público** (decisión del dueño hasta que se venda;
>   pasarlo a privado es obligatorio antes de vender).
> - No queda nada sin commitear en ninguno de los tres repos.
> - **Cómo probar una pantalla de verdad sin estar en la PC:** `ng serve`
>   (usa el backend local, puerto 3000) + Chrome sin ventana manejado por su
>   protocolo de depuración. Sirve para medir tamaños y sacar capturas. Así
>   se verificó el arreglo del panel lateral.
>
> ### Qué tiene que hacer el dueño (pendiente)
>
> | Qué | Para qué |
> |---|---|
> | Correr `migrations/20261012_solicitudes_de_alta.sql` | Sin ella no se puede aprobar ni rechazar solicitudes de alta |
> | Correr `migrations/20261010_portal_empleado.sql` (si no la corrió) | Portal del empleado |
> | Confirmar que corrió `20261008` y `20261009` | Cierre de mes y ajustes |
> | En Empresas, elegir `tupctw@gmail.com` como titular de AVP | Sin titular, nadie de AVP puede pedir la baja |
> | Decir si tiene **dominio o nombre de marca** | Bloquea la etapa de separar la landing |
> | Decir cuál de las dos landing usa y dónde está publicada la separada | Hoy hay dos copias |
> | Activar `MYSQL_SSL` en Render (F-11) y mandar `SHOW GRANTS` (F-12) | Seguridad |
> | Branch protection en `main` (los dos repos) | Seguridad |
> | Probar el portal del empleado con un empleado real (pasos en `PORTAL_EMPLEADO.md`, "Cómo se usa") | En local se probó en Chrome; falta en producción y en un celular físico |
> | Probar el alta completa en la página (registrarse, chatear, aprobar) | No se probó en un navegador |
> | Desde el 2026-10-10: buscar `[CSP]` en Render → Logs; si no hay nada, activar el bloqueo de la CSP | Ver `SEGURIDAD_WEB.md` |
>
> ### Camino al primer cliente (actualizado 2026-10-02)
>
> El dueño quiere empezar a ofrecerlo. El producto ya alcanza; lo que falta
> es dejar prolija la puerta de entrada. En orden:
>
> | # | Qué | Quién | Estado |
> |---|---|---|---|
> | 1 | Correr las migraciones `20261010`, `20261012` y `20261013` en producción (y confirmar `20261008` y `20261009`) | Dueño | Pendiente |
> | 2 | Elegir `tupctw@gmail.com` como titular de AVP en Empresas | Dueño | Pendiente |
> | 3 | Publicar la landing en su propia dirección (ver abajo) | Los dos | Pendiente: falta elegir el nombre |
> | 4 | Agregar esa dirección al `CORS_ORIGINS` del backend (Render) y a los dominios del widget de Turnstile (Cloudflare) | Dueño | Pendiente |
> | 5 | Probar el alta completa en producción: registrarse, aviso de Telegram, chatear, aprobar, que llegue el mail de contraseña y entrar | Dueño | Pendiente |
> | 6 | Pasar los repos a privados (acordado: obligatorio antes de vender) | Dueño | Pendiente |
> | 7 | Seguridad: `MYSQL_SSL` en Render, `SHOW GRANTS`, protección de `main` | Dueño | Pendiente |
> | 8 | Términos y condiciones y política de privacidad, enlazados desde la landing | Dueño (con abogado); el borrador lo puede armar una sesión | Pendiente |
> | 9 | Al entrar el primer cliente: plan pago de Render (hoy se duerme) y de la base (hoy 5 conexiones) | Dueño | Decidido: se paga con el primer cliente |
>
> **La landing: cómo queda y cómo se conecta**
>
> - Hay dos copias: `horas-dedica-angular/public/landing.html` (se publica
>   dentro del sistema) y el repo `landing-horas-dedica`. Eran iguales hasta
>   el 2026-10-03; ese día, en la del sistema, el código pasó a
>   `landing.js` por la CSP (ver `SEGURIDAD_WEB.md`). **La del repo aparte
>   todavía no tiene ese cambio:** aplicarlo cuando se publique.
> - **No hace falta pagar hosting.** Firebase Hosting permite un segundo
>   sitio gratis en el mismo proyecto, con su propia dirección
>   (`<nombre>.web.app`). Al ser otra dirección, para el navegador ya es
>   "otro sitio" que el sistema, que es lo que se buscaba. Cloudflare Pages
>   también es gratis y suma un firewall. El dominio propio queda para
>   después.
> - **La landing NO se conecta a la base de datos, y el backend sigue
>   existiendo.** La landing es una página estática: lo único que hace es
>   llamar por internet a dos direcciones del backend de Render
>   (`/api/public/signup` y `/api/public/chat`). El backend es el único que
>   habla con la base. Mover la landing no cambia nada de eso: solo cambia
>   desde dónde se sirve el archivo HTML.
> - Al publicarla en una dirección nueva hay que avisarle a dos lugares que
>   esa dirección es de confianza: el backend (`CORS_ORIGINS`) y Turnstile.
>   Si no, el formulario falla con "no se pudo conectar con el servidor".
> - Cuando la landing nueva esté andando, se saca `landing.html` del sistema
>   para que quede una sola copia.
> - Mientras Render esté en el plan gratuito, el primer envío del formulario
>   puede tardar medio minuto (el servidor se despierta).
>
> **Empresa de demostración (para capturas y demos).** No usar pantallas de
> AVP para vender: muestran nombres reales de sus empleados. El script
> `scripts/crear-empresa-demo.js` crea "Empresa Demo S.A." con 24 empleados
> y fichajes inventados de los últimos 45 días, relativos al día en que se
> corre (volver a correrlo la deja "al día"). Se corre contra producción con
> las variables `MYSQL_ADDON_*`, igual que `run-sql.js`. Después, el
> superadmin le crea un usuario en Usuarios y Roles. Con `--borrar` se saca
> del todo (si tiene usuarios, primero hay que borrarlos). Solo escribe y
> borra con el `tenant_id` de la demo.
>
> **No bloquea al primer cliente:** fichaje con celular, exportación a
> sueldos, dominio propio, servicio de recepción aparte.
>
> ### Metas, en orden
>
> 1. **Separar la landing del sistema** (para no exponer el sistema ni
>    afectar a los clientes que pagan). Dominio propio → una sola landing en
>    su dominio (Astro + Cloudflare Pages) → servicio de recepción aparte
>    (solicitud + chat) con un usuario de base que solo escriba en
>    `signup_leads`. Ver `SOLICITUDES_DE_ALTA.md`.
> 2. **Fichaje con el celular** (módulo pago aparte, por empleado
>    habilitado). Decidido: GPS + zonas, detección de GPS falso, llave atada
>    al celular y biometría del propio teléfono (sin guardar huellas ni
>    caras). Necesita app (Capacitor); primero Android, con el APK compilado
>    por GitHub. Ver `PORTAL_EMPLEADO.md`.
> 3. **Portal del empleado, lo que falta**: prueba de carga con 400
>    usuarios, cargar el mail desde la importación, web instalable (PWA),
>    etapa 2 (solicitudes y aprobaciones). Decisión abierta: si el empleado
>    ve el excedente de horas extra (hoy lo ve).
> 4. **Exportación a sistemas de sueldos**: falta que el dueño averigüe qué
>    sistema usa AVP y consiga un archivo de novedades de ejemplo.
> 5. Pasar al convenio la campaña, los cupos y las horas de dedicación.
> 6. Tipo de fichaje: corregirlo desde el detalle del día. Bandeja de
>    "Pendientes de revisión" como inicio. Asistente con IA (con filtro de
>    salida en el servidor: ver el incidente del chat más abajo).
> 7. Antes de vender: repos privados, plan pago de Render y de la base
>    (lo paga al entrar el primer cliente), términos y privacidad (Ley
>    25.326 y registro en la AAIP), factura electrónica.
>
> 8. Pendientes más viejos, todavía sin hacer: monitoreo de errores con
>    Sentry (el código está en `monitoreo.js`, apagado hasta cargar
>    `SENTRY_DSN` en Render); en Matching, las dos listas lado a lado para
>    vincular a mano; cambiar la contraseña del MySQL local (estuvo en este
>    archivo, en un repo público, y sigue en el historial de git); datos:
>    asignaciones de plantilla superpuestas (ej. MARTENSEN).
>
> ### Dónde está explicado cada tema
>
> | Tema | Documento |
> |---|---|
> | Horas extra: regímenes, topes, liquidación, cierre de mes, ajustes | `HORAS_EXTRA_REGIMENES.md` |
> | Portal del empleado, módulos por empresa, fichaje móvil | `PORTAL_EMPLEADO.md` |
> | Alta de empresas (solicitudes), chat de ventas, titular | `SOLICITUDES_DE_ALTA.md` |
> | Campaña | `CAMPANA.md` |
> | Seguridad del agente que sube fichajes | `SEGURIDAD_AGENTE.md` |
> | Seguridad de la web: CORS, cabeceras, CSP, librerías | `SEGURIDAD_WEB.md` |
> | Licencias largas (gremial, cargo electivo…): análisis y propuesta A–F | `LICENCIAS_LARGAS.md` |
> | **Aislamiento por empresa: qué es global, qué debería ser propio, plan A–J** | `AISLAMIENTO_POR_EMPRESA.md` |
> | **Marcadores: salidas particulares y horas extra. Reglas que no se pueden romper y cómo verificarlas** | `MARCADORES_Y_SALIDAS.md` |
> | Marcadores con varios relojes (datos y diseño) | `ANALISIS_MARCADORES_MULTIRELOJ.md` |
>
> ### Bitácora (lo más nuevo arriba)
>
> - **2026-10-06 — Lectura repetida como regla universal (aprobada A/B/C).**
>   El 10 % de las lecturas del reloj son dobles; la 2da cerraba lo que abría
>   la 1ra (MENDOZA 9467: salida particular "de 0 min"; 1496: 3 h 14 min de
>   HE contadas como 0). Ahora: lecturas repetidas dentro de 20 s (configurable
>   en Marcadores) = una, salvo marcador en el medio. Resguardo transitorio
>   para serenos al llegar. Impacto medido: +819 h HE ene-sep (+4,3 %),
>   serenos sin cambio. Ver `MARCADORES_Y_SALIDAS.md` ("Doble lectura").
> - **2026-10-06 — Licencias largas (gremial): análisis, ESPERA APROBACIÓN.**
>   Hoy ya se puede cargar como Licencia con rango de años (no figura ausente),
>   pero: fecha de fin obligatoria, la lista de Licencias no la muestra en los
>   años del medio (bug), avisos falsos si ficha, infla "Excusado", sin aviso al
>   vencer. Ver `LICENCIAS_LARGAS.md`.
> - **2026-10-06 — Aislamiento por empresa: relevamiento y plan A–J, ESPERA
>   APROBACIÓN.** Casi todo lo "global" es dato de AVP (feriados que se aplican
>   pero no se ven, horario 07–13:40, escala de vacaciones, ciudades…), y tres
>   consultas de `companyschedule` no filtran por empresa. Ver
>   `AISLAMIENTO_POR_EMPRESA.md`. Nada cambiado.
> - **2026-10-06 — Sereno AGUILAR (3056) y doble lectura del lector: EN
>   PAUSA, el dueño pidió esperar antes de cambiar lógica.** Diagnóstico y
>   medición en `MARCADORES_Y_SALIDAS.md` sección 5. Nuevo principio en
>   `CLAUDE.md`: nada de AVP en el código, todo configurable por empresa con
>   valor por defecto = comportamiento actual. Propuesta de diseño (fuente de
>   horas extra por régimen) esperando decisión del dueño.
> - **2026-10-05 — Botones del celular en píldora** (frontend `e3a49a7`).
>   Buscar y Más filtros tenían esquinas de 6px (del ejemplo HTML); vuelven
>   a ser píldoras como en escritorio y en todas las páginas. Criterio
>   (Material 3): **botones = píldora, campos = rectángulo**. Mantenerlo al
>   aplicar `filtros-celular` a otras pantallas.
> - **2026-10-05 — Documentación para no repetir errores.** Nuevo
>   `MARCADORES_Y_SALIDAS.md` (cómo funcionan los marcadores, las 5 reglas,
>   los errores reales con datos y cómo verificar). Nuevo `CLAUDE.md` en el
>   backend y aviso en el `CLAUDE.md` del frontend: Claude Code los carga
>   solos y mandan a este bloque. En el monorepo viejo quedó un `CLAUDE.md`
>   local (sin commitear) que dice que está obsoleto y adónde ir.
> - **2026-10-05 — Salida particular sin regreso en el calendario.** Bug
>   real (PERROTTA, 2525, 29/09): el calendario del detalle mensual solo
>   marcaba salidas completas; ahora también las que Salidas muestra como
>   "Sin regreso — fin de horario" (`4589969`). (B) HECHO 2026-10-05, y con
>   él la causa de fondo: en el DETALLE de una persona la detección de
>   marcadores solo veía sus fichajes, así que un marcador que se llevó otra
>   persona se le asignaba a ella. Afectaba también las HORAS EXTRA del
>   detalle (abril/agosto: 13 y 11 empleados distintos del resumen). Ahora
>   usa todos los fichajes del período; verificado con la copia de
>   producción empleado por empleado: calendario = Salidas, detalle =
>   resumen. Antes, (B) era: el calendario marca
>   una salida completa que en realidad es la llegada del día (marcador de
>   otra persona, caso AVILA); Salidas la descarta. (C) HECHO 2026-10-05:
>   la "entrada particular" ahora se marca en el calendario.
>   Caso AVILA exacto (para B): 08/04/2026 marcador 6 a las 07:22:57 y su
>   llegada 07:23:05; 14/04/2026 marcador 07:23:19 y llegada 07:23:26. Sin
>   reloj guardado (fichajes viejos). Medido desde junio: 601 marcadores
>   con 7-10 s de demora, casi todos legítimos -> la tolerancia en segundos
>   (`markerMaxGapSeconds`, hoy 25 en AVP) NO sirve para separar el caso
>   AVILA; la regla "primer fichaje del día" sí.
> - **2026-10-04 — Estilo de filtros en el celular (publicado 2026-10-05).**
>   El dueño mandó un HTML de ejemplo para Presentismo: rótulo arriba del
>   campo, bordes de 2px, calendario en la fecha, lupa a la izquierda con
>   botón Buscar, "Más filtros" a lo ancho, totales de a 3. Hecho como clase
>   global reutilizable `filtros-celular` en `styles.css` (para aplicarlo a
>   otra vista: agregar la clase a su fila de filtros). Escritorio sin
>   cambios. Aprobado y publicado (`fd35fb5`). Falta aplicarlo a las
>   otras vistas que elija el dueño. **Firefox** (2026-10-05, `93e17a1`):
>   dibuja su propio calendario en el campo de fecha y no deja esconderlo;
>   se veían dos y la fecha cortada. Arreglado con `@supports
>   (-moz-appearance: none)`. Probar siempre también en Firefox: hay
>   `puppeteer-core` para manejarlo sin ventana (Firefox está instalado).
>   **Tipografía** (`02773dd`): todos los controles de la fila en Roboto
>   14px con el mismo espaciado (antes 16/15/14px), botones en peso medio,
>   texto a 12px del borde. Se cambia en un solo lugar: variables
>   `--texto-filtros-celular` y `--espaciado-filtros-celular` de `styles.css`.
>   Fecha centrada verticalmente (`8d1b33c`): cada navegador le daba su
>   altura al campo (Chrome 14px, Firefox 17px); fijada en 24px.
>   Firefox Android (`46c58f3`): agranda el texto por su cuenta (font
>   inflation) → `text-size-adjust: none` en la fila, y margen de 8px solo
>   en Firefox. Resultó ser el "Tamaño de fuente automático" de Firefox, que
>   copia la letra de Android: es un ajuste de ACCESIBILIDAD de la persona,
>   la página no lo puede ni debe anular (WCAG pide texto agrandable al 200%).
>   **Letra agrandada** (`e4fe61f`): los anchos mínimos de la fila van en
>   `em`; con letra grande cada campo pasa a su propio renglón en vez de
>   cortarse. Probado al 100/110/130/160% (se simula subiendo
>   `--texto-filtros-celular`, porque el ajuste de Android no existe en PC).
>   Regla para pantallas nuevas: anchos mínimos en `em`, no en `px`.
> - **2026-10-04 — Horas Extra por Régimen en el celular.** El texto de
>   ayuda pasó a un ícono (?) junto al título; Fecha | Régimen y Buscar |
>   Más filtros en dos filas; Excel y PDF dentro de "Más filtros". El
>   Período sigue con el año completo (pedido del dueño: son períodos de
>   pago); solo se evitó que cada fecha se parta por la mitad.
> - **2026-10-03 — Aviso de relojes para muchos relojes.** Pedido del dueño
>   ("por ejemplo 150 relojes"). Resumen arriba, selector de empresa para el
>   superadmin, primero los atrasados, y con más de 6 relojes solo los
>   atrasados más "Ver todos". Probado en Chrome con 152 relojes.
> - **2026-10-03 — Revisión de seguridad, A–D hechos.** Explicado en
>   `SEGURIDAD_WEB.md`. (A) El filtro CORS dejaba pasar cualquier origen:
>   arreglado, con los sitios propios fijos en el código y 403 para un
>   navegador en un sitio ajeno. (B) Cabeceras de seguridad en Firebase
>   Hosting. (C) CSP en modo "solo reportar" con receptor en
>   `/api/public/csp-report` (log `[CSP]` en Render); probada bloqueando en
>   las 28 pantallas, exportar Excel y PDF, importar, landing y login con
>   Google: cero bloqueos. El código de la landing pasó a `landing.js`.
>   (D) `firebase-admin` 13.10, `xlsx` 0.20.3 de SheetJS, Angular 22.2.1.
>   **Pendiente: en una semana, si el log no muestra `[CSP]`, activar el
>   bloqueo** (pasos en `SEGURIDAD_WEB.md`).
> - **2026-10-02 — Presentismo en el celular, listo para capturas.** Medido
>   en 390 px: la primera tarjeta de empleado aparecía a los 980 px (más de
>   una pantalla de controles); ahora a los 376. Período y Fecha en una
>   fila, búsqueda y "Más filtros" en otra, Excel y PDF adentro de "Más
>   filtros", totales en una tira deslizable. Además: "Modo de cálculo" y
>   "Comparar Legacy" quedan solo para el superadmin (son herramientas de
>   diagnóstico); con un solo fichaje la salida muestra un guion (antes
>   repetía la hora de entrada); el reloj se muestra por su nombre y no por
>   su IP (migración `20261013`, se renombra con el lápiz); y se creó el
>   script de la empresa de demostración.
> - **2026-10-02 — Formulario del empleado: Email y Dirección en la misma
>   fila.** El dueño vio media fila en blanco y la leyenda del mail encima
>   de "Dirección". Causa: las filas son una grilla de 2 columnas, y un
>   `mat-hint` largo en media columna se parte en varias líneas (Material
>   reserva lugar para una). La explicación pasó al ícono de ayuda.
>   **Regla para este formulario: los campos van de a dos por fila, y las
>   explicaciones largas en `app-info-hint`, no en `mat-hint`.** Los errores
>   que marca el editor en `employee-dialog.html` son falsos (análisis
>   desactualizado): vale lo que dice `ng build`. Frontend `d4b0d64`.
> - **2026-10-02 — Mail del empleado, opcional, en su formulario.** Antes
>   solo se cargaba desde Portal del empleado. Ahora también en Empleados
>   (alta y edición). Si se escribe un mail que ya tiene otro empleado de la
>   empresa, no se guarda y el aviso dice quién lo tiene, con un botón para
>   abrir su ficha (si hay permiso). Una sola regla para las dos pantallas:
>   `motor-laboral/services/emailDeEmpleado.js`. Probado en Chrome; ahí
>   aparecieron dos detalles que los tests no veían (el texto del aviso se
>   borraba al recargar la lista, y el campo seguía mostrando el mail
>   rechazado). No necesita migración nueva (usa la `20261010`).
> - **2026-10-02 — Portal del empleado probado en un navegador; se
>   encontró y corrigió un bug.** El empleado iniciaba sesión y quedaba en
>   una pantalla en blanco: los guards de ruta se evalúan antes del login.
>   Ahora el shell lo lleva a "Mi asistencia". Recorrido completo verificado
>   en Chrome en local (administrador invita, empleado ve su mes en tamaño
>   celular y queda encerrado en su portal). **Lección: los tests del
>   servidor no ven los problemas de navegación; lo que tiene pantalla se
>   prueba en un navegador.** Frontend `a99e30a`.
> - **2026-10-02 — Panel lateral: íconos centrados al plegar.** El dueño
>   vio que quedaban corridos a la izquierda y propuso ensanchar el panel a
>   81 px. Medido: 8 px del centro (15,5 con Administración abierto). Se
>   corrigió la causa en vez de ensanchar: plegado, el ícono no lleva
>   márgenes, el contenedor vacío del texto sale del flujo y la barra de
>   desplazamiento se oculta. Todo está en
>   `horas-dedica-angular/src/app/core/shell/shell.css`. El ancho plegado
>   es la variable `--rail-width` (72 px). Frontend `6524902`.
> - **2026-10-01 — Panel lateral: sin líneas al plegar y sin íconos
>   cortados.** Dos problemas que reportó el dueño. (1) Al plegar quedaban
>   líneas verticales: el panel pasaba a 72 px y el contenido seguía en 248.
>   (2) Con Administración abierto los íconos quedaban por la mitad. El
>   arreglo lo había empezado otra sesión y quedó sin commitear; al medirlo
>   en Chrome apareció que la animación colgaba de una clase interna de
>   Material que ya no existe. **Lección: no atar un estilo propio a una
>   clase interna de una librería.** Frontend `bdc0ba7`.
> - **2026-10-01 — Alta por solicitud.** El formulario de la página solo
>   guarda una solicitud; el superadmin la aprueba o rechaza (pantalla
>   Solicitudes de alta, aviso por Telegram y campanita). Misma respuesta
>   para todos, sin mail automático, una solicitud por mail. El titular se
>   elige de una lista en Empresas. Migración `20261012`.
> - **2026-10-01 — Incidente: el chat de ventas le dijo "boludo" a un
>   visitante.** Causa: el prompt pedía "español rioplatense" sin regla de
>   trato y nadie revisaba la respuesta. Arreglo: prompt con trato
>   profesional + revisión de cada respuesta en el servidor + texto fijo de
>   respaldo. Además: el chat ahora sabe que el visitante ya envió la
>   solicitud, el cupo de preguntas es por mail (refrescar no lo reinicia) y
>   hay un tope diario de gasto. **Lección: la salida de una IA que ve un
>   cliente se controla con código, no solo con el prompt.**
> - **2026-10-01 — Portal del empleado publicado, apagado.** Cada empleado
>   ve solo lo suyo. Es un módulo que el superadmin prende por empresa.
>   Migración `20261010`.
> - **2026-09-30 — Solo el titular pide la baja.** Antes cualquier usuario
>   de la empresa podía pedir la baja del servicio. Migración `20261011`.
> - **2026-09-30 — Corregir un mes cerrado y pagar la diferencia al mes
>   siguiente** ("ajuste de meses anteriores"). Migración `20261009`.
> - **2026-09-29 — Horas extra B1–B5 completo.** Convenios y regímenes con
>   herencia, topes por día/mes/año, autorizaciones, informe de liquidación
>   y cierre de mes. Migraciones `20261006` a `20261008`.
> - **2026-09-28/29 — Campaña, cupos por motivo, avisos de asistencia, tipo
>   de cada fichaje, fechas en hora local, CI en verde, seguridad F-01 a
>   F-07.**
> - **2026-09-21 — Lentitud de Presentismo resuelta** (un `JOIN` con `OR`
>   anulaba los índices: ~19 s → ~1,5 s).
>
> ### ⚠️ Lo que hay que leer antes de tocar matching
>
> El 2026-09-19 se declaró un hallazgo "GRAVE" que era **falso**: se dijo que
> 81.622 fichajes no llegaban a los informes. Sí llegaban. La causa del error
> fue **suponer la cadena de JOINs en vez de leerla**. Está todo explicado en
> la sección *"⚠️ CORRECCIÓN (2026-09-20)"* más abajo. Leela antes de sacar
> conclusiones sobre datos que "faltan": **la consulta que arma el informe es
> `horasdedica.js:3109`** y resuelve con
> `(u.USERID = c.USERID OR u.Badgenumber = c.USERID)`.
>
> ### Reglas del dominio que no están en el código (las dio el dueño)
>
> - `USERID` es la llave interna del reloj. **No identifica a nadie.**
> - `Badgenumber` es la identidad: el legajo **o el DNI**, según qué cargó
>   cada empresa en el reloj. Por eso es configurable.
> - **Los `USERID` ≤ 10 no son personas**: son marcadores ficticios del
>   reloj. El 1 es el administrador.
> - **Nada de matching se aplica solo.** *"El matching impulsivo no será
>   bueno, deberá ser el usuario que acepte cada matching"*.
> - No interesa recuperar el historial viejo de fichajes: *"lo que me
>   interesa es que el código actual funcione bien para poder empezar a
>   ofrecer el servicio"*.

---

## Motor de reglas de asistencia configurable

Última actualización: 2026-09-18

Este documento es para cualquier programador (yo mismo en el futuro, u
otra persona) que retome este trabajo. Resume qué se hizo, por qué, qué
quedó funcionando, y qué falta.

## Repos y deploys

- **Backend**: `BackHorasExtras` (GitHub: `Vicentetw/BackHorasExtras`), rama `main`. Deploy: Render (`https://academypruebadep.onrender.com`), auto-deploy al pushear a `main`. Base de datos: MySQL en Clever Cloud (credenciales en `.env` de producción del servicio en Render).

  ⚠️ **`motor-laboral/.env` tiene acceso TOTAL a producción, no de solo lectura.** Este documento decía antes que era "una copia de solo-lectura"; se verificó el 2026-09-19 con `SHOW GRANTS` y es falso: el usuario tiene `ALL PRIVILEGES` sobre la base entera, o sea que puede modificar y borrar cualquier cosa. El archivo está fuera de git (lo cubre el `.gitignore`), pero **cualquier script que se corra apuntando a ese `.env` está escribiendo en producción**. Nunca correr tests contra él. Si se quiere que sea de verdad de solo lectura, hay que crear un usuario aparte en Clever Cloud con permiso `SELECT` solamente y usar ese.
- **Frontend**: `horas-dedica-angular` (GitHub: `Vicentetw/horas-dedica-angular`), rama `main`. Deploy: Firebase Hosting, proyecto `horasdedicacionavp`, sitio real `https://horasdedicacionavp.web.app`. El deploy **no es automático** — hay que correr `npm run deploy:live` a mano después de cada push a `main`.
- **Base de test local** (para desarrollo/tests, NO es producción): MySQL en `localhost:3307`, base `horas_dedica2`. Las credenciales están en el `.env` de la raíz de `BackHorasExtras`, que **no** se versiona. (Antes estaban escritas acá; se quitaron el 2026-09-20 al descubrir que este repositorio es público.) **Ese `.env` local no tiene credenciales de producción** — Clever Cloud solo se toca desde el workflow de migraciones o desde `motor-laboral/.env`, ver la advertencia de arriba.
- **Repo viejo `horas-dedica-completo`** (local: `C:\angular\horasDedicacionOnline`): era el monorepo donde vivía todo junto. **Ya no se usa para el backend.** Quedó en el commit del 2026-09-17 y su carpeta `backendonline2/` está congelada en la migración `20260920` — le faltan las 7 migraciones siguientes y todo el motor de reglas. El backend se separó a `BackHorasExtras` para el deploy en Render, y el frontend a `horas-dedica-angular` para la migración a Angular. **No portar cambios hacia atrás**: si algo falta ahí, es a propósito.
- **Agente de descarga de fichajes** (programa Python que corre en una PC Windows 10 junto al reloj biométrico, se compila a `.exe` con PyInstaller vía `main.spec` y deja el ejecutable en `dist/`): desde el **2026-09-19 vive en este mismo repo**, en `descarga-fichaje-py/`. Además de generar los dos CSV (`CHECKINOUT.csv` y `USERINFO.csv`), **sube los fichajes a la nube** por su cuenta (ver `api_client.py` y `agent_runner.py`).

  Antes andaba suelto en dos carpetas del disco, sin versionar acá. **Las dos quedan obsoletas** y conviene borrarlas o renombrarlas a `-VIEJO-NO-USAR`, porque tocar la copia equivocada de un programa que sube fichajes a producción sería un problema serio:
  - `C:\angular\horasDedicacionOnline\descarga-fichaje-py` — era la vigente; es la que se trajo acá.
  - `C:\angular\descarga-fichaje-py` — desactualizada desde principios de septiembre.

  Qué cambió al traerlo, y por qué:
  - **Solo se trajo el código (86 KB).** En el repo anterior la carpeta pesaba 100 MB porque estaban commiteados los dos entornos virtuales (`.venv` y `zk-env`), `dist/` con el `.exe` y una base de 19 MB, y los CSV. Eso hacía que cada `git status` mostrara cientos de archivos de `pip` como modificados — se ve en el historial. El `.gitignore` nuevo lo evita.
  - **Los CSV no se versionan**: `CHECKINOUT.csv` y `USERINFO.csv` son nombres de empleados reales y sus fichajes. Son datos personales, no código.
  - **`config.ini` sí se versiona, pero como plantilla** con `url =` y `clave =` vacíos (así estaba). La clave de agente de cada empresa se carga en la PC donde corre el agente.
  - **Se agregó `requirements.txt`, que no existía.** El proyecto dependía de que el `.venv` siguiera vivo en esa máquina; si se borraba, no había forma de saber qué instalar para recompilar el `.exe`. Las versiones se sacaron leyendo el `.venv` real, no de memoria: `pyzk==0.9` (habla con el reloj), `tzdata` (sin esto `zoneinfo` no funciona en Windows), `sv-ttk` (tema visual, opcional), `pywin32` (solo para `enrolar.py`) y `pyinstaller==6.22.2` para compilar.
  - Verificado al traerlo: los 9 archivos `.py` compilan y los 6 módulos sin interfaz gráfica importan sin errores (Python 3.12.3).

## Por qué reaparecían empresas de prueba en /empresas y /facturación (2026-09-22) — resuelto

**Síntoma**: en la base local aparecían 7 empresas que nadie cargó y que ya
se habían borrado a mano (`Tenant Checkins Batch (test)`, `Tenant Import
Validation (test)`, `Tenant Templates Admin (test)`, `Tenant Conventions A` y
`B`, `Tenant Historial Template`, `Tenant Simulador`), visibles en `/empresas`
y en `/facturación`.

**Quién las creó**: los tests. Cada uno crea su empresa descartable (ids
999900 en adelante) y la borra al terminar. **No es un bug del sistema**:
nada de esto puede pasar en producción, donde no se corren tests.

**Por qué no se borraban**. 21 de los 48 archivos de test hacen el `after()`
en el orden equivocado:

```js
await db.query('DELETE FROM tenants WHERE id = ?', [T]).catch(() => {});
await deleteTestUser(UID);   // recién acá se borra el usuario
```

La empresa se intenta borrar mientras su propio `app_user` todavía la
referencia → MySQL lo rechaza por clave foránea → y el `.catch(() => {})` se
traga el error **en silencio**. El usuario se borra un renglón después y la
empresa queda huérfana para siempre. Por eso, al borrarlas, se comprobó que
**nada las referenciaba**: en ese momento ya se podían borrar sin problema,
pero el intento había pasado un segundo antes de tiempo.

**Por qué reaparecían después de borrarlas a mano**: cada `npm test` las
volvía a crear. No "volvían": eran nuevas, con el mismo nombre.

**La solución** no fue corregir los 21 archivos, porque el problema vuelve
con el próximo test que alguien escriba distraído y nadie se entera hasta
verlo en la pantalla. Se puso una red de seguridad:

- `scripts/limpiar-datos-de-prueba.js` — borra todo lo que tenga
  `tenant_id >= 999900`, en orden de dependencia, **sin tragarse los
  errores**: si algo no se puede borrar, lo dice y sale con error. Por
  defecto simula (`npm run limpiar-pruebas`); borra con `--aplicar`.
- `scripts/correr-tests.js` — es el nuevo `npm test`: limpia, corre la
  suite, **limpia otra vez pase lo que pase**, y devuelve el código de
  salida de los tests.

**Detalle que costó una vuelta**: la primera versión usaba los hooks
`pretest`/`posttest` de npm. No sirve: npm corre `posttest` **solo si los
tests pasaron**, y el caso que hay que limpiar es justo el contrario —
cuando algo falla a mitad de camino, los `after()` de los archivos
siguientes ni siquiera llegan a correr. Verificado en vivo: con la suite en
rojo quedaron las 7 empresas otra vez. Por eso la limpieza está en un
`finally` de verdad y no en un hook.

**Seguridad**: el script solo toca ids `>= 999900` y se niega a arrancar si
alguien baja ese límite. Las empresas reales tienen ids chicos (AVP es la 6).

**Relacionado**: el superadmin fantasma `test-country-firewall-http@test.local`
tenía la misma raíz — un test que creaba un `app_user` y nunca lo borraba.
Ese test ya quedó corregido, y de paso se agregó el borrado real de usuarios
en `/usuarios`.

## Cómo dar de alta una empresa nueva (2026-09-22)

**La respuesta corta: NO hay que replicar nada.** No se hace otro deploy en
Render, ni otro sitio en Firebase, ni otra base en Clever Cloud, ni un backup
de la base de AVP para vaciarla. El sistema ya es multiempresa: una empresa
nueva es **una fila más en `tenants`** dentro del mismo servidor y la misma
base. Eso es exactamente lo que se estuvo arreglando estos días (el agujero
de `companyschedule`, el de `ManualEntries`, el legajo único global) y lo que
verifica `test/full-tenant-isolation.test.js`: dos empresas con legajos,
USERID y credenciales **idénticos** y ningún dato que se cruce.

Clonar el sistema para cada cliente sería lo peor de los dos mundos: cada
corrección habría que aplicarla N veces, cada migración N veces, y el primer
olvido produce dos clientes con cálculos distintos.

### Los pasos reales

1. **Crear la empresa** — `POST /api/labor-engine/admin/tenants` (solo
   superadmin), o desde la pantalla `/empresas`. Da el `tenant_id`.
2. **Crear el usuario administrador de esa empresa** — desde `/usuarios`,
   con rol de administrador y `tenant_id` el de la empresa nueva. **No
   superadmin**: el superadmin sos vos, es quien ve todas las empresas.
3. **Asignarle plan y suscripción** — `POST /api/billing/subscriptions/:tenantId`.
   Sin esto, `requireActiveSubscription` le va a cortar el acceso.
4. **Generar la clave del agente** — `/api/agent-keys` (o la pantalla de
   claves). Es **por empresa**: es lo que hace que los fichajes que sube esa
   PC entren en esa empresa y no en otra. Esa clave se carga en el
   `config.ini` de la PC del cliente. Que dos agentes de dos empresas no se
   pisen está probado en `test/agent-cross-tenant-collision.test.js`.
5. **Instalar el agente en la PC del cliente** — el `.exe` de
   `descarga-fichaje-py` (ver más arriba cómo se compila), con la IP del
   reloj y la clave del punto 4.
6. **Crear los marcadores en el reloj** — botón *"Crear marcadores en el
   reloj (alta de empresa)"* del agente (ver la sección siguiente).
7. **Sincronizar usuarios** — botón *"Solo usuarios"*. Los usuarios del
   reloj entran en `users` con el `tenant_id` correcto.
8. **Cargar los empleados** — importación por CSV desde `/importar`, o a
   mano. Acá se decide qué campo es la identidad (legajo o DNI) según qué
   haya cargado esa empresa en el reloj: se elige en `/matching`, en
   "Campo de identidad".
9. **Vincular reloj ↔ empleados** — pantalla `/matching`, que propone las
   coincidencias y muestra quién ficha sin estar asociado.
10. **Cargar las plantillas de horario** y asignarlas a los empleados.

**Sobre "que quede solo el superadmin sin empleados"**: no hace falta vaciar
nada. La empresa nueva **nace vacía**; los 480 empleados de AVP son de AVP y
el cliente nuevo no los ve nunca, porque cada consulta filtra por
`tenant_id`.

### Cuándo SÍ haría falta un deploy aparte

Solo si un cliente exige por contrato que sus datos no compartan base con
otros, si hace falta un ambiente de prueba/demo, o si se muda todo a otra
cuenta. Es una decisión comercial, no técnica — y multiplica el
mantenimiento por la cantidad de instalaciones.

**El instructivo completo de los 3 servidores (Clever Cloud → Render →
Firebase) está en `REPLICAR_INSTALACION.md`**, con las dos trampas que más
fácil se pasan por alto: que Firebase son **dos proyectos distintos**
(hosting `horasdedicacionavp`, autenticación `asistenciatw`, y el
`FIREBASE_SERVICE_ACCOUNT` del backend tiene que ser del **segundo**), y que
si falta `API_KEY` el servidor arranca igual con la capa de clave de
aplicación **desactivada y en silencio** (`security.js:33`).

## Usuarios marcadores: creación automática en el reloj (2026-09-22)

Los marcadores (`5` salida particular, `6` regreso, `9` inicio de horas
extra, `10` fin) **son usuarios del reloj que no son personas**. El empleado
ficha primero el marcador y después ficha él, y así el sistema sabe qué tipo
de movimiento fue. Hasta ahora había que sentarse frente al reloj y cargarlos
a mano en cada alta — un paso manual que, si se olvida, hace que una salida
particular se vea como una salida común.

Ahora el agente tiene el botón **"Crear marcadores en el reloj (alta de
empresa)"** (`zk_service.crear_marcadores`). Los crea con **nombre y clave
iguales al número** (`5`, nombre `5`, clave `5`), que no es capricho: la
pantalla de Marcadores del sistema los **detecta sola** buscando usuarios con
Badgenumber de 1-2 dígitos cuyo nombre sea ese mismo número
(`horasdedica.js:1359`). Con otro nombre habría que cargarlos a mano igual.

**La regla que pediste, y es la parte delicada**: escribe en el reloj, así
que **nunca pisa un número ocupado**. Hay empresas que numeran los legajos
desde el 1, y grabar sobre el usuario 5 le borraría el nombre y la huella a
un empleado real. Si el número está tomado, lo informa (por quién) y no lo
toca; ahí hay que elegir otros números y cargarlos en la pantalla de
Marcadores. Probado en `descarga-fichaje-py/test_marcadores.py` con un reloj
simulado — esa regla no se puede probar a mano en producción sin arriesgar
justo lo que se quiere evitar.

Después de crearlos: **"Solo usuarios"** para que lleguen al sistema.

## Qué es "el motor de reglas configurable"

Iniciativa grande (documento fuente: `Actúa como arquitecto de software
senior motor de horas.docx`, guía de ejecución: `fases para impletentar
avance.txt`, ambos en la raíz de este repo) para agregar una capa
configurable de horarios/tolerancias/horas extra/convenios **sin romper
ni duplicar** el sistema de asistencia existente.

**Regla de oro de todo el diseño**: el motor viejo (Legacy, el de
siempre) sigue siendo el único que calcula el resultado oficial de
horas extra/tardanzas para **cualquier plantilla que no se toque**. Todo
lo nuevo es opt-in vía la columna `work_schedule_templates.rules_engine_mode`:

- `legacy` (default, **todas las plantillas de producción están así
  hoy** — verificado en la base real: 4 de 4): cero cambio de
  comportamiento, el motor nuevo ni siquiera se ejecuta.
- `shadow`: el motor nuevo corre EN PARALELO al Legacy, solo para
  comparar (queda en `day.shadowResult` en la respuesta de
  `/attendance-range`, y las diferencias encontradas se guardan en la
  tabla `rule_engine_shadow_diffs`). El resultado oficial sigue siendo
  el de Legacy.
- `active`: el resultado del motor nuevo **pasa a ser el oficial** para
  esa plantilla (mismos nombres de campo de siempre: `status`,
  `overtimeMinutes`, `lateMinutes`, etc. — solo cambia quién los
  calcula). Si el motor nuevo tira un error un día puntual, cae
  automáticamente a Legacy para ese día (nunca rompe el cálculo
  oficial de nadie).

Ambos modos (`shadow`/`active`) se configuran por plantilla desde
"Plantillas de Horario" → editar plantilla → sección "Motor de reglas
(avanzado)", **visible solo para superadmin**.

### Piezas del motor nuevo (todas en `motor-laboral/`)

- `services/scheduleResolver.js` — arma segmentos de horario (soporta
  turno partido, nocturno) a partir de `shift_blocks`.
- `services/toleranceResolver.js` — tolerancia de entrada/salida
  anticipada y las 4 políticas de tiempo antes/después del horario.
- `services/timeClassifier.js` (`computeAttendanceResult`) — junta
  todo lo anterior en un resultado clasificado (normal/HE
  reconocida/HE no autorizada/incidencias). Es el corazón del motor.
- `services/dayTypeRuleResolver.js` — resuelve tasas de HE por tipo de
  día (feriado/franco/sábado/domingo), con desempate por especificidad
  (plantilla > convenio > tenant > global). Nunca hardcodea `if
  holiday => 100`, todo sale de la tabla `day_type_overtime_rules`.
- `services/shadowComparator.js` — compara Legacy vs motor nuevo y
  clasifica diferencias (esperada / nueva funcionalidad / inesperada /
  posible regresión).
- `services/templateConfigHistoryResolver.js` +
  `repositories/templateConfigHistoryRepository.js` — vigencia
  histórica de la configuración de tolerancia de una plantilla (para
  que cambiar la config hoy no altere el recálculo de un mes ya
  cerrado).
- `services/checkinNormalizer.js` — detecta y corrige fichajes
  duplicados/de más antes de clasificar (ver Hallazgo #2 más abajo).
- `repositories/conventionAssignmentRepository.js` +
  `repositories/dayTypeRuleRepository.js` — resuelven qué convenio
  tiene un empleado en una fecha y qué reglas de HE le aplican.

### Migraciones (en orden, todas idempotentes — se pueden re-correr sin romper nada)

```
migrations/20260921_template_tolerances.sql
migrations/20260922_day_type_overtime_rules.sql
migrations/20260923_employee_convention_assignments.sql
migrations/20260924_rules_engine_mode_and_shadow_diffs.sql
migrations/20260925_template_config_history.sql
migrations/20260926_shadow_diffs_unique_key.sql
migrations/20260927_manual_entries_exclusions_audit.sql   <-- PENDIENTE en producción
```

Las seis primeras están **ya corridas en producción** (confirmado por el
usuario el 2026-09-18). La `20260927` es del 2026-09-19 y **todavía no se
corrió** — ver la sección "Auditoría de cargas manuales" más abajo.
Para correr una migración nueva contra producción: pestaña **Actions**
del repo → workflow "Correr migracion SQL en produccion (manual)" →
`migration_files` con el/los archivo(s), separados por coma. Nadie
(ni el asistente de IA) tiene acceso directo a escribir en la base de
producción por fuera de ese workflow — es una restricción de entorno
intencional. El `.env` local apunta a `localhost` (MySQL de desarrollo),
no a Clever Cloud.

> **Requisito que se descubrió el 2026-09-19**: ese workflow necesita que
> **este repositorio** tenga cargados sus cinco secrets
> (`MYSQL_ADDON_HOST`, `MYSQL_ADDON_USER`, `MYSQL_ADDON_PASSWORD`,
> `MYSQL_ADDON_DB`, `MYSQL_ADDON_PORT`) en *Settings → Secrets and
> variables → Actions*. Cada repositorio tiene su propio almacén: apuntar
> a la misma base que otro repo **no** los comparte. Al intentar correr la
> migración `20260927` llegaron los cinco vacíos y el workflow moría
> mostrando literalmente `ERROR:` y nada más, porque `run-migration.js` no
> validaba las credenciales y el error de conexión de Node venía con el
> mensaje vacío. Eso ya está corregido: ahora explica exactamente qué
> falta y dónde cargarlo. Los valores son los mismos que ya tiene el
> servicio de backend en Render (pestaña Environment).

### Frontend nuevo (en `horas-dedica-angular`, todo bajo `src/app/motor-laboral/`)

- `conventions-page/` — CRUD de convenios (`labor_conventions`) y
  reglas de HE por tipo de día (`day_type_overtime_rules`). Ruta:
  `/convenios-horas-extra`.
- `convention-dialog/`, `day-type-rule-dialog/` — diálogos de alta/edición.
- `simulator-dialog/` — simulador de solo lectura (nunca escribe nada),
  para ver cómo clasificaría el motor nuevo un fichaje hipotético.
- `template-dialog` — suma el selector de `rules_engine_mode` (solo
  superadmin) y los 4 campos de tolerancia.
- `assign-employees-page` — suma la sección "Encuadramiento a
  convenio" en el detalle de cada empleado.
- `onboarding-page` — el tutorial de Inicio menciona el paso de
  "Convenios y horas extra especiales (opcional)".

## Auditoría final (Etapa 14) — 9 hallazgos, todos corregidos

Se hizo una auditoría exhaustiva antes de mergear a producción
(arquitectura, datos, histórico, seguridad, performance, etc.). Los 9
problemas encontrados y sus commits:

1. **Convenios sin efecto real en el cálculo** — el `RuleResolver` que
   conecta convenio→reglas nunca se había construido. Corregido +
   de paso se arregló una fuga real de `tenant_id` en el filtro de
   reglas (una regla de una empresa podía aplicarle a otra en un
   pedido cross-empresa de superadmin). Commit `57e5b64`.
2. **Fichajes duplicados/de más se perdían en silencio** — un rebote
   de reloj podía truncar el día entero a cero horas sin ningún aviso.
   Nuevo `checkinNormalizer.js`. Commit `e57cc7a`.
3. **Configuración de plantilla sin vigencia histórica** — cambiar la
   tolerancia de una plantilla alteraba el recálculo de meses ya
   cerrados. Nueva tabla `work_schedule_template_config_history`.
   Commit `e57cc7a`.
4. **Nada operable desde el frontend** — convenios/reglas de HE solo
   se podían cargar por SQL directo. CRUD + pantallas nuevas. Commits
   `4b54729` (backend) + `5dece91` (frontend).
5. **`rules_engine_mode` no editable por API + modo `active` sin
   implementar de verdad** — corregido, ver arriba. Commit `e0e7dcf`.
6. **Diferencias de modo sombra se duplicaban** en cada refresco.
   Clave única + upsert. Commit `96b2d14`.
7. **Sin tests de aislamiento de tenant** para el CRUD nuevo — 12 tests
   agregados en el mismo commit que el CRUD. Commit `4b54729`.
8. **Recálculo redundante** de segmentos de horario por cada empleado
   — memoizado con un `WeakMap` por request. Commit `96b2d14`.
9. **Modo `active` sin ningún test** — agregado junto con el punto 5.

Backend: **513/513 tests** al momento del merge (más 1 que fallaba y que
se venía anotando como "flake preexistente de MercadoPago").

**Ese "flake" no era un flake** (resuelto el 2026-09-19, commit
`53223d9`). El endpoint de checkout de MercadoPago chequeaba
`MERCADOPAGO_ACCESS_TOKEN` **antes** de validar los datos del request, así
que en cualquier entorno sin ese token (local, CI) un `billing_period`
inválido devolvía 503 "token no configurado" en lugar del 400 que
corresponde — y el test que espera 400 fallaba siempre. Nunca llamó a la
API real: los dos tests que sí la usan ya tenían su guarda
`if (!process.env.MERCADOPAGO_ACCESS_TOKEN) return`. Se invirtió el orden
(primero validar lo que manda el cliente, después la configuración del
servidor), que además es lo correcto: un dato inválido es 400 tenga o no
tenga el servidor configurado el servicio externo.

**Lección**: un flake de verdad falla a veces; éste fallaba idéntico
siempre, en las ~15 corridas. Esa consistencia era la pista, y se dejó
pasar durante días por tenerlo catalogado como "falla conocida". Conviene
desconfiar de esa etiqueta.

Estado al 2026-09-19: **526/526, la suite completa en verde**.

## Bugs encontrados DESPUÉS del deploy (ya corregidos)

1. **Export de "Horas Extra por Régimen" mostraba minutos crudos**
   (ej. "1639" en vez de "27h 19m") en el detalle día-por-día de un
   empleado. El total en pantalla siempre pasaba por `HoursMinutesPipe`,
   pero el CSV/PDF exportaba el número sin formatear. Commit `4717996`.

2. **El menú rápido de un día en el calendario de Presentismo rompió
   el calendario MENSUAL** al agregarle una tercera opción
   ("Justificar"). Causa: el botón nuevo mostraba un texto dinámico
   `{{ actionLabel(activeDay()!) }}` en el template — Angular evalúa
   eso en CADA ciclo de detección de cambios (a diferencia de un
   `(click)`, que solo corre cuando ya hay un día elegido), y
   `activeDay()` arranca en `null` hasta el primer clic → tiraba un
   error antes de que nadie tocara nada. Se revirtió (`a41b86c`) y se
   reimplementó bien (`5aa78c1`) con el MISMO patrón que los otros 2
   botones del menú: etiqueta fija en el template, `activeDay()`
   usado únicamente dentro del `(click)`. **Lección para el futuro**:
   nunca leer una señal que puede ser `null` en una interpolación de
   un `<mat-menu>` compartido — solo dentro de manejadores de evento.

## Auditoría de cargas manuales + agujero de empresa (2026-09-19)

**Qué se hizo y por qué.** Hasta ahora, si alguien cargaba 8 horas extra a
mano o marcaba un día como Vacaciones, quedaba el dato pero no quedaba
**quién** lo hizo ni **cuándo**. Ante un reclamo ("yo no pedí esa
licencia", "esas horas no las autorizó nadie") no había con qué responder.
Los fichajes manuales ya tenían esto desde la migración `20260920`
(`manual_checkin_log`); ahora lo tienen también las otras dos cosas que se
cargan a mano y que impactan en la plata.

**Hallazgo grave que apareció en el camino.** `ManualEntries` **no tenía
`tenant_id`** y ninguno de sus 4 endpoints validaba la empresa. Un
administrador de la empresa A podía cargarle horas extra a un empleado de
la empresa B, o borrarle las suyas, mandando su `USERID` de reloj (que es
secuencial, o sea adivinable). Es el mismo tipo de hueco ya tapado en las
tablas crudas del reloj (migración `20260909`); esta tabla se había pasado
por alto. Verificado leyendo el código anterior con `git show`: cero
menciones de empresa en esos endpoints.

Los dos temas se arreglaron juntos porque **el primero necesita el
segundo**: una fila de auditoría sin empresa no sirve para nada.

**Qué se agregó**

- `migrations/20260927_manual_entries_exclusions_audit.sql`:
  `ManualEntries` suma `tenant_id` (con backfill seguro), `created_by`,
  `updated_by`, `updatedAt`; `userexclusions` suma `created_by`,
  `updated_by`, `updatedAt`; y se crean dos tablas de log append-only,
  `manual_entry_log` y `user_exclusion_log`, con una columna `previous_data`
  (JSON) que guarda **cómo estaba la fila antes** de cada modificación o
  borrado.
- `auditLog.js` (nuevo): el helper que usan los endpoints. Lo importante
  es `inTransaction`: el cambio de datos y su fila de auditoría se
  confirman **juntos o ninguno**. Si fueran dos queries sueltas, un error
  entre medio dejaría una carga sin autor (justo lo que esto viene a
  evitar) o un historial que miente.
- 9 puntos de escritura instrumentados en `horasdedica.js` (3 de
  `ManualEntries`, 6 de `userexclusions`).
- `test/manual-entries-audit.test.js` (13 tests): el ciclo completo
  alta→edición→borrado deja el rastro esperado, y los 4 cruces entre
  empresas dan 404 sin tocar nada.

**Sobre el backfill de `tenant_id`.** `users.USERID` no es único entre
empresas, así que un `JOIN` directo podría asignar una fila a la empresa
equivocada. El backfill sólo resuelve los `USERID` que pertenecen a **una
sola** empresa; las filas ambiguas quedan en `NULL` a propósito. La
migración informa al final cuántas quedaron así (en desarrollo: 1, de un
usuario borrado hace tiempo). **Al correrla en producción hay que mirar
ese número** — esas filas dejan de verse desde la aplicación.

**Efecto secundario correcto, no un bug.** Ahora no se puede borrar un
`app_users` que tenga historial de auditoría (lo impide la foreign key de
`performed_by`). En producción eso no molesta: la app nunca borra usuarios,
los deshabilita (`is_active = 0`, ver `routes/appUsers.js`). Sí afectaba al
*teardown* de los tests, que sí borran de verdad — resuelto en
`test-helpers/firebaseTestAuth.js`.

**Código muerto detectado.** `routes/manual.js` y `routes/dashboard.js`
**no los monta nadie** (el único servidor es `horasdedica.js` y no los
requiere). Contienen escrituras SQL sin permisos, sin empresa y sin
auditoría. Ya se había gastado trabajo de seguridad en ellos al pepe: el
commit `fd36be5` los "arregló" sin que eso protegiera nada real. Quedaron
marcados con un cartel arriba de todo; **conviene borrarlos** (decisión del
dueño del repo, git conserva el historial igual).

**Migración aplicada en producción el 2026-09-19.** Resultado verificado:
7 columnas nuevas, las 2 tablas de log, el índice y las 4 foreign keys de
autoría creados; 26 de 27 filas de `ManualEntries` quedaron asignadas a la
empresa 6 (AVP); y **ningún campo preexistente cambió** (se comparó fila
por fila contra una copia tomada antes de migrar). Falta **desplegar el
código** para que el filtro de empresa y el log empiecen a actuar.

Todavía no hay pantalla para *ver* el historial: una vez desplegado los
datos se guardan, pero por ahora se consultan por SQL.

**Una fila quedó sin empresa** y hay que decidir qué hacer:
`ManualEntries` id 40 — `userId` 2926, 2 h de HE del 2026-06-05, nota
"corte de energía". Su `USERID` no existe en `users`, por eso el backfill
no pudo resolverla. Como producción tiene **una sola empresa** (id 6,
AVP), asignarle `tenant_id = 6` es casi seguro lo correcto; mientras siga
en `NULL` esa entrada no se ve desde la aplicación.

## ⚠️ CORRECCIÓN (2026-09-20): el hallazgo de abajo estaba MAL

**Todo lo que sigue en esta sección se escribió sobre una suposición falsa y
se corrigió al día siguiente. Léelo con esta advertencia delante.**

Afirmé que 81.622 fichajes (52 %) no llegaban a ningún informe y que ~95
empleados activos tenían horas sin liquidar. **Es falso.** Supuse que el
informe resolvía cada fichaje por la cadena
`Checkins → users → user_employee_map → employees`, y **nunca verifiqué la
consulta real**. La de `/attendance-range` (`horasdedica.js:3109`) hace:

```sql
LEFT JOIN users u
  ON (u.USERID = c.USERID OR CAST(u.Badgenumber AS CHAR) = CAST(c.USERID AS CHAR))
```

Ese `OR ... Badgenumber` es el puente que me faltaba. El fichaje entra con
`USERID = 9412`, la fila del usuario de reloj 66 tiene `Badgenumber = '9412'`,
y engancha igual. **Verificado contra producción**: las 52 fichadas de
septiembre del legajo 9412 dan exactamente los 13 días que muestra
Presentismo.

Lo detectó el dueño del producto mirando su propia pantalla: *"¿este Malerba?
Ya estaba, me parece"*.

**Medición correcta** (producción, 2026-09-20):

| | |
|---|---:|
| Fichajes totales | 156.732 |
| Llegan a un empleado | **99.995 (63,8 %)** |
| No llegan a nadie | **56.737 (36,2 %)** |

Y los que no llegan **no son los 100 que señalé**: en su mayoría son `USERID`
bajos (4, 5, 6, 10, 105, 10001) que **no corresponden a ningún legajo** —
usuarios de administración o del propio reloj (el `USERID` 10 solo junta
19.115). De los más recientes sin empleado, apenas 2 corresponden a un legajo
real. Sólo 18 `USERID` distintos sin empleado tuvieron actividad en 60 días.

O sea: **hay un hueco, pero es mucho más chico y de otra naturaleza.** Queda
pendiente analizarlo de nuevo.

**Qué se retiró por esto**: el bloque *"Fichadas que no le están llegando a
nadie"* de la pantalla de matching (publicado y retirado el mismo día) y su
botón de reparación. Los endpoints `GET /api/matching/suspicious` y
`POST /api/matching/repair` siguen existiendo pero **no deben usarse**: la
"reparación" tocaría 100 vínculos que no están rotos.

**La lección**: antes de declarar que un dato no llega a destino, hay que
leer la consulta que lo lleva. Construí un diagnóstico, lo escribí como
hallazgo grave, lo guardé en memoria y desplegué una función entera — todo
sobre una cadena de JOINs que supuse en vez de verificar.

---

## 🔴 Hallazgo GRAVE sin resolver (2026-09-19): fichajes sin usuario — ⚠️ VER CORRECCIÓN ARRIBA

Encontrado por casualidad al investigar la fila huérfana de arriba.
**81.622 de los 156.732 fichajes de producción (52 %) pertenecen a 104
`USERID` que no tienen ninguna fila en `users`.** No es un problema de
empresa mal asignada: se verificó que esos `USERID` no existen en `users`
para *ninguna* empresa (0 casos de desajuste de `tenant_id`). Tampoco
están en `user_employee_map`, o sea que no se pueden resolver a ningún
empleado.

Lo preocupante es que **no son historia vieja**: 96 de esos 104 ficharon
en los últimos 60 días (10.533 fichajes), varios el 2026-09-18.

Por qué importa: toda la cadena de reportes va
`Checkins → users → user_employee_map → employees`. Si falta el eslabón
`users`, esos fichajes no aparecen en Presentismo ni en los cálculos de
horas extra. Y peor: la pantalla de **Matching**, que existe justamente
para detectar usuarios de reloj sin vincular, lee de `users` — así que
estos casos **no aparecen ni siquiera como pendientes**. Son invisibles
para la herramienta hecha para encontrarlos.

### CAUSA CONFIRMADA (2026-09-20): dos bugs que se potencian

Son **dos** fallas distintas, y ninguna sola explica el cuadro completo.
Las dos son, de fondo, **el mismo error: elegir una fila arbitraria de un
conjunto donde la elección importa.**

**Bug A — el matching automático vinculó al usuario equivocado.**
Confirmado con datos: **99 de los 100 vínculos rotos tienen
`match_type = 'auto_employee_id'`**, que es el que escribía
`endpoints-employees.js` (hoy archivo muerto, no lo monta nadie):

```js
const [users] = await db.query(
  'SELECT USERID FROM users WHERE Badgenumber = ? AND USERID > 10', [emp.employee_id]);
if (users.length === 0) continue;
const userId = users[0].USERID;   // <-- sin ORDER BY: fila arbitraria
```

Cuando había DOS filas con el mismo legajo —la vieja importada por CSV y
la del reloj— `users[0]` sin `ORDER BY` devuelve la del `USERID` más bajo
(orden de clave primaria). O sea: eligió siempre la importada, que nunca
fichó, y nunca la del reloj. Se ve en los datos: el `USERID` vinculado es
*siempre* menor que el que ficha (435 < 1400, 440 < 9467, 246 < 649).

Contexto que lo hace posible: de las 499 filas de `users`, **243 tienen
`USERID` igual a su legajo** (origen reloj) y **256 no** (origen
importación). Dos poblaciones mezcladas en la misma tabla.

**Bug B — el script de limpieza borró la fila que sí se usaba.** Ese script busca
`Badgenumber` repetidos en `users`, **se queda con el primer `USERID` que
devuelve `GROUP_CONCAT` (o sea, uno arbitrario) y borra los demás**. Al
borrarlos limpia `specialusers`, `userexclusions`, `dailyattendance`,
`dayassignments` y `user_employee_map`… **pero nunca toca `Checkins`, ni
reasigna esos fichajes al `USERID` que conserva**. Ahí nacen los
huérfanos. Además, al final agrega una clave única por `Badgenumber`, que
impide que el agente vuelva a crear la fila borrada (hoy esa clave existe
como `uq_users_tenant_badge (tenant_id, Badgenumber)`).

Y eligió mal cuál conservar. En este reloj **el `USERID` es igual al
legajo**. Los fichajes reales entran con `USERID` = legajo, pero el script
conservó unas filas viejas con otro `USERID` que el reloj no usa:

```
MENDOZA, Bruno Ezequiel  legajo 9467: ficha como USERID 9467 (2011 fichajes)
                                      pero está vinculado al USERID 440 (0 fichajes)
LATTANZI, Roberto        legajo 1400: ficha como USERID 1400 (494 fichajes)
                                      pero está vinculado al USERID 435 (0 fichajes)
```

Números que cierran el caso:
- **103 de los 104** `USERID` huérfanos coinciden exactamente con el legajo de un empleado; **95 son empleados activos**.
- **100 casos** en los que el `USERID` viejo ocupa el badge del legajo **y tiene 0 fichajes** — son filas fantasma.
- **62.507 fichajes recuperables** por esta vía.
- Solo **79 de las 499** filas de `users` recibieron algún fichaje en los últimos 60 días.
- De 160 empleados activos, **96 no tienen ni un fichaje resoluble**; 95 de ellos son estos casos.

**Por qué no se notó**: al no llegar los fichajes, esas personas aparecían
como ausentes; se las ocultó del informe ("para no tener 300 ausentes").
El parche escondió el síntoma, así que el problema dejó de verse. Era una
reacción razonable con la información que había.

### Plan de reparación (NO ejecutado, requiere aprobación)

Por cada empleado afectado, dentro de una transacción:
1. Borrar la fila fantasma de `users` (el `USERID` viejo, 0 fichajes) — libera el badge.
2. Insertar `users` con `USERID` = legajo, `Badgenumber` = legajo, `Name` = nombre del empleado, `tenant_id` = 6.
3. Re-apuntar `user_employee_map` del `USERID` viejo al nuevo.

Después: volver a mostrar a los empleados que se habían ocultado, y
**revisar horas extra retroactivas** — son ~95 personas cuyas horas no se
estaban calculando.

### Reglas de vinculación reforzadas (2026-09-20) — hecho

Nuevo módulo **`matchingRules.js`** (puro, 13 tests en `npm run test:unit`,
o sea que los corre el CI). Deja escrito el modelo que hay que respetar:

> **`USERID` es la llave interna del reloj: sólo une los fichajes con la
> fila de `users`. No identifica a nadie y no debe decidir nada.
> `Badgenumber` es el legajo real, y esa es la identidad.**

Qué cambió en `routes/matching.routes.js`:

1. **Desempate obligatorio**: si hay varios usuarios de reloj con el mismo
   legajo, gana **el que tiene fichajes**; a igualdad, el del fichaje más
   reciente; y sólo al final el `USERID` más bajo (para que el resultado
   sea repetible). El bug viejo saltaba directo a ese último paso. Hay un
   test que reproduce el caso Mendoza y se pone en rojo si alguien lo
   rompe.
2. **Una propuesta por empleado**, no una por usuario de reloj. Los
   candidatos descartados viajan en `alternatives` — verlos es lo que
   permite detectar que hay dos usuarios para la misma persona.
3. **El nombre corrobora, no decide.** Se midió contra los 478 pares
   reales: exigir nombre idéntico rechazaría el **83 %** de los vínculos
   buenos, porque el reloj casi siempre guarda sólo el apellido. Cada
   propuesta trae `nameEvidence`: `exacto` (82 casos) · `contiene` (363) ·
   `acentos` · `sin_nombre` · `no_coincide`.
4. **Nada se aplica solo.** Decisión explícita del dueño del producto: *"el
   matching impulsivo no será bueno, deberá ser el usuario que acepte cada
   matching"*. `/auto` y `/manual-bulk` sólo proponen y ahora lo dicen en
   la respuesta (`applied: 0`, `requiresConfirmation: true`). El único
   endpoint que escribe en `user_employee_map` es `POST /manual`, de a un
   vínculo. Los casos `sin_nombre` y `no_coincide` vienen con
   `preselected: false`: se muestran, pero exigen que alguien los mire.

5. **Contra qué dato se compara el Badgenumber, configurable por empresa.**
   El `Badgenumber` es la identidad, pero *identidad según qué*: cada
   empresa decide qué le carga al reloj al dar de alta a una persona, y
   puede ser el legajo o el DNI. Se guarda en `app_settings` como
   `matchingIdentityField` (`legajo` | `documento`), con `legajo` por
   defecto.

   - `GET /api/matching/identity-field` devuelve la opción elegida **y
     cuántos candidatos daría cada una** contra los datos reales. En AVP:
     `Legajo: 478 · Documento (DNI): 0`. La idea es no preguntar "¿es el
     legajo o el DNI?" a secas —que invita a adivinar— sino mostrar la
     evidencia y que la respuesta se vea sola. Configurar mal este campo
     es el error más caro posible en esta pantalla: vincularía a la
     persona equivocada.
   - `PUT /api/matching/identity-field` lo cambia, validado contra una
     lista blanca.
   - El nombre de la columna **nunca** sale del pedido: se busca en
     `IDENTITY_FIELDS` y cualquier valor desconocido cae en el default, así
     que no hay forma de interpolar texto arbitrario en la consulta. Hay
     tests que lo verifican explícitamente.
   - `/auto` devuelve `identityField` en la respuesta: quien revisa tiene
     que saber si está mirando coincidencias por legajo o por documento
     antes de aceptar nada.

   En AVP los largos confirman la elección sin lugar a dudas: los badges
   tienen 4 caracteres (440 de 499) y los DNI 8 (389 de 441).

**Falta la pantalla**: el backend ya devuelve la evidencia, pero el
frontend todavía no la muestra ni permite aceptar vínculo por vínculo.

### Bug de codificación del agente (2026-09-20) — corregido

Los nombres con eñe o acento llegaban **con la letra borrada**:
`CAÑETE → CAETE`, `AGÜERO → AGERO`, `Rubén → Rubn`. La letra no salía
cambiada, desaparecía — esa es la firma del problema.

Causa: `pyzk` decodifica con
`name.decode(self.encoding, errors='ignore')` y `encoding` es `'UTF-8'`
por defecto (`zk/base.py:1095`). El reloj guarda en una codificación de un
byte, así que la `Ñ` es `0xD1`, inválido en UTF-8 → **descartado en
silencio**.

Arreglo en `descarga-fichaje-py/zk_service.py`: se conecta con
`encoding='cp1252'`, que nunca descarta un byte. Y como hay relojes que sí
usan UTF-8 (leídos así saldrían como `CAÃETE`), `reparar_mojibake()`
detecta ese caso y lo deshace — el agente funciona con los dos tipos sin
configurar nada.

Verificado con `descarga-fichaje-py/test_encoding.py` (`python
test_encoding.py`), que reproduce el bug original y prueba los dos
escenarios sin necesitar el reloj.

**Los nombres ya guardados no se corrigen solos**: se arreglan cuando el
agente vuelva a subir la lista de usuarios. Mientras tanto, el matching
los tolera con el nivel `acentos`.

De paso quedó documentado el origen de los usuarios llamados `"9370"` o
`"2489"`: al enrolar una huella, `zk_service.py` escribe el legajo como
nombre (`conn.set_user(name=str(user_id))`). Mejora pendiente: pasarle el
nombre real del empleado.

### Para que no vuelva a pasar

- ✅ `scripts/cleanup-duplicate-users.js` — **ARREGLADO el 2026-09-20**. Ahora elige cuál conservar por evidencia (gana el que ficha, vía `rankCandidateUsers`), **mueve** los `Checkins` antes de borrar, **mueve en vez de borrar** las justificaciones y horas extra, trabaja por empresa (`--tenant=N`), no agrega ninguna UNIQUE KEY, y **simula por defecto** (hace falta `--aplicar`). Ya se puede correr.
- **El matching vivo tiene el mismo agujero de desempate.** En `routes/matching.routes.js`, `findAutoMatchPredictions` junta `users` con `employees` por legajo sin `ORDER BY` ni criterio de desempate, y `findMatchingUserForEmployee` usa `users.find(...)`, que devuelve el primero del array. Si vuelve a haber dos filas de `users` con el mismo legajo, puede repetir el error. **El desempate correcto es preferir la fila que TIENE fichajes** (y, a igualdad, la de fichaje más reciente) — nunca la primera que aparezca. Hoy no se dispara porque no quedan legajos duplicados, pero es una bomba de tiempo.
- Los dos archivos culpables (`endpoints-employees.js` y `scripts/cleanup-duplicate-users.js`) son **código muerto o de uso manual**: no los monta el servidor. Conviene borrar el primero; el segundo, arreglarlo o borrarlo.
- La ingesta debe **avisar** cuando llega un fichaje de un `USERID` que no existe en `users`, en vez de guardarlo en silencio. Hoy `insertCheckinsBatch` lo acepta sin chistar y nadie se entera nunca.
- Ese contador ("fichajes que no se pueden resolver a un empleado") debería estar a la vista en la pantalla de Matching o en el panel de sincronización.

## Problema ABIERTO ahora mismo (sin resolver, 2026-09-18)

**Síntoma reportado por el usuario**: al abrir el detalle
mensual/anual de un empleado en Presentismo, a veces (no siempre)
tarda hasta 10 segundos en mostrar algo, y a veces el calendario no
llega a cargar (quedan solo los 3 resúmenes de arriba). No es la
primera consulta la que falla — pasa en la 3ra o 4ta.

**Descartado con evidencia dura** (consulta de solo lectura a la base
de producción real, 2026-09-18): NINGUNA plantilla está en modo
`shadow`/`active` (4 de 4 en `legacy`), y la tabla
`rule_engine_shadow_diffs` tiene 0 filas. El motor nuevo no se está
ejecutando para nadie en producción hoy — **no es la causa**.

**Hipótesis todavía sin confirmar** (por orden de probabilidad):

1. **Pool de conexiones MySQL agotado bajo uso concurrente.** Ver
   comentario en `db.js`: el plan de Clever Cloud limita
   `max_user_connections` a 5, y el pool de este proceso usa
   `connectionLimit: 4` (con 1 de margen para scripts manuales). Si
   varias pantallas/usuarios piden datos a la vez (Presentismo,
   sincronización, etc.), las consultas nuevas pueden quedar en cola
   esperando una conexión libre — esto encajaría con "en la 3ra/4ta
   consulta, no en la primera".
2. **Costo intrínseco de `/attendance-range` para un rango anual** —
   365 días de un empleado, con varias sub-consultas (feriados,
   exclusiones, licencias, HE manual, marcadores). No debería tomar
   10 segundos por sí solo, pero no se descartó con una medición
   directa.
3. Algo en el propio Render/Clever Cloud (latencia de red variable,
   no relacionado al código).

**Se descartó también** un "cold start" de Render (el plan gratuito/de
entrada duerme el servicio tras inactividad) porque el usuario
confirmó que NO es la primera consulta la que falla.

**Próximos pasos para diagnosticar** (nadie los hizo todavía):
- Pedirle al usuario que abra la pestaña Network del navegador (F12)
  y mida cuánto tarda específicamente la petición a `attendance-range`
  cuando pasa esto, y si termina en 200 o en error/timeout.
- Revisar los logs de Render en el momento exacto de la lentitud
  (requiere acceso a la consola de Render, que el asistente de IA no
  tiene).
- Si se confirma la hipótesis del pool de conexiones: considerar subir
  el plan de Clever Cloud (más conexiones permitidas), o revisar si
  hay conexiones que no se liberan bien en algún camino de código.

## CI — tests automáticos (arrancado 2026-09-18)

### Qué es y por qué

"CI" (integración continua) significa que los tests corren **solos, en
los servidores de GitHub, cada vez que alguien sube código** — no
dependen de que alguien se acuerde de correrlos en su máquina. Si algo
se rompe, GitHub lo marca en rojo.

Esto no es teoría: el 2026-09-18 se pusheó a `main` (que Render
despliega automáticamente) sin correr los tests y antes de aplicar las
migraciones. Si alguien hubiera editado una plantilla de horario en esa
ventana, le habría dado un error de SQL. Con CI + branch protection eso
deja de ser posible.

### Qué quedó configurado

`.github/workflows/tests.yml` — corre en cada push a `main` y en cada
Pull Request. Ejecuta `npm run test:unit`.

### Qué cubre y qué NO (importante entender la diferencia)

De los **77** archivos de test del repo:

- **18 son "puros"**: no necesitan base de datos, ni el servidor
  levantado, ni internet. Son 207 tests que corren en ~2 segundos.
  **Estos son los que corren en CI hoy.** Y no es poca cosa: son los
  del motor de cálculo (tolerancias, clasificación de horas extra,
  turno partido, cruce de medianoche, fichajes duplicados) — o sea, la
  parte que define cuánto cobra cada persona.
- **59 son de integración**: necesitan MySQL con el esquema completo,
  el backend corriendo en `localhost:3000`, y credenciales reales de
  Firebase (piden un token de verdad a Google). **Estos NO corren en CI
  todavía** — hacerlo es la "Fase 2" del backlog.

La razón de arrancar solo con los puros: un CI que falla por problemas
de infraestructura (y no por bugs reales) se vuelve ruido, la gente
aprende a ignorarlo, y termina siendo peor que no tenerlo. Mejor
empezar con algo que siempre es señal verdadera, y ampliarlo después.

### Cómo agregar un test nuevo a CI

Si el test nuevo **no** usa base ni servidor (o sea, no tiene
`require('dotenv')`, ni `require('../db')`, ni `TEST_BASE_URL`, ni
`mysql.createConnection`), agregá su nombre a la lista del script
`test:unit` en `package.json`. Si sí los usa, por ahora queda fuera de
CI y solo corre con `npm test` en local.

### Lo que falta hacer A MANO en GitHub (no se puede por código)

**Branch protection** — hoy cualquiera (incluida una IA, o vos apurado
un viernes) puede pushear directo a `main` y disparar un deploy. Para
cerrarlo, en **cada uno de los dos repos**:

1. GitHub → repo → **Settings** → **Branches** → **Add branch ruleset**
   (o "Add rule" según la versión).
2. Branch name pattern: `main`.
3. Tildar **"Require a pull request before merging"** (obliga a que todo
   cambio pase por un PR, aunque lo apruebes vos mismo).
4. Tildar **"Require status checks to pass before merging"** y elegir el
   check **"Tests de lógica (sin base de datos)"** (aparece en la lista
   recién después del primer push que dispare el workflow).
5. Guardar.

A partir de ahí: si los tests fallan, GitHub no deja mergear. Y como
Render despliega desde `main`, no puede llegar a producción algo con
los tests en rojo.

## Trabajo pendiente (backlog, ninguno arrancado)

1. **Resolver el problema de lentitud de arriba.**
2. **Plan "Camino al 100%"** (guardado en
   `C:\Users\EURO\.claude\plans\staged-sauteeing-starfish.md` en la
   máquina del desarrollador que usó Claude Code — si no se tiene
   acceso a ese archivo, esto resume lo que falta):
   - **Fase 2 (parcialmente hecha)**: ✅ CI andando con los 18 tests
     puros (ver sección "CI" arriba). ⏳ Falta llevar a CI los 59 tests
     de integración: hay que levantar MySQL como *service container* en
     el workflow, cargar el esquema (`schema/full_schema_snapshot.sql`)
     + todas las migraciones en orden, arrancar el backend en segundo
     plano, y guardar el service account de Firebase como *secret* del
     repo (`firebaseTestAuth.js` ya soporta leerlo de la variable de
     entorno `FIREBASE_SERVICE_ACCOUNT`). Ojo con dos cosas al hacerlo:
     el test de MercadoPago falla siempre porque llama a la API real
     (hay que aislarlo o excluirlo), y los tests piden tokens reales a
     Google, que rate-limitea si se corre la suite muchas veces
     seguidas (pasó durante el desarrollo).
   - **Fase 3**: ⏳ activar branch protection en ambos repos — pasos
     exactos documentados en la sección "CI" de arriba. **Lo tiene que
     hacer el usuario a mano en GitHub**, no se puede por código.
   - **Fase 4**: disciplina de "definición de terminado" (cada cambio
     con su test antes de mergear) — ya se venía siguiendo de hecho
     durante todo el desarrollo del motor de reglas.
3. **Si en algún momento se activa `rules_engine_mode='active'` en una
   plantilla real**: hacerlo con cautela, idealmente después de un
   período en `shadow` sobre esa misma plantilla para comparar contra
   Legacy sin sorpresas (ver Hallazgo #5/#9 arriba). Al día de hoy
   nunca se corrió `shadow` contra datos reales de producción.

## Cómo correr todo localmente

```
cd BackHorasExtras
npm install
npm test              # usa la base de test local (ver .env), 513+ tests
node horasdedica.js   # levanta el backend en localhost:3000

cd horas-dedica-angular
npm install
npm run build          # build de producción
npm run deploy:preview # publica a un canal de Firebase preview (no toca el sitio real)
npm run deploy:live    # publica al sitio real -- usar con cuidado
```
