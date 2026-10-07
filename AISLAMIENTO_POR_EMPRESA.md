# Aislamiento por empresa — relevamiento y plan (2026-10-06)

> **ESTADO (2026-10-06): A–I HECHOS en las ramas `aislamiento-por-empresa`
> (backend y frontend), NO publicados. Falta: (1) el dueño corre
> `migrations/20261014_aislamiento_por_empresa.sql` en producción, (2) unir el
> backend a `main` (Render publica), (3) publicar el frontend. En ese orden.**
> Verificado en la copia de producción: la migración no deja datos de empresa
> sin empresa, y AVP da IDÉNTICO antes y
> después (5.776 filas: Presentismo de 9 meses, 50 calendarios, Salidas,
> liquidación, vacaciones, configuración), con el código viejo y con el nuevo.
> Únicas diferencias, buscadas: la pantalla de Feriados ahora MUESTRA el 02/04
> y el 03/04 (antes se aplicaban sin verse). Suite: 903/903.
> J (catálogos para copiar) queda para más adelante. Las cargas manuales de
> horas sin empresa pasan a AVP en esta misma migración (decisión del dueño).
> Control esperado: todo en 0 salvo app_settings = 3 (los de plataforma).
>
> Pedido del dueño: "cada empresa debe tener todo propio" (ej. el 05/10, Día
> del Camino, es feriado solo para AVP). **Plan propuesto, NO aplicado:**
> cada letra espera aprobación. Regla: no romper nada de lo que funciona.

## Qué se encontró (copia de producción, 2026-09-29)

Casi todo lo "global" (`tenant_id` NULL) es en realidad **dato de AVP** que se
cargó sin empresa (lo cargó el superadmin sin elegir empresa):

| Tabla | Filas globales | Qué son | Problema |
|---|---|---|---|
| `holidays` | 4 | 02/01 puente, 02/04, 03/04 puente Malvinas, 15/09 Día de Rawson | Se **aplican** a todas las empresas en el cálculo, pero la pantalla de Feriados **no los muestra** (nadie los puede ver ni borrar). Además, importar feriados en una empresa **actualiza el global** si coincide la fecha |
| `companyschedule` | 2 | Horario por defecto 07:00–13:40 (el de AVP) | Tres consultas **no filtran por empresa**: el horario por fecha de una empresa lo leería otra |
| `app_settings` | 9 | Corte HE 13:38, tope 240, modo de autorización, límites (de AVP), tema, Telegram del dueño, firewall | Una empresa nueva hereda los valores de AVP |
| `vacation_scale` | 4 | 14/21/25/30 días (la de AVP; la LCT es 14/21/28/35) | Una empresa nueva hereda la escala de AVP. AVP no tiene propia: usa esta |
| `ciudades` / `sucursales` | 3 / 1 | Rawson, Trelew, "trelew" / Central | 13 empleados de AVP las usan |
| `day_type_overtime_rules` | 1 | 50 % después del horario, para el convenio 1 (CCT 572/09, **de AVP**) | Regla global que apunta a un convenio de una empresa |
| `payroll_regime_settings` | 1 | Régimen mensual, cortes 1 y 16 | AVP no tiene propio: usa este |
| `employee_categories` | 1 | "campaña" | De AVP |
| `staging_employees` | 3.037 | Restos de una importación vieja, sin empresa | Datos personales sin dueño |
| `ManualEntries` | 1 | Fila sin empresa | Pasa a AVP |

Además, el horario de AVP (07:00 a 13:40, corte 13:40) está **escrito en el
código** como valor de reserva en unos 12 lugares del backend.

Lo que SÍ está bien: plantillas, empleados, fichajes, marcadores, convenios,
motivos y categorías nuevas son por empresa; un admin de empresa no puede
tocar nada de otra; `test/full-tenant-isolation.test.js` lo verifica.

## Método para no romper nada (vale para todas las letras)

1. Antes de mover datos: guardar el resultado de Presentismo (resumen y
   detalle), Salidas, vacaciones y liquidación de AVP para varios meses, sobre
   la copia de producción.
2. Aplicar el cambio en la copia.
3. Repetir y comparar: **tiene que dar idéntico** (0 diferencias). Si no, no
   se publica.
4. Los movimientos de datos van en una migración que corre el dueño; el código
   tiene que andar antes y después de la migración.

## Plan, en orden (ver el chat del 2026-10-06 para la justificación completa)

- **A.** Test de aislamiento ampliado + test guardián (falla si aparece una
  fila sin empresa en una tabla que debe ser por empresa). Primero, porque fija
  lo esperado y evita que vuelva a pasar.
- **B.** Feriados: los 4 globales pasan a AVP (sin duplicar el 15/09 que ya
  tiene); el cálculo usa solo los de la empresa; la importación solo toca los
  propios; el superadmin tiene que elegir empresa al cargar uno.
- **C.** Horario por fecha (`companyschedule`): filtrar por empresa en las 3
  consultas; las 2 filas globales pasan a AVP.
- **D.** Ciudades, sucursal, categoría "campaña", regla de 50 % y régimen de
  pago: pasan a AVP.
- **E.** Configuración: AVP recibe copia propia de los valores globales que
  hoy usa; en global quedan solo los de la plataforma (Telegram, firewall).
- **F.** Escala de vacaciones: la actual pasa a AVP; empresas nuevas reciben la
  de la LCT (a confirmar por el dueño), editable.
- **G.** Al crear una empresa: copiarle un kit inicial (configuración, escala
  de vacaciones, régimen de pago). Los cambios futuros de la plataforma no
  tocan empresas existentes.
- **H.** Sacar el horario de AVP del código: una empresa sin plantilla ve un
  aviso "configurá tu horario", no el horario de AVP.
- **I.** Limpieza: borrar `staging_employees` sin empresa y pasar a AVP las
  cargas manuales sin empresa.
- **J.** (Después) Catálogos para copiar: feriados nacionales del año y
  plantillas modelo.
