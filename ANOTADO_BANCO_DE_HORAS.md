# Destino del exceso de jornada y banco de horas

Anotado el 2026-09-24. **Analizado, no implementado.**

Pregunta: una persona con plantilla de 8 a 16 trabaja hasta las 18. Esas dos
horas tienen que quedar marcadas, y tiene que poder decidirse si se
contabilizan como hora extra o no. Y: *"algunas empresas tienen banco de
horas y después compensan con un franco, pero esa modalidad no la hemos
contemplado creo"*.

---

## Qué ya existe

**El exceso se detecta.** El caso de 8 a 16 trabajando hasta las 18 genera
horas extra hoy, por dos caminos: el heurístico clásico (horario de corte) y
los marcadores 9/10.

**Se puede decidir si cuenta o no**, pero solo como configuración previa:

- `overtimeAuthorizationMode` (por empresa): o todos generan horas extra, o
  solo los empleados marcados con `employees.overtime_authorized`.
- El motor de reglas clasifica el exceso como `OVERTIME` o
  `UNAUTHORIZED_OVERTIME`.

**Un acierto que conviene no perder**: el tiempo no autorizado **no se
borra**, queda registrado como tal. "No se paga" y "no pasó" son cosas
distintas, y la segunda es falsear el registro.

## Qué falta

**Decidir caso por caso, después de que pasó.** Hoy la autorización es una
configuración previa (este empleado sí, este no), no un "esas 2 horas del
martes sí, las del jueves no".

**El banco de horas no existe en ninguna forma.**

---

## Por qué el banco no es un agregado menor

Cambia la naturaleza de lo que se registra.

Las horas extra, como están hoy, son un **hecho del día**: pasaron, se
cuentan, se pagan, y el día siguiente empieza de cero. El banco es un **saldo
que persiste**: las 2 horas de hoy se acumulan, la semana que viene se toma
un franco y se descuentan 8.

Eso necesita cosas que hoy no existen en ningún lado del sistema:

- un **saldo por empleado** que sobreviva al mes y al año;
- **movimientos** con fecha, origen y motivo — un saldo sin el detalle es
  imposible de auditar, y acá se discute plata;
- **caducidad**: muchos convenios dicen que lo no compensado en X meses se
  paga o se pierde;
- **conversión**: una hora en sábado puede valer 1,5 en el banco;
- **saldo negativo**: ¿se permite adelantar francos?

---

## Las cuatro modalidades, y no son excluyentes

Una misma empresa puede tener las cuatro conviviendo:

1. **Se paga** — lo actual.
2. **Va al banco** y se compensa con francos.
3. **Se decide después** — el empleado elige, o lo resuelve el administrador.
4. **No se reconoce** — el exceso queda registrado pero no genera nada.

Y la elección no es de la empresa entera: depende del **convenio** (que ya
existe en el modelo, con vigencia por fecha), y a veces del empleado o hasta
del día puntual.

---

## La forma que recomiendo

**El destino del exceso tiene que ser un dato del día, no una configuración
global.** Cada día con exceso guarda qué se decidió hacer con esas horas:
`pagar`, `banco`, `no_reconocer`, o **`pendiente`**.

Ese cuarto estado es el que más falta hace: el sistema detecta el exceso, lo
deja en pendiente, y aparece en una lista para que alguien resuelva. **Nada
se pierde por no haberlo configurado antes**, que es el problema de que la
autorización sea solo previa.

El valor por defecto sale del convenio vigente ese día; se puede cambiar
caso por caso, y queda registrado quién lo cambió.

Encima de eso, el banco es una **cuenta corriente**: cada hora que entra o
sale es un movimiento con fecha, motivo, y quién lo hizo. El saldo es la
suma de los movimientos, **nunca un número que se edita a mano** — un saldo
editable es un saldo que nadie puede auditar.

---

## Lo que juega a favor

La base ya está. El motor de reglas tiene convenios con vigencia por fecha,
reglas por tipo de día, y —lo más importante— la separación conceptual entre
*tiempo trabajado*, *exceso* y *hora extra reconocida*.

El banco encaja como **una clasificación más del exceso**, no como un sistema
aparte. Eso es lo que lo hace viable sin rehacer nada.

## La advertencia

El motor de reglas vive en la rama `feat/rules-engine` y **nunca corrió en
modo sombra contra datos reales**, que era la condición explícita para
mergearlo. Construir el banco de horas encima sin validar eso primero es
apilar sobre algo que todavía no se probó donde importa.

**El orden correcto**: validar el motor en modo sombra → mergearlo → recién
ahí el banco de horas.
