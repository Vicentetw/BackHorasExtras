# Roles y áreas: quién puede hacer qué, y a quién ve (2026-10-26)

> Puntos S, P, R, O y Q de la sección 8 de `REVISION_PROFUNDA_2026-10-26.md`.
> Aprobados por el dueño el 26/10 ("todo con tutoriales, que lo entienda
> alguien que nunca usó el sistema, sin romper nada existente").
> **Estado: hecho y probado en local, SIN publicar.** Ramas `roles-completos`
> en el backend y en el frontend.

## Las dos preguntas

Para cada persona que entra al sistema hay dos preguntas separadas:

1. **Qué puede hacer.** Lo decide su **rol** (un conjunto de permisos con
   nombre) más algún permiso suelto.
2. **A quién ve.** Por defecto, a toda la empresa. Se lo puede limitar a
   algunas **áreas** (Q).

Así lo hacen Factorial y Buk: los permisos por un lado y la "visibilidad"
por el otro. Mezclarlos (un rol "Supervisor de Depósito", otro "Supervisor
de Ventas"...) obligaría a crear un rol por cada área.

## Lo que se hizo, punto por punto

| Punto | Qué | Por qué |
|---|---|---|
| **S** | Nadie da un permiso que no tiene, y una cuenta con más permisos que uno no se edita, desactiva ni borra | Antes, quien podía crear usuarios podía crear otra cuenta suya con rol de administrador |
| **P** | Permiso propio **"Horas extra y cierre de mes: Editar"**: cargar u omitir horas extra a mano, aceptar los días a revisar, aprobar excedentes, cerrar y reabrir el mes | Antes dependía de "Presentismo", así que quien cargaba fichajes también cerraba el mes |
| **R** | Roles del sistema por puesto: **Encargado de presentismo**, **Liquidación de horas extra** y **Supervisor de sector** (más Administrador y Solo lectura, que ya estaban). RRHH y Feriados **ya no se ofrecen**, pero quien los tiene los conserva | Los roles del 02/09 no acompañaron las pantallas nuevas (RRHH no podía cargar feriados ni autorizar salidas) |
| **O** | Cada empresa crea **sus propios roles** (pestaña Roles → Copiar o Nuevo rol), que ninguna otra empresa ve | Antes solo el superadmin creaba roles, y todas las empresas veían todos |
| **Q** | **Áreas**: un usuario se limita a una o más áreas y ve y carga solo a esa gente en todas las pantallas | Un supervisor no tiene por qué ver a toda la empresa (pedido típico de empresas grandes) |

## Reglas que conviene saber

- **El administrador de usuarios ve siempre toda la empresa.** Si se lo
  limitara a un área, no podría entrar a Usuarios y la empresa podría quedarse
  sin nadie que la administre. El servidor no lo deja.
- **No se borra un área que limita a alguien.** Si se borrara, ese usuario
  pasaría a ver toda la empresa (sin áreas = sin límite).
- **Nadie se cambia sus propias áreas**, igual que no se cambia su rol.
- A un usuario limitado **no se le ofrecen las pantallas de toda la
  empresa**: Usuarios, Configuración, Marcadores, Importar fichajes,
  Matching, Horarios de empleados, Bajas y exclusiones, Portal, Registro de
  actividad. Tampoco "Ver el reloj", porque muestra a otras personas.
- Arriba, a la derecha, ve siempre **"Ves solo: Depósito"**.
- Los fichajes los sigue subiendo solo el programa de la PC, con su propia
  clave. Ni los roles ni las áreas lo afectan.

## Cómo está hecho Q (para quien toque el código)

`motor-laboral/services/alcance.js` es el **único lugar** que decide qué ve un
usuario limitado. Es una **lista blanca**, igual que el portal del empleado:

- Cada ruta del servidor tiene que estar en `REGLAS`. Si no está, el usuario
  limitado recibe 403.
- Así, una pantalla nueva que alguien olvide agregar queda **cerrada** para
  él, en vez de mostrar gente de más.

Cada regla es de uno de estos tipos:

- **libre:** no trae personas (catálogos, configuración, su perfil).
- **filtrar:** la respuesta se recorta a su gente y se **recalculan los
  totales** (resumen del día, totales de liquidación, pendientes).
- **persona:** el pedido es sobre una persona (o varias). Si alguna no es de
  sus áreas, responde 403 y no se hace nada.

Las listas que vienen paginadas desde la base (Empleados, Justificaciones,
historial de fichajes manuales) se filtran **en su consulta**, con
`condicionDeAreas()`, porque recortar una página ya armada dejaría mal la
cuenta de páginas.

**Agregar una pantalla nueva que un supervisor deba ver:** sumar sus rutas a
`REGLAS` y una línea en `LECTURAS` de `test/alcance-areas.test.js`. Ese test
verifica que en ninguna respuesta aparezca alguien de otra área.

Para un usuario **sin áreas** (todos los de hoy), `alcance.js` no hace nada.
Esa es la garantía de que no se le rompe nada a quien ya usa el sistema.

## Migraciones (las corre el dueño)

| Archivo | Qué hace | Sin ella |
|---|---|---|
| `20261024_roles_completos.sql` | `roles.tenant_id` y `roles.ofrecido`; nombre único por empresa; reparte "Horas extra: Editar" a quien ya podía (solo la primera vez); crea los 3 roles nuevos; marca RRHH y Feriados como "ya no se ofrece"; descripciones con tildes | Todo funciona como hoy: horas extra con la regla vieja, sin roles propios (la pantalla avisa) |
| `20261025_areas.sql` | Tabla `areas`, `employees.area_id`, tabla `app_user_areas` | No se ofrecen áreas; todos ven toda la empresa |

Las dos se pueden correr más de una vez y en cualquier orden respecto de la
publicación. Llevan `SET NAMES utf8mb4`, porque sin eso la consola de MySQL
guardaba "LiquidaciÃ³n".

## Tutoriales

- **"Quién puede hacer qué: usuarios y roles"** (8 pasos). Se abre desde
  Usuarios y roles → "Ver cómo se hace" y desde Inicio → "Invitar a tu
  equipo". Capturas: `scripts/tutoriales/roles.js`.
- **"Un supervisor que ve solo a su gente"** (7 pasos). Se abre desde
  Empleados → Herramientas → Gestionar áreas y desde la ventana del usuario,
  en "Qué personas ve". Capturas: `scripts/tutoriales/areas.js`.

## Qué se probó

- **Suite del backend: 1198/1198.**
  - Corrida sin las migraciones: todo igual que antes.
  - Corrida con las migraciones aplicadas.
  - Tests nuevos: `roles-completos` y `alcance-areas`.
- **En Chrome:**
  - Los 4 roles de siempre, con el mismo menú y sin rechazos.
  - Los 3 roles nuevos.
  - Un supervisor limitado a "Depósito QA" (10 personas) en todas sus
    pantallas, el detalle y la vista mensual: ve 10, el administrador ve
    170, y no aparece ningún legajo de otra área.
  - Las capturas de los tutoriales recorren cada flujo de punta a punta.

## Encontrado de paso (ya corregido en la misma rama)

- **"Fichajes manuales"** quedaba a medias para cualquier rol sin permiso de
  Marcadores (por ejemplo el Encargado): leer si la función está habilitada
  pedía `settings:read`. Ahora alcanza con poder cargar fichajes. Guardarlo
  sigue pidiendo configuración.
- **La limpieza de la suite borraba la empresa demo** en cada `npm test`
  (usaba "id ≥ 999900" y en local los ids ya pasan el millón). Ahora la
  respeta.
- **Pestaña Roles:** al guardar un rol se recargaba toda la página y volvía
  a Usuarios.

## Antes de publicar (dueño)

1. Correr las dos migraciones en producción. Las dos son tolerantes, así que
   el orden con el deploy da igual.
2. Revisar si alguien de AVP queda frenado por la regla S. Por ejemplo, una
   cuenta que administra usuarios pero no tiene todos los permisos ya no
   puede editar a un administrador completo. Para eso alcanza mirar el
   backup: quién tiene `users:update` sin ser Administrador.
