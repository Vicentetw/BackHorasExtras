# Alta de empresas: solicitud que aprueba el superadmin

Decisión del dueño del producto (2026-10-01): **cualquiera puede registrarse en
la página, pero nada se activa hasta que el superadmin lo aprueba**, después de
hablar con la persona.

Antes, el formulario creaba la empresa, el mes de prueba y el usuario al
instante, y mandaba el mail para la contraseña.

## El recorrido

1. **El visitante envía el formulario** (`POST /api/public/signup`). Se guarda
   una fila en `signup_leads` con estado `pending`. No se crea nada más y no se
   manda ningún mail.
2. **El superadmin se entera** por Telegram y por la campanita (`avisos.js`,
   tipo `alta`).
3. **El visitante puede chatear** con el vendedor virtual mientras espera.
4. **El superadmin decide** en la pantalla **Solicitudes de alta**
   (`/api/solicitudes-alta`, solo superadmin):
   - **Aprobar** (puede corregir el nombre de la empresa y el mail). Crea la
     empresa, el mes de prueba (arranca ese día) y el usuario "Administrador de
     Empresa", que queda como **titular**: quien paga y el único que puede
     pedir la baja. Firebase le manda el mail para elegir la contraseña. El
     código está en `motor-laboral/services/altaEmpresa.js`. Si algo falla a
     mitad de camino, se deshace lo creado y la solicitud sigue pendiente.
   - **Rechazar**, con un motivo obligatorio.

   En los dos casos queda registrado quién lo resolvió y cuándo.

Migración: `20261012_solicitudes_de_alta.sql`. Agrega el estado `rejected` y
las columnas `reviewed_by`, `reviewed_at` y `review_note`.

## Reglas de seguridad

- **La misma respuesta para todos.** Un mail nuevo y uno que ya tiene cuenta
  reciben exactamente la misma respuesta (`{ ok, leadId, chatToken, pendiente }`)
  y ven el mismo texto, que incluye "si ya tenés una cuenta con este mail, esta
  solicitud no tiene efecto". Así el formulario no sirve para averiguar quién
  es cliente (hallazgo F-04).
- **Ningún mail automático.** Antes, a quien ya tenía cuenta se le mandaba el
  mail de recuperar contraseña. Eso dejaba que cualquiera le hiciera llegar
  mails nuestros a un tercero. Quien olvidó la clave usa "Olvidé mi contraseña"
  en la pantalla de ingreso.
- **Una sola solicitud viva por mail.** Reenviar el formulario actualiza la que
  ya existe: no crea otra fila, ni otro aviso, ni otro cupo de chat.
- **Todo lo que escribe un desconocido se recorta** al largo de su columna, y
  el mail se valida y se guarda en minúsculas.
- **El aviso de Telegram escapa** el nombre de la empresa y el detalle: se
  manda en HTML y esos textos los escribe un desconocido.
- **Topes propios de la parte pública**, separados de los del sistema: por
  minuto y por día, por conexión (`SIGNUP_TOPE_DIARIO_POR_IP`,
  `CHAT_TOPE_DIARIO_POR_IP`). Si alguien bombardea el formulario, se corta el
  formulario y no Presentismo.

## El chat de ventas

- **Sabe dónde está el visitante.** El chat solo aparece después de enviar la
  solicitud, y el prompt ahora lo dice: la persona ya envió el formulario, su
  cuenta todavía no existe y el equipo la va a contactar. Antes mandaba a
  "completar el formulario de arriba" a quien acababa de completarlo.
- **No revela el estado de la solicitud.** No afirma ni niega que la persona
  tenga cuenta.
- **Cupo por mail, no por envío** (6 preguntas cada 30 días). Refrescar la
  página o reenviar el formulario no lo reinicia.
- **Recuperar la conversación.** La página guarda el token del chat en
  `sessionStorage` (vive lo que dura la pestaña) y al refrescar llama a
  `POST /api/public/chat/estado`. Sin token válido no devuelve nada.
- **Tope diario global de gasto** (`motor-laboral/services/presupuestoChat.js`,
  300 mensajes por día, configurable con `CHAT_VENTAS_TOPE_DIARIO`). Al llegar,
  el chat deja de responder, manda a WhatsApp y avisa por Telegram una vez.
- **Trato respetuoso garantizado en el servidor** (incidente del 2026-10-01):
  ver `salesChatService.js`, sección "TRATO RESPETUOSO".

## Titular

El titular (`tenants.titular_email`) lo designa solo el superadmin:

- al **aprobar** una solicitud, queda quien se registró (con el mail que el
  superadmin confirme);
- en **Empresas > Editar**, eligiéndolo de la lista de usuarios de esa empresa.
  Si no está en la lista, se crea primero en Usuarios y Roles.

## Las dos copias de la landing

La página existe en dos lugares y tienen que quedar iguales:

- `horas-dedica-angular/public/landing.html` (se publica junto con el sistema);
- el repo aparte `landing-horas-dedica` (`C:\\angular\\horas-dedica-landing`),
  creado para sacarla del sistema.

## Pendiente (siguiente etapa)

- Dominio propio de la marca; dejar una sola landing, en su dominio.
- Mover la recepción de solicitudes y el chat a un servicio aparte, con un
  usuario de base que solo pueda escribir en `signup_leads`.
