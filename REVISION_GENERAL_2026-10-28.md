# Revisión general: qué se pisa, qué se carga dos veces, qué no se usa (2026-10-28)

> Pedido del dueño: "revisar si nada se pisa, o hay carga doble, configuración
> que no se usa, posibilidad de simplificar. No hagas cambios aún".
> **No se cambió nada.** Cada punto tiene letra para aprobarlo por separado.
> Medido sobre `main` publicado (backend `399bff4`, frontend `4aa1d70`), en la
> base local con la empresa demo, y leyendo el código.

## Cómo se revisó

- **Pedidos repetidos:** un robot de Chrome entró como administrador y abrió
  las 23 pantallas del menú, anotando cada pedido al servidor
  (`scratchpad/qa_dobles.js`).
- **Rutas sin uso:** se cruzaron las 60 rutas de `horasdedica.js` y las de
  `routes/*.js` con todo el frontend.
- **Configuraciones:** se cruzó cada `getAppSetting` con su `setAppSetting`,
  y cada opción de Configuración con el cálculo que la usa.

## 1. Configuraciones que se pisan o confunden (lo más importante)

**T. "Límite de licencia personal" dice una cosa y hace otra.**
Configuración General lo explica como "horas mensuales máximas de *salida
particular*". Pero en el cálculo (`horasdedica.js`, `personalLeaveMinutes`)
suma los **minutos de llegadas tarde justificadas**. Las salidas particulares
tienen **otro** tope, en Salidas → Particular ("Tope mensual",
`particularExitMonthlyLimitMinutes`). Resultado: dos "topes de salida
particular" que no son lo mismo, y el de Configuración tiene el nombre
equivocado. Propuesta: llamarlo "Tope de llegadas tarde justificadas (horas
por mes)" y que la ayuda lo explique. Solo texto, el cálculo no cambia. Es
la mitad de la **E** del 26/10.

**U. Dos formas de decir "ya no trabaja acá".**
- **Empleados → Inactivo:** deja de contar ausencias.
- **Bajas y exclusiones:** "para que dejen de aparecer como ausentes".

Las dos dan el mismo resultado visible. Hay una diferencia: Inactivo **no
tiene fecha**. Marcar hoy a alguien como inactivo también le borra las
ausencias de los meses anteriores en Presentismo, incluidos meses ya
revisados (los cerrados guardan sus números). Propuesta: analizar una sola
forma, "Dar de baja con fecha", que quite las ausencias solo desde esa
fecha. Necesita revisar con cuidado: toca lo que se muestra de meses pasados.

**D (sigue igual que el 26/10). Dos "horarios por defecto".** Si la empresa
tiene una plantilla marcada "por defecto", el "Horario por defecto" de
Configuración General **no se usa** (`horasdedica.js`, `defaultTemplate`
gana sobre `companyschedule`), pero se sigue pudiendo editar: parece que
anda y no hace nada.

**F (sigue igual). Dos pantallas para pagar horas extra:** "Liquidación y
cierre de mes" y "Horas extra por régimen".

**V. Áreas y sucursales pueden duplicarse (lo nuevo del 27/10).** Un
supervisor "de la sucursal Centro" hoy necesita un área "Centro" con la
misma gente que la sucursal. Si una empresa ya organiza por sucursal, va a
cargar lo mismo dos veces. Propuesta para analizar: que al limitar un
usuario se pueda elegir **sucursal o área**, o crear las áreas a partir de
las sucursales con un botón.

## 2. Carga doble (pedidos repetidos al servidor)

**Las 23 pantallas no repiten pedidos:** cada una pide cada cosa una sola
vez. Lo único que se repite es **al entrar o recargar**:

| Pedido | Veces | Por qué |
|---|---|---|
| `/api/app-users/me` (el perfil) | 2, y 1 más antes de iniciar sesión (responde 401) | El control de cada pantalla (`permission-guard.ts`) lo pide **antes** de que Firebase confirme la sesión. Después `app.ts` lo vuelve a pedir, ya con la sesión |
| `/api/segundo-factor/estado` | 2 | El menú (`shell.ts`) lo pide cada vez que cambia el perfil, y el perfil llega 2 veces |

**W.** Que el control de pantallas espere a que Firebase confirme la sesión
antes de pedir el perfil. Así se pide una sola vez, y de rebote el segundo
factor también. Impacto bajo: son 2 pedidos chicos por carga. Se arregla en
un solo lugar.

## 3. Lo que no usa ninguna pantalla

| Ruta del servidor | Qué es | Propuesta |
|---|---|---|
| `GET /data` | Del sitio viejo (tablero mensual de antes) | **X.** Retirar |
| `GET /config/users-with-exclusions` | Del sitio viejo | **X.** Retirar |
| `POST /api/import/employees/upload`, `/preview`, `/confirm` | Importación de empleados en 3 pasos del sitio viejo. La pantalla actual lee el Excel en el navegador y da de alta uno por uno (`POST /api/employees`) | **X.** Confirmar y retirar |
| `GET /api/matching/suggestions`, `POST /manual-bulk` | Matching del sitio viejo | **X.** Confirmar y retirar |
| `POST /api/public/registro/cuenta` | No la llama ni la app ni la landing | **X.** Confirmar con la landing y retirar |
| `GET/PUT /config/limites-asistencia` | Preparada para la etapa E4 (rama pausada `justificaciones-y-limites`) | Dejar: se usa cuando se retome E4 |
| `GET /api/agent/ping` | La usa el programa de la PC, no la app | Dejar |

Retirar código que nadie llama achica lo que hay que mantener y lo que un
atacante puede probar. Antes de borrar cada una se busca en el backup de
producción si alguien la llamó (registro de Render) y se corre la suite.

## 4. Simplificar el código (ya listado el 26/10, sigue pendiente)

- **A.** Dos cálculos para el mismo día: el diario (`attendanceService.js`) y
  el mensual (`/attendance-range`, más de 2.000 líneas). Además siguen el
  cálculo viejo `/attendance/:date`, la comparación `/attendance/:date/compare`
  y los modos de plantilla `legacy/shadow/active` (todo AVP en `legacy`).
- **B.** `horasdedica.js` tiene **6.820 líneas y 83 rutas**: partirlo por tema.
- **C.** Ayudantes repetidos: `formatLocalDate` y `nextDayStr` definidos 4
  veces, `timeToMinutes` y `extractTime` 3 veces.

## Lo que está bien y no tocaría

- Cada pantalla pide sus datos una sola vez.
- Cada configuración que se guarda, se lee en algún cálculo: no hay opciones
  "muertas" en `app_settings`.
- Fichajes: un solo lugar ("Ver fichajes"), sin pantallas que se dupliquen.
- La carga inicial de la app quedó igual después de lo de esta semana.

## Orden recomendado

1. **T:** solo un texto, cero riesgo, evita una confusión real.
2. **W:** un lugar, bajo riesgo.
3. **D**, después **F**.
4. **X:** retirar rutas viejas, una por una, con la suite.
5. **U** y **V:** necesitan diseño. Tocan cómo se ven meses pasados y cómo se
   organiza la gente.
6. **C → B → A:** ordenar el código, de menor a mayor riesgo.
