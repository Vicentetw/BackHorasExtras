# Plan: que un cliente exigente compre Horas Dedica (2026-10-18)

> Pedido del dueño: "realicemos un plan paso a paso para que tú decidas comprar
> el sistema, no elijas el camino fácil, elige el mejor".
> Punto de partida: la auditoría general del 2026-10-18 (en el chat):
> confiable para controlar asistencia, pero le faltan seguridad, operación y
> papeles que cualquier comprador revisa.

**Cómo leer este plan.** Cada fase tiene un **criterio de aceptación**: lo que
yo, como comprador, comprobaría. Una fase no está terminada hasta cumplirlo,
aunque el código esté escrito. El orden importa: primero lo que puede causar
un daño grave (fuga de datos, pérdida de datos), después la forma de trabajar,
y al final lo que hace al producto más fácil de vender.

---

## Fase 0 — Higiene de seguridad (lo urgente)

| Paso | Quién | Por qué |
|---|---|---|
| 0.1 Repositorio del backend **privado** en GitHub. En Render: Account Settings → GitHub → "Configure" (la app de Render en GitHub) → darle acceso a ese repositorio. Recién ahí aparece para elegirlo. | Dueño | Hoy cualquiera lee cómo funciona el sistema por dentro: más fácil buscarle fallas. |
| 0.2 Escaneo de secretos de TODO el historial con una herramienta dedicada (gitleaks). | Claude | El escaneo rápido del 18/10 no encontró nada (solo la clave web de Firebase, que es pública por diseño), pero un comprador pide la prueba formal. |
| 0.3 Actualizar las librerías con fallas conocidas: `proxy-addr` (crítica, permite falsear la IP: afecta los límites por IP), y las 4 altas del frontend. Con la suite completa en verde después. | Claude | Es lo primero que muestra cualquier escáner automático. |
| 0.4 Base de datos con conexión **cifrada**: confirmar `MYSQL_SSL=require` en Render y que el servidor arranque sin el aviso "MySQL sin TLS". | Dueño + Claude | Sin cifrado, los datos de los empleados viajan legibles entre Render y la base. |
| 0.5 CSP (protección contra código inyectado) de "solo reportar" a **bloquear**, después de revisar los reportes de estas semanas. | Claude | Hoy avisa pero no protege. |

**Criterio de aceptación:** escaneo de secretos limpio y guardado como
evidencia; `npm audit` de producción sin críticas ni altas; el servidor
conecta con TLS; securityheaders.com da A o A+; la CSP bloquea sin romper
pantallas (probado en Chrome).

---

## Fase 1 — Acceso: segundo factor y sesiones

**Segundo factor: con una app de códigos** (Google Authenticator, Microsoft
Authenticator, Authy), el método "TOTP".
- **Por qué TOTP y no SMS:**
  - El SMS cuesta por mensaje y se puede robar duplicando el chip (estafa
    común en Argentina).
  - El TOTP no cuesta nada por uso y funciona sin señal.
  - Firebase (el login que ya usa el sistema) lo soporta al activar
    "Identity Platform", que es gratis hasta 50.000 usuarios activos por mes.
- **Obligatorio para administradores y superadmin.** Opcional para el resto.
  El portal del empleado queda sin él, para no frenar a 480 personas.
- **Se exige en el SERVIDOR, no solo en la pantalla.** El token de Firebase
  dice si se entró con segundo factor. Sin eso, las rutas de administración
  responden "falta el segundo factor". Si se exigiera solo en la pantalla, se
  podría saltear.
- **Recuperación:** si alguien pierde el celular, el titular de la empresa o
  el superadmin le resetea el segundo factor y queda registrado quién y
  cuándo. Firebase no da códigos de recuperación propios: el reseteo
  controlado los reemplaza.
- **Puesta en marcha sin cortar a nadie:** primero opcional, con un aviso en
  Inicio. Después de una fecha que cada empresa ve con anticipación,
  obligatorio.
- **Sesiones:** cierre por inactividad para administradores, y "cerrar mis
  sesiones en otros dispositivos".
- **Registro de actividad:** sumar los inicios de sesión, los fallidos y los
  cambios de segundo factor.

**Criterio de aceptación:** un administrador sin segundo factor no puede
hacer nada aunque llame a la API a mano (hay un test que lo prueba); el
reseteo queda en el registro; se probó el flujo completo en un celular real.

---

## Fase 2 — Que nunca se pierdan datos y que se sepa si algo falla

| Paso | Por qué |
|---|---|
| 2.1 **Backup automático fuera de la PC:** diario, cifrado, en un almacenamiento en la nube de otra cuenta y otro proveedor que la base. Se guardan los últimos 30 días y uno por mes durante 12 meses. | Hoy el backup vive solo en tu PC: si se rompe, se la roban o le entra un virus, se pierde todo. |
| 2.2 **Prueba de restauración automática semanal:** restaura el último backup en una base aparte, cuenta registros, corre un cálculo de un mes y avisa si algo no coincide. | Un backup que nunca se restauró no es un backup. |
| 2.3 **Plan de recuperación escrito:** cuánto se puede perder (máximo 24 h de datos) y en cuánto se vuelve a estar en línea (4 h), paso a paso. | El comprador lo pide, y en una emergencia no hay que improvisar. |
| 2.4 **Monitoreo con alertas:** un servicio externo consulta `/health` cada minuto y avisa por correo o Telegram; los errores del servidor y de la pantalla se registran para verlos (Sentry o similar). | Hoy, si el sistema se cae a la noche, te enterás cuando un cliente se queja. |
| 2.5 **Render en un plan que no "duerme"** y con el servidor cerca de la base. | Para que la primera consulta del día no tarde. |

**Criterio de aceptación:** simulacro de recuperación hecho y cronometrado,
con fecha; alerta recibida al apagar el servidor a propósito; informe de
restauración semanal en verde 4 semanas seguidas.

---

## Fase 3 — Forma de trabajar: que un cambio no rompa producción

| Paso | Por qué |
|---|---|
| 3.1 **Entorno de prueba (staging):** un segundo servidor y una segunda base, con una copia de datos **anonimizada** (nombres y legajos cambiados). Todo se publica ahí primero. | Hoy se publica directo a producción. |
| 3.2 **CI obligatorio:** la suite completa corre en cada cambio y GitHub no deja publicar en `main` si falla. | Hoy depende de acordarse de correr los tests. |
| 3.3 **Migraciones registradas:** una tabla que guarda cuáles se aplicaron; el servidor avisa al arrancar si falta alguna, y en staging se aplican solas. En producción las sigue corriendo el dueño, pero con una lista que no se puede olvidar. | Hoy hay que revisar el backup para saber qué migraciones tiene producción. |
| 3.4 **Partir el archivo principal (6600 líneas) en módulos**, empezando por el cálculo de asistencia, de a un pedazo por vez y sin cambiar resultados, protegido por los tests de "una sola verdad" y de caracterización. | Hoy cada cambio toca un archivo enorme: más lento y más riesgo. |
| 3.5 **Manual de operación** para que otra persona pueda seguir: cómo publicar, cómo restaurar, cómo dar de alta una empresa, dónde está cada cosa. | Hoy todo depende de una persona. El comprador pregunta qué pasa si esa persona no está. |

**Criterio de aceptación:** un cambio de prueba hecho de punta a punta sin
tocar producción hasta el final; un test fallando bloquea la publicación;
otra persona sigue el manual y publica sin ayuda.

---

## Fase 4 — Papeles: legal y comercial (Argentina)

| Paso | Por qué |
|---|---|
| 4.1 **Política de privacidad y términos y condiciones**, publicados en la página de venta y aceptados al dar de alta una empresa (con fecha y versión guardadas). | Ley 25.326 de datos personales: se manejan datos de empleados. |
| 4.2 **Registro de la base de datos ante la AAIP** (Agencia de Acceso a la Información Pública). | Obligatorio para bases con datos personales. |
| 4.3 **Contrato de encargado de tratamiento** con cada cliente: el cliente es el dueño de los datos, Horas Dedica los procesa, qué medidas de seguridad hay, qué pasa al terminar. | Lo pide cualquier empresa mediana o su abogado. |
| 4.4 **Nivel de servicio (SLA):** disponibilidad comprometida (ej. 99,5 % mensual), horario y tiempos de respuesta de soporte, cómo se avisan los mantenimientos. | El comprador necesita saber qué puede exigir. |
| 4.5 **Exportación completa de los datos** del cliente (fichajes, empleados, configuración, cierres) en Excel o CSV, y **baja con borrado certificado**. | "Mis datos son míos y me los puedo llevar". |

Los textos legales conviene que los revise un abogado. Yo armo el borrador
técnico: qué datos se guardan, dónde, cuánto tiempo y con qué medidas.

**Criterio de aceptación:** documentos publicados y versionados; alta de
empresa con aceptación registrada; una exportación completa de AVP abierta
en Excel; constancia de registro ante la AAIP.

---

## Fase 5 — El producto que se vende solo

| Paso | Por qué |
|---|---|
| 5.1 **"Esta plantilla no coincide con cómo fichan":** detector automático que compara la plantilla con los fichajes reales de las últimas semanas y propone corregirla. | Lo vimos con AVP: si la plantilla está mal, los números están mal. |
| 5.2 **Reglas pendientes de horas extra, configurables por empresa:** "fin sin inicio" (marca 10 sin 9), "un regreso oficial no cuenta", horas extra por tipo de día (sábado, domingo, feriado). | Completan el cálculo para cualquier empresa. |
| 5.3 **El turno de hoy que todavía no empezó no es "Ausente".** | Es un error visible en una demo. |
| 5.4 **Asistente de puesta en marcha:** una empresa nueva queda configurada sola en menos de un día (horario, plantillas, reloj, horas extra), con ayuda en cada paso. | El dueño no va a configurar 150 empresas. |
| 5.5 **Que la app abra rápido en el celular:** pantallas que se cargan cuando se usan; menos de 500 KB al abrir (hoy ~1 MB). | La mayoría entra desde el celular. |
| 5.6 **Demo y video** con "Empresa Demo": guion de 10 minutos que muestra lo que diferencia al producto (un solo número, cada número explicado, días a revisar, cierre con ajustes, portal). | Lo están pidiendo los clientes. |

**Criterio de aceptación:** una persona que no conoce el sistema configura
una empresa nueva siguiendo solo el asistente; el video se graba de corrido
sin errores en pantalla; la app abre en menos de 3 segundos en un celular
común con 4G.

---

## Fase 6 — La prueba del comprador (piloto)

Lo que yo haría antes de pagar:
1. **Un mes de piloto en paralelo** a mi forma actual de calcular horas extra.
2. **Conciliación:** comparar persona por persona lo que da el sistema contra
   lo que liquidé yo. Cada diferencia tiene que tener una explicación
   visible en el detalle del día.
3. **Cierre del mes** en Liquidación, una corrección posterior y verificar
   que aparezca como ajuste en el mes siguiente.
4. **Simulacro:** pedir mis datos exportados y pedir la restauración de un
   dato borrado por error.

**Criterio de aceptación:** cero diferencias sin explicación. Ahí pago la
suscripción.

---

## Al final — Ordenar las cuentas de Google/Firebase (pedido del dueño, 2026-10-18)

Hoy hay dos cuentas de Google, por error de origen: una es dueña del proyecto
de **login** (`asistenciatw`) y otra del de **la página** (`horasdedicacionavp`).
Ver `MAPA_FIREBASE_Y_CUENTAS.md`.

**Lo mejor, y no lo más fácil:** no mover proyectos de cuenta. Se agrega la
cuenta definitiva como **Propietario** en los dos proyectos (Firebase →
Configuración del proyecto → Usuarios y permisos). Después se prueba todo con
ella (publicar, consola de login, Google Cloud) y recién entonces se quita la
otra.
- Los proyectos y las cuentas de los usuarios **no se tocan**: cero riesgo
  para el login.
- La cuenta definitiva conviene que sea **de la empresa** (no personal), con
  segundo factor activado y su recuperación anotada en el gestor de
  contraseñas.
- La facturación de Google Cloud (si hay plan Blaze) también pasa a esa
  cuenta.

**Criterio de aceptación:** con una sola cuenta se publica la página, se ve
la consola de login y se administra Google Cloud de los dos proyectos; la otra
ya no figura en ninguno.

---

## Orden y por qué

0 → 1 → 2 primero, porque son los riesgos que no tienen vuelta atrás (una
fuga de datos o una pérdida de datos). 3 hace que todo lo demás se pueda
cambiar sin miedo. 4 se puede trabajar en paralelo, porque depende sobre todo
de un abogado. 5 y 6 al final: venden, pero sobre una base que ya es segura.

Estado de cada paso: se anota en `ESTADO_PROYECTO.md` ("EMPEZÁ ACÁ").
