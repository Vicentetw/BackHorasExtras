# Portal del empleado

Cada empleado entra con su mail y ve **solo lo suyo**: sus fichajes, sus días,
sus horas extra y lo que se le liquidó. La etapa 1 es de **solo lectura**.

Rama: `feature/portal-empleado`, en los dos repos. No se publica hasta que el
dueño del producto lo decida. Migración: `20261010_portal_empleado.sql`.

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
