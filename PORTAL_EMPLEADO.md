# Portal del empleado

Cada empleado entra con su mail y ve **solo lo suyo**: sus fichajes, sus días,
sus horas extra y lo que se le liquidó. La etapa 1 es de **solo lectura**.

Hecho en la rama `feature/portal-empleado`. Publicado el 2026-10-01 con el
módulo apagado para todas las empresas. Migración: `20261010_portal_empleado.sql`.

## Decisión de producto: incluido en el plan, no se cobra por persona que entra

- Los planes ya cobran por empleado (`plans.price_per_employee_usd`): una
  empresa de 400 personas ya paga 80 veces más que una de 5. Cobrar además cada
  ingreso haría que la empresa lo apague para ahorrar.
- Le ahorra trabajo a RRHH (menos "¿cuántas horas extra tengo?"), y cuantos más
  empleados lo usan, más difícil es cambiar de sistema.
- El costo técnico es chico: el login de Firebase es gratis hasta 50.000
  usuarios activos por mes, y calcular el mes de UNA persona es liviano.
- Lo que sí iría en un plan superior es la **etapa 2 (solicitudes y
  aprobaciones)**, y el **fichaje con el celular** sería un módulo aparte, que
  se cobra por empleado habilitado.

## Se habilita empresa por empresa (lo decide el superadmin)

Pedido del dueño del producto (2026-09-30/10-01): "los empleados podrán
acceder sólo cuando la empresa lo tiene habilitado, ya que se debe pagar por
los recursos que consume".

- Es un **módulo**, apagado por defecto (`motor-laboral/services/modulos.js`,
  guardado en `app_settings` como `modulo_portal_empleado`, sin migración).
  Publicarlo no le cambió nada a ninguna empresa.
- Solo el **superadmin** lo prende o lo apaga, en **Empresas > Editar >
  Módulos contratados** (`GET/PUT /api/labor-engine/admin/tenants/:id/modulos`).
- Apagado, en cada pedido: el empleado no entra (`/api/mi` → 403), el
  administrador no invita ni gestiona cuentas (`/api/portal-empleados` → 403)
  y el menú no lo muestra.
- Si se apaga después de haber invitado gente, esas cuentas dejan de entrar,
  pero no se borran: vuelven a entrar si se prende de nuevo.
- Una fila global (tenant NULL) **no** habilita nada, para que nunca se prenda
  para todas las empresas por accidente.

## Cómo funciona

- `employees.email`: el mail al que se manda la invitación. Antes el sistema no
  guardaba el mail de los empleados.
- `app_users.employee_id`: si está cargado, la cuenta **es** de ese empleado.
  Tiene un índice único: una sola cuenta por empleado.
- Pantalla del administrador: **Administración > Portal del empleado**.
  - Carga el mail de cada persona.
  - Invita en tandas de 50; Firebase manda el mail para elegir la clave.
  - Corta el acceso de quien deja la empresa (no se borra nada).
- Pantalla del empleado: **Mi asistencia**, pensada primero para el celular.
  Muestra el mes, la tarjeta de resumen, las horas extra según su convenio, lo
  liquidado (si el mes está cerrado, con los ajustes de meses anteriores) y el
  detalle día por día.

## Cómo se usa (paso a paso)

**El superadmin, una sola vez por empresa**

1. Correr en producción `migrations/20261010_portal_empleado.sql` (una vez
   para todo el sistema).
2. En **Empresas**, editar la empresa y tildar **Portal del empleado** en
   "Módulos contratados".

**El administrador de la empresa**

3. Entrar a **Administración > Portal del empleado**. Aparecen todos los
   empleados con su estado: *Falta el mail*, *Listo para invitar*, *Con
   acceso* o *Acceso cortado*.
4. Escribir el mail de cada persona en su fila (se guarda al salir del
   campo). Con el mail cargado pasa a *Listo para invitar*.
5. Tildar a quienes invitar (o "Elegir todos los listos para invitar") y
   tocar **Invitar**. Va en tandas de 50, con barra de progreso.
6. A cada persona le llega un mail de Firebase para **elegir su contraseña**.
   Queda *Con acceso*.
7. Si alguien deja la empresa: **Cortar acceso** en su fila. No se borra nada
   y se puede devolver.

**El empleado**

8. Abre el mail, elige su contraseña y entra a la misma dirección del sistema
   con su mail. Llega directo a **Mi asistencia**: resumen del mes, horas
   extra, lo liquidado (si el mes está cerrado) y el detalle día por día. Con
   las flechas cambia de mes. No ve ninguna otra pantalla.

**Qué se probó y qué no**

- Probado en Chrome, en local, el recorrido completo: el administrador carga
  el mail e invita; el empleado entra en tamaño celular, ve su mes real y, si
  intenta ir a otra pantalla, vuelve a la suya.
- No se probó: que llegue el mail de invitación (en las pruebas se usan
  direcciones `example.com`, a las que no se les manda nada), un celular
  físico, ni en producción.

## Seguridad: tres capas

Hasta el portal, toda cuenta del sistema era de un administrador de confianza,
así que algunas rutas solo exigían "estar logueado". Al revisarlo apareció un
caso real: las rutas de **facturación** dejaban a cualquier usuario de la
empresa ver la suscripción, **pedir la baja** o pedir un link de pago. Por eso
el portal no se apoya en revisar ruta por ruta:

1. **Lista blanca** (`appUserMiddleware.js`, `esRutaDelPortal`). Una cuenta de
   empleado solo puede usar `/api/app-users/me` y `/api/mi/...`. Todo lo demás
   responde 403, aunque la ruta haya quedado mal protegida.
   `findByFirebaseUid` además le saca **todo** permiso y el superadmin, aunque
   la fila los tuviera por error.
2. **El legajo sale del token, nunca de un parámetro** (`routes/miPortal.js`).
   No hay forma de pedir el mes de otra persona. Es la lección de F-02 de la
   auditoría: un id que viene del pedido no prueba que sea tuyo.
3. **Campos elegidos**, no la fila entera. Lo interno no sale: las
   explicaciones del motor, el modo sombra, las notas de las cargas manuales y
   la fuente de cada cálculo.

Un legajo dado de baja pierde el acceso. Un administrador no puede usar
`/api/mi`. El frontend acompaña (menú de un solo link y guards en
`portal/portal-guard.ts`), pero **la seguridad la pone el servidor**: aunque
alguien fuerce una URL, la API le responde 403.

`test/portal-empleado.test.js` lo prueba con cuentas de empleado que tienen
**todos** los permisos cargados a propósito. Esas cuentas tienen que quedar
encerradas igual en 12 rutas de administración, facturación incluida.

## Escala (400 personas mirando el día de cobro)

- `/api/mi/mes` usa el mismo cálculo que Presentismo, **filtrado a esa persona
  desde el principio** (`detailEmployeeId`): cuesta lo de una persona, no lo de
  la empresa.
- Los meses cerrados salen de la foto del cierre.
- Límite de pedidos por usuario (`reportesRateLimiter`).
- Pendiente antes de publicar: medirlo con 400 usuarios simulados.

## Qué falta

- Medir la carga con 400 usuarios simulados.
- Probarlo en el navegador y en un celular real.
- Cargar el mail desde la importación de empleados (hoy se carga uno por uno).
- Web instalable (PWA): ícono en el celular y notificaciones.
- Etapa 2: solicitudes y aprobaciones.
- Decisión abierta: si el empleado ve el **excedente** (horas que pasaron el
  tope y no se pagan). Hoy lo ve, porque la ley le da derecho a acceder a sus
  datos y evita sospechas.
