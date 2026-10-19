# Rediseño: cargar vacaciones, licencias y justificaciones (propuesta, 2026-10-19)

> Pedido del dueño: "es un poco confuso y debe ser más intuitivo… analicemos
> bien como experto en UX/UI. Ponete en el lugar de una persona que no sabe
> nada". Estado: **propuesta, esperando el sí del dueño**. Hecho y probado
> mientras tanto: atajo "Cargar como licencia" dentro de Justificar (rama
> `justificar-a-licencia` del frontend, sin publicar).

## Cómo funciona hoy (datos)
- **Justificaciones** (`user_exclusions`): un día (o un rango cargado día por
  día), con motivo; día completo o "llegó tarde hasta". Cuenta en Presentismo
  ("Excusado"), descuenta el cupo anual del motivo si lo tiene, guarda quién y
  cuándo. **Esconde** los motivos que descuentan vacaciones.
- **Licencias** (`employee_events`): rango con motivo y días calculados (corridos
  o hábiles según el motivo). Las de motivo con "descuenta vacaciones" son las
  que suman a "Tomados".
- **Vacaciones** (`leave_balances` + `vacation_scale`): tabla por año:
  Asignados (a mano o sugeridos por la escala), Tomados (calculado de las
  licencias), Pendientes, Vencimiento. **No permite cargar.**
- **Motivos** (`event_types`): catálogo con marcas (descuenta vacaciones,
  requiere aprobación, consume bolsa, pide comprobante), cupo y modalidad.

## Problemas, vistos por alguien que no conoce el sistema
1. Cuatro pantallas para una sola idea ("faltó / va a faltar"), con nombres
   que no dicen qué hacen.
2. "Vacaciones" no permite cargar vacaciones; se cargan en "Licencias".
3. Justificar esconde "Vacaciones" sin explicar dónde ir.
4. Al cargar vacaciones no se ve el saldo ni cómo queda.
5. Asignados a mano persona por persona y año por año.
6. Corridos/hábiles escondido en "Herramientas".
7. Motivos con jerga ("consume bolsa").
8. No hay ficha de la persona con su historial y saldos juntos.

## Propuesta (cada letra se aprueba por separado; no cambia datos ni cálculos)
- **A. "Cargar ausencia"**, un único formulario en 3 preguntas (quién, qué días,
  por qué). El sistema decide si se guarda como justificación o licencia según
  el motivo, y muestra el efecto antes de guardar ("descuenta 5 días hábiles;
  le quedan 9"). Se abre igual desde Presentismo, la persona o el menú.
- **B. "Saldos de vacaciones"** con "Cargar vacaciones" por persona (precargado)
  y asignación automática por escala (con corrección a mano).
- **C. "Ausencias cargadas"**: una sola lista (justificaciones + licencias) con
  filtros, en lugar de dos pantallas.
- **D. Motivos en lenguaje simple**, con ejemplo de su efecto.
- **E. Ficha de la persona**: calendario, ausencias y saldos juntos.

Orden recomendado: A y B primero (las que más ayudan), después C, D y E.
