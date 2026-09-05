# Poner al dia la base de produccion (Clever Cloud)

Este repo no tiene (ni tuvo nunca) una tabla de control de migraciones
(`schema_migrations` o similar) -- cada archivo de `migrations/` se corrio
a mano, y no hay registro fiable de cuales llegaron a producción y cuales
se quedaron solo en la base local de desarrollo. **No asumas nada: segui
estos pasos en orden.**

## Paso 1 -- diagnostico (solo lectura, no modifica nada)

Conectate a la base de Clever Cloud (las credenciales `MYSQL_ADDON_*` que
usa Render) con cualquier cliente MySQL y corre `PRODUCTION_DB_CHECK.sql`
(esta al lado de este archivo). Te devuelve una fila por cada
tabla/columna que algun archivo de `migrations/` agrega, con `existe = 1`
o `0`.

## Paso 2 -- correr solo lo que falta

Con el resultado del paso 1, mapea cada `existe = 0` al archivo que lo
crea:

| Si no existe... | Correr |
|---|---|
| `tabla tenants` / `tabla app_users` / `tabla user_permissions` | `migrations/20260721_add_app_users_permissions_tenant.sql` |
| `employees.tenant_id` (y las de arriba SI existen) | `migrations/add-tenant-id-to-employees.sql` (antes que el de arriba -- ese archivo hace `UPDATE employees SET tenant_id = ...` y necesita la columna ya creada) |
| `holidays.tenant_id` / `event_types.tenant_id` / `employee_categories.tenant_id` | `migrations/20260722_add_tenant_to_catalogs.sql` (necesita que ya exista `tabla employee_categories` -- ver fila siguiente) |
| `Checkins indice idx_checkins_checktime` | `migrations/20260721_add_checkins_checktime_index.sql` |
| `tabla roles` / `tabla role_permissions` / `app_users.role_id` | `migrations/20260902_add_roles.sql` (la de esta sesion -- hace falta para que las paginas nuevas de Angular "Empresas" y "Usuarios y Roles" funcionen) |
| `work_schedule_templates.is_default`, `event_types.active`, `userexclusions.event_type_id`, `tabla employee_leave_balances`, `tabla employee_categories`, `employees.category_id` -- **si NINGUNA de estas existe todavia** | `migrations/20260708_consolidado_produccion.sql` **en vez de** los 4 archivos individuales que reemplaza (ver el comentario al principio de ese archivo: junta `20260706_add_is_default_to_templates.sql` + `20260707_add_absence_reasons_catalog.sql` + `20260707_add_employee_leave_balances.sql` + `20260708_add_employee_categories_catalog.sql`) |
| Si **alguna si y otras no** de ese ultimo grupo | No corras el consolidado (fallaria en la parte que ya existe) -- corre a mano, una por una, solo las sentencias puntuales que correspondan a lo que falta (abrilo, es corto, cada seccion esta numerada y comentada) |
| `employees.exclude_from_report` | `migrations/add-exclude-from-report.sql` |
| `employees.categoria` | **No corras nada.** Es un campo de texto libre que quedo obsoleto: el consolidado de arriba va directo al catalogo (`category_id` + tabla `employee_categories`), sin pasar por este paso intermedio. Si tu base ya tiene esta columna de una prueba vieja, no molesta, pero no hace falta crearla de nuevo. |
| `specialusers.direction` | `migrations/20260903_add_direction_to_specialusers.sql` (sin esta, la pantalla Salidas -- `/movements-range` -- tira 500: "Unknown column 'direction'"; encontrado recien en produccion, nunca habia quedado una migracion guardada para esta columna) |
| `users.isExcluded` | Correr `node add-exclusion-column.js` (con las mismas variables `MYSQL_ADDON_*` exportadas -- ese script ya se conecta solo, revisa si la columna existe antes de crearla, es seguro correrlo aunque ya exista) |
| `holidays.name` / `holidays.type` | Correr `node update-holidays-table.js` (mismo criterio: ya revisa antes de tocar nada) |

**Orden importante dentro de lo que falte:** tenants/app_users antes que
tenant-to-catalogs; tenant-id-to-employees antes que
app-users-permissions-tenant (ese hace `UPDATE employees SET tenant_id`);
employee_categories (via consolidado) antes que tenant-to-catalogs (ese
le agrega `tenant_id` a `employee_categories`); todo lo anterior antes
que `20260902_add_roles.sql` (no depende de las otras, pero es la mas
nueva y conviene dejarla al final para no perderla de vista).

## Paso 2b -- lo que se agrego 2026-09-03 a 09-06 (turno partido, seguridad multi-tenant, facturacion)

Mismo criterio que arriba: correlas en este orden, salteando la que ya
exista segun el Paso 1.

| Si no existe... | Correr |
|---|---|
| `tabla vacation_scale` / `employee_leave_balances.expiration_date` / `employee_events.balance_year` / `employees.motivo_baja` | `migrations/20260903_overtime_auth_and_vacation_scale.sql` (si `employees.overtime_authorized` NO existe tampoco, la columna se agrega a mano primero: `ALTER TABLE employees ADD COLUMN overtime_authorized TINYINT(1) NOT NULL DEFAULT 1;`, ver el comentario al principio de ese archivo) |
| `employees.payroll_regime` / `tabla payroll_regime_settings` | `migrations/20260903_payroll_regime.sql` |
| `app_settings.tenant_id` | `migrations/20260905_tenant_scope_app_settings.sql` -- **OJO**: este archivo hace `ALTER TABLE app_settings DROP PRIMARY KEY` sobre una tabla que en produccion puede tener datos reales cargados (corte de HE, tope de campana, etc.) -- no borra filas, solo cambia la clave, pero corré un `SELECT * FROM app_settings` antes para tener el valor de referencia a mano por las dudas. |
| `app_settings.tenant_key` | `migrations/20260905b_app_settings_unique_key.sql` (DESPUES del anterior, no antes -- necesita `tenant_id` ya creado). Este archivo primero DEDUPLICA filas repetidas antes de agregar la UNIQUE KEY -- si en producción llegó a pasar lo mismo que en local (dos filas globales para el mismo nombre, ver el comentario adentro del archivo), el DELETE de la migración se encarga solo. |
| `tabla plans` / `tabla tenant_subscriptions` / `tabla payment_records` | `migrations/20260906_billing_plans.sql` -- siembra un plan default (USD 18 base + USD 2,20/empleado, piso 5) automáticamente, no hace falta cargarlo a mano. Ninguna empresa existente queda con una suscripción asignada todavía (eso es a proposito -- no se bloquea a nadie solo por correr esta migración; asignar plan y activar se hace aparte, por `POST /api/billing/subscriptions/:tenantId`). |

## Paso 3 -- verificar

Volve a correr `PRODUCTION_DB_CHECK.sql`: todas las filas deberian dar
`existe = 1`. Recien ahi el codigo sincronizado de este repo (ver el
ultimo commit) va a funcionar contra esta base sin errores de
"tabla/columna no existe".

## Por que importa para el deploy del frontend nuevo

El Angular nuevo (`horasDedicacionOnlineAngular`) ya apunta a
`https://academypruebadep.onrender.com` en su build de produccion. Dos
pantallas nuevas (**Empresas** y **Usuarios y Roles**) llaman a
`/api/roles` y leen `app_users.role_id` -- si la base de produccion no
tiene `roles`/`role_permissions`/`role_id` todavia, esas dos pantallas
van a fallar con 500 apenas alguien las abra despues del corte de
Fase 5. El resto de las paginas migradas dependen, en menor medida,
del resto de esta lista (balances de vacaciones, categorias de
empleado, etc.) -- confirmar el Paso 1 antes de correr
`npm run deploy:live` en el repo de Angular.
