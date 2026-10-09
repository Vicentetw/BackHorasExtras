# Superadmin "trabajando en una empresa" (modo soporte) y Registro de actividad

Pedido del dueño (2026-10-09): *"toda la web para superadmin debe estar aislada
al seleccionar una empresa… como sé a qué empresa le estoy cargando un
feriado… con auditoría de quién lo ha creado, no quiero que un empleado me
acuse como superadmin de cargar un feriado".*

## El problema que había

El superadmin es "dueño de la plataforma": el servidor no le filtraba nada.
Cada pantalla intentaba arreglarlo con su propio selector de empresa
(Feriados, Marcadores, Importar fichajes…), pero muchas no lo tenían. Por
ejemplo, en Horas Extra por Régimen elegía "Empresa Demo" y veía los
empleados de AVP. Y al guardar algo sin empresa elegida, el dato podía quedar
"global" y aplicarse a todas.

## La solución: una sola empresa de trabajo para todo el sistema

En lugar de un selector por pantalla, el superadmin elige **arriba** "en qué
empresa trabaja". Desde ese momento, para el servidor **es un administrador
de esa empresa**:

- ve solo los datos de esa empresa, en todas las pantallas a la vez;
- lo que crea queda en esa empresa: no hay forma de que quede en otra ni que
  quede "global";
- no tiene poderes de superadmin mientras tanto (no puede crear empresas,
  por ejemplo).

Por qué así y no arreglando pantalla por pantalla: el aislamiento entre
empresas ya está hecho y probado para los clientes (todas las rutas usan la
empresa del usuario). Si el superadmin pasa a "ser" un usuario de la empresa,
hereda ese mismo aislamiento en todas las pantallas, incluidas las que se
hagan en el futuro. Arreglar cada pantalla por separado deja huecos, que es
justo lo que pasó.

### Cómo funciona por dentro

1. El frontend guarda la empresa elegida (`core/empresa-de-trabajo.ts`, en el
   `localStorage` del navegador) y le agrega a cada pedido la cabecera
   `X-Empresa-Trabajo: <id>`.
2. El servidor (`appUserMiddleware.js`) la acepta **solo si quien la manda es
   superadmin**. A un usuario común se le ignora: no puede usarla para
   meterse en otra empresa. Si la empresa no existe → 400.
3. Con la cabecera, `req.appUser` pasa a tener la empresa elegida,
   `isSuperadmin: false`, todos los permisos de una empresa y un dato extra
   `soporte` (quién es de verdad). El `id` sigue siendo el suyo: lo que haga
   queda a su nombre.
4. Las pantallas y rutas **de plataforma** (Empresas, Facturación, Planes,
   Historial de pagos, Seguridad, Solicitudes de alta, y la campanita) no
   llevan la cabecera: ahí sigue siendo superadmin.
5. Sin empresa elegida, las pantallas con datos de una empresa (Empleados,
   Presentismo, Feriados…) mandan a **Elegir empresa** en vez de mostrar
   todas mezcladas. Usuarios y Registro de actividad sí se abren sin empresa
   (sirven para toda la plataforma).

Mientras trabaja en una empresa ve una franja: *"Estás trabajando en X como
soporte. Lo que cargues queda en esta empresa y registrado a tu nombre"*, con
"Ver registro" y "Salir de la empresa". También se entra desde Empresas >
"Trabajar en ella".

## Registro de actividad

Tabla `registro_actividad` (migración `20261017_registro_actividad.sql`).
Un middleware (`registroActividad.js`) guarda **todo pedido que cambia algo**
(POST, PUT, PATCH, DELETE) de un usuario identificado:

- quién (cuenta y email), cuándo (en UTC), en qué empresa;
- qué hizo, en palabras ("Creó/cargó un feriado", "Borró una exclusión");
- si salió bien o fue rechazado (un intento también es información);
- si lo hizo **el soporte de la plataforma** (`como_soporte = 1`);
- lo que se envió, sin contraseñas, tokens ni claves, recortado a 4000
  caracteres.

Se guarda **después** de responder (evento `finish`), así que nunca demora ni
rompe nada; si falla (por ejemplo, falta la migración), se avisa una vez en el
log del servidor y el sistema sigue igual.

Es **solo de agregar**: el sistema nunca modifica ni borra filas. No hay
pantalla para editarlo. Un registro que se puede editar no prueba nada.

Lo ve cada empresa en **Administración > Registro de actividad** (permiso
`users:read`), solo lo suyo, **incluido lo que hizo el soporte en ella**. Eso
es lo que responde "¿quién cargó este feriado?". El superadmin, desde la
plataforma, ve todas las empresas.

Por qué automático y no ruta por ruta: así no hay que acordarse de "agregar
auditoría" en cada ruta nueva. La auditoría fina que ya existía (horas
cargadas a mano, exclusiones: valor de antes y de después) sigue igual; esto
es el "quién y cuándo" general.

## Feriado en varias empresas

Empresas > **"Feriado en varias empresas"** (solo superadmin, desde la
plataforma): fecha, nombre, tipo y la lista de empresas con "Todas /
Ninguna". Cada empresa recibe **su propia copia** (la puede editar o borrar
sin tocar a las demás). La que ya tenía un feriado general ese día se
saltea, y se informa cuál y por qué. En el registro de cada empresa queda
"Creó un feriado (cargado por el superadmin en varias empresas)", marcado como
soporte. Ruta: `POST /api/holidays/varias-empresas`.

## Pruebas

- `test/superadmin-empresa-trabajo.test.js` (9 casos): solo ve la empresa
  elegida, lo creado queda ahí aunque mande otra empresa en el cuerpo, la
  cabecera no le sirve a un usuario común, 400 si la empresa no existe, sin
  plataforma en modo soporte, registro con autor y soporte, cada empresa ve
  solo su registro, sin secretos, la hora en UTC, feriado en varias empresas.
  Sin la tabla: los 6 del modo soporte pasan y los 3 del registro se saltean
  (y la pantalla avisa `faltaMigracion`).
- Navegador (local): elegir empresa, que no aparezcan empleados de otra en 6
  pantallas, que todos los pedidos lleven la cabecera salvo los de plataforma,
  que Empresas siga como superadmin, el feriado en varias, el registro, el
  celular (390 px) y salir.

## Lo que queda abierto (propuestas, no hechas)

- Que el cliente **autorice** el acceso del soporte (con vencimiento) antes de
  que pueda entrar. Hoy el superadmin entra cuando quiere; queda registrado y
  el cliente lo ve.
- Cobrar la puesta en marcha como servicio al crear la empresa.
