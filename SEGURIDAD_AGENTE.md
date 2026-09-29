# Seguridad del agente que sube los fichajes — análisis y plan

Pedido del dueño del producto (2026-09-29): "ponemos una clave de empresa,
pero si esa clave la manipula un empleado mal intencionado, ¿cómo se podría
mejorar la seguridad?". Pendiente para próximos pasos: este documento es el
plan, no está implementado.

## Cómo funciona hoy

- El agente (`descarga-fichaje-py/`) corre en una PC de la empresa, lee los
  relojes por la red local y sube a `/api/agent/*` con una clave de empresa
  (`x-agent-key`, 256 bits, guardada hasheada en el servidor, se puede pausar
  y revocar desde la web).
- En la PC la clave está **en texto plano**, en el archivo de configuración
  (`[servidor] clave`).
- Con la clave se puede:
  - `POST /api/agent/checkins` — **agregar** fichajes (`INSERT IGNORE`: no
    borra ni modifica los existentes).
  - `POST /api/agent/users` — crear usuarios del reloj y **cambiar el número
    (Badgenumber) y el nombre** de los existentes.
  - `GET /api/agent/ping`.
- No se puede leer ningún dato.
- **No queda registro** de qué clave, IP o PC subió cada fichaje.

## Qué podría hacer un empleado con la clave

| Amenaza | Impacto | Hoy |
|---|---|---|
| Subir fichajes falsos (tapar una falta, sumar horas extra) | **Alto**: quedan idénticos a los del reloj y cambian la liquidación | Posible, sin rastro |
| Cambiar el Badgenumber de un usuario del reloj | **Alto**: cambia a quién se le atribuyen los fichajes | Posible, sin rastro |
| Inundar con datos basura | Medio | Limitado a 30 pedidos/min por IP |
| Leer datos de la empresa | — | No se puede |
| Borrar o modificar fichajes existentes | — | No se puede |

Fuera de este análisis, pero relacionado: alguien con acceso al **menú de
administración del reloj** puede cargar fichajes en el propio aparato. Eso se
protege con la clave de administrador del reloj, y la detectan igual las
defensas de "plausibilidad" de más abajo.

## Plan, en orden de valor

### 1. Trazabilidad de cada lote (barato, primero)
Registrar cada subida: clave usada, IP pública, PC (identificador de equipo),
versión del agente, cantidad, fecha. Cada fichaje queda asociado a su lote.
- Permite responder "¿de dónde salió este fichaje?".
- Permite **revertir un lote** sospechoso entero.
- En la web: historial de sincronizaciones por PC.

### 2. Mínimo privilegio en `/api/agent/users`
El agente puede **crear** usuarios nuevos, pero **no cambiar en silencio** el
número de uno que ya está vinculado a un empleado. Esos cambios quedan
"pendientes de revisión" en Vinculación (Matching) y generan un aviso.

### 3. Clave atada a la PC (lo más importante)
Hoy basta copiar el texto de la clave. Con esto no alcanza:
- Al instalar, el agente genera un **par de claves propio del equipo** y lo
  guarda cifrado con **DPAPI de Windows (ámbito de la máquina)**. Copiado a
  otra PC, el archivo no sirve.
- Cada pedido va **firmado** con esa clave del equipo, con fecha y un número
  que no se repite (así no se puede reenviar un pedido grabado).
- La primera vez que una PC nueva quiere sincronizar, queda **pendiente de
  aprobación** en la web: "Se detectó una PC nueva sincronizando para tu
  empresa: ¿autorizar?". Un empleado que se lleva la clave a su casa no puede
  subir nada sin que un administrador lo autorice.
- Una clave **por PC o sitio**, no una por empresa: revocar una no corta a las
  demás.

### 4. Solo relojes registrados
Cada empresa registra sus relojes (número de serie, IP). Los fichajes que
llegan con un número de serie desconocido quedan en **cuarentena** en vez de
entrar al cálculo.

### 5. Controles de plausibilidad y cuarentena
Quedan en cuarentena, con aviso, en vez de afectar el cálculo:
- Fichajes de fechas viejas (ej. más de 7 días atrás) o futuras.
- Fichajes de horarios en los que el reloj estaba sin sincronizar o apagado.
- Ráfagas: muchos fichajes de una sola persona en un lote.
- Subidas desde una IP pública nueva, o desde dos IPs a la vez con la misma
  clave.

Un administrador los aprueba o descarta desde la web, y queda registrado.

### 6. Protección en la PC
- El agente como **servicio de Windows** con una cuenta propia.
- El archivo de configuración solo legible por esa cuenta y por
  administradores.
- La clave no se vuelve a mostrar después de instalarla.
- Los empleados no son administradores de esa PC.

### 7. A largo plazo: sacar la PC de la cadena de confianza
Muchos relojes ZKTeco pueden **enviar los fichajes directo a un servidor**
(protocolo "push"/ADMS), identificándose con su número de serie. Así ninguna
PC intermedia maneja una clave. Requiere que el reloj llegue a internet y que
el servidor implemente ese protocolo.

## Criterio

Ninguna defensa sola es suficiente: la **trazabilidad (1)** y la **cuarentena
(5)** sirven aunque las otras fallen, porque hacen visible y reversible
cualquier fichaje que no vino del reloj. Por eso van primero junto con el
**cierre de `/users` (2)**; la **clave atada a la PC (3)** es la mejora más
grande contra una clave robada.
