# Panel de facturación y gestión de cobros — plan por etapas

Anotado el 2026-09-23 a partir de la especificación de 31 puntos. Esto **no
está implementado**: es el plan para hacerlo sin romper lo que ya funciona.

---

## 🔴 Lo urgente, antes que cualquier panel

**`payment_records.reference` no tiene índice único.**

MercadoPago **reintenta** los webhooks: si no contesta rápido, o contesta con
error, manda la misma notificación otra vez. Hoy nada impide que el mismo
pago se registre dos veces, y cada registro **extiende el período** — o sea
que un cliente podría quedar pago hasta dentro de dos meses habiendo pagado
uno.

Todavía no pasó porque **hay 0 pagos registrados en producción**. Va a pasar
con el primero real.

Es una migración de tres líneas y un `INSERT ... ON DUPLICATE KEY`. **No
esperar al panel para esto.**

---

## Qué ya existe (no rehacer)

| Pieza | Estado |
|---|---|
| `plans` (precio base + por empleado, descuentos por período) | ✅ |
| `tenant_subscriptions` (estado, período, gracia, link, pedido de baja) | ✅ |
| `payment_records` (monto, moneda, método, período cubierto) | ✅ básico |
| `plan_requests` (pedido de plan) | ✅ |
| Link de suscripción recurrente (`/preapproval`) | ✅ |
| Link de pago único (`/checkout/preferences`) | ✅ 2026-09-23 |
| Cancelar la suscripción en MercadoPago | ✅ 2026-09-23 |
| Webhook con validación de firma HMAC | ✅ |
| Estados comerciales (trial/active/grace/readonly/canceled/free) | ✅ |
| Pantalla de Facturación con filtros por estado | ✅ básica |
| Panel del cliente (`/pagos`) | ✅ |
| Avisos por Telegram + campanita | ✅ 2026-09-23 |

La especificación pide **no duplicar** nada de esto. El plan de abajo lo
reutiliza.

---

## Qué falta, y en qué orden conviene hacerlo

### Etapa 1 — Que no se cobre dos veces (1 día)

*Ataca los puntos 14 (idempotencia) y 13 (registro de eventos).*

1. **Índice único** en `payment_records (method, reference)` + pasar los
   `INSERT` a `ON DUPLICATE KEY UPDATE`.
2. **Tabla `mercadopago_events`**: fecha, tipo, acción, id del recurso, id
   del evento, empresa, pago relacionado, estado de procesamiento, intentos,
   código HTTP, error, y el **payload crudo en JSON**.
3. El webhook consulta esa tabla antes de procesar: si el evento ya se
   procesó, lo registra y no duplica.

**Por qué primero**: es lo único de toda la lista que puede hacer perder o
cobrar plata mal. Todo lo demás es visibilidad.

**Riesgo de romper algo**: mínimo. La tabla es nueva y el índice único solo
puede fallar si ya hubiera duplicados — verificado que no hay.

---

### Etapa 2 — Que el pago guarde lo que MercadoPago ya sabe (1-2 días)

*Puntos 6 (detalle), 19 (período), 29 (manual vs MercadoPago).*

Hoy `payment_records` guarda 11 campos. MercadoPago devuelve mucho más y se
está descartando: `status`, `status_detail` (el motivo del rechazo),
`payment_type_id`, `payment_method_id`, `installments`,
`transaction_amount`, `net_received_amount`, `date_approved`,
`date_last_updated`, `order_id`, `payer_email`.

4. **Ampliar `payment_records`** con esas columnas, todas nullable (los pagos
   manuales no las tienen).
5. **`operation_type`**: `unico` / `suscripcion` / `renovacion` / `manual` /
   `reembolso` / `ajuste`. Hoy `method` mezcla el medio con el tipo.
6. **`last_sync_at` y `sync_status`** (OK/PENDING/ERROR) en pagos y
   suscripciones (punto 15).

**Por qué acá**: sin estos datos, el detalle del punto 6 y la vista de
rechazados del punto 9 no se pueden construir — no hay de dónde sacarlos.

**Riesgo**: bajo, todo aditivo. Nada que ya funcione cambia de significado.

---

### Etapa 3 — Reembolsos y contracargos (2 días)

*Puntos 11, 12, 28.*

7. **Tabla `refunds`**: pago original, id del reembolso, importe original,
   importe devuelto, saldo, estado, fechas, motivo. Soporta parcial.
8. **Tabla `chargebacks`**: pago relacionado, importe, estado, motivo, fechas.
9. El webhook los reconoce y los registra.
10. **Nunca** se toca el pago original (punto 28): un pago aprobado sigue
    existiendo aunque después se reembolse.

---

### Etapa 4 — El panel de verdad (3-4 días)

*Puntos 2, 3, 23, 24, 25, 26, 30.*

11. **KPIs** con selector de período (hoy / semana / mes / mes anterior /
    año / rango).
12. **Filtros y búsqueda**: empresa, CUIT, plan, estado, tipo, fecha,
    importe, medio de pago, id de MercadoPago, external reference.
13. **Exportar a CSV/Excel** respetando los filtros aplicados. Ya existe
    `ExportService` en el frontend — reutilizarlo, no escribir otro.
14. **Vistas específicas**: pagos rechazados (con `status_detail` y cantidad
    de intentos), pagos pendientes, devoluciones, eventos de MercadoPago.
15. **`tenants.cuit`** — hoy no existe y la especificación lo pide en la
    tabla, los filtros, la búsqueda y la exportación.

---

### Etapa 5 — Auditoría y avisos al cliente (2 días)

*Puntos 16, 21, 22.*

16. **`billing_audit`**: quién cambió qué, valor anterior y nuevo, motivo, IP.
    Ya hay un patrón probado en `auditLog.js` (migración 20260927) —
    reutilizarlo, no inventar otro.
17. **Período de gracia configurable** con avisos escalonados (día 0, día 3,
    suspensión al día 7).
18. **Notificaciones al cliente** con registro de envío, para no mandar dos
    veces lo mismo.

---

## Decisiones que hay que tomar antes de empezar

**1. ¿Los avisos al cliente por qué vía?** Telegram sirve para vos, no para
un cliente. Email necesita un proveedor (Resend, SendGrid) y cuidar que no
caiga en spam. Es una decisión con costo y no se puede posponer hasta la
etapa 5: cambia el diseño de la tabla de notificaciones.

**2. ¿Reembolsos manuales desde el panel, o solo registrar los que se hacen
en MercadoPago?** Ejecutarlos desde acá es más cómodo y más riesgoso: un
botón que mueve plata de verdad. Registrarlos es más seguro y obliga a entrar
a MercadoPago.

**3. ¿"Reactivar suscripción" (punto 7) qué significa exactamente?**
MercadoPago no permite revivir un preapproval cancelado: hay que crear uno
nuevo, con una autorización nueva del cliente. O sea que el botón, en
realidad, genera un link nuevo. Conviene que el texto lo diga.

---

## Lo que NO conviene hacer

**No** hacer las cinco etapas de una y desplegar al final. Cada una es útil
sola y se puede verificar sola. La 1 sobre todo: no tiene sentido postergarla
esperando el panel.

**No** tocar el contrato de los endpoints que ya usa el frontend. Todo lo
nuevo se agrega como campo opcional, igual que se hizo con `RangeDay` en el
motor de asistencia.

**No** guardar datos de tarjeta. La especificación lo dice y conviene
repetirlo: ni CVV, ni número completo, ni nada que no haga falta. MercadoPago
devuelve los últimos 4 dígitos y con eso alcanza para identificar un pago.

---

## Estimación

| Etapa | Días | Se puede desplegar sola |
|---|---|---|
| 1 — Idempotencia y eventos | 1 | sí |
| 2 — Datos completos del pago | 1-2 | sí |
| 3 — Reembolsos y contracargos | 2 | sí |
| 4 — El panel | 3-4 | sí |
| 5 — Auditoría y avisos | 2 | sí |

**Total: 9 a 11 días de trabajo**, desplegables de a una.

La etapa 1 conviene hacerla ya, independientemente de cuándo se decida el
resto.
