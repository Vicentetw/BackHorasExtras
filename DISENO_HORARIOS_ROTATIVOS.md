# Horarios rotativos, ciclos, asignación y excepciones — diseño (2026-10-07)

> **Estado: PROPUESTA para revisar con el dueño. Nada programado todavía.**
> Pedido: "ayudame a diseñar bien las plantillas, ciclos, asignación y
> excepciones, por ejemplo para los horarios rotativos". Tiene que servir para
> cualquier empresa (multiempresa) y ser **simple de entender** para quien lo
> configura.

## 1. El problema, con un caso real

AGUILAR (3056), sereno de AVP. Sus fichajes de abril a octubre de 2026 (M =
mañana 7 a 15, T = tarde 15 a 23, N = noche 23 a 7):

**Abril a principios de septiembre — ciclo de 5 días, un "4x1":**

| Día del ciclo | Qué hace | Ejemplo (junio) |
|---|---|---|
| 1 | Mañana | 15/06, 20/06, 25/06 |
| 2 | Noche (empieza 23:00, termina 07:00 del día siguiente) | 16/06, 21/06, 26/06 |
| 3 | Sale de la noche a las 7 y descansa | 17/06, 22/06, 27/06 |
| 4 | Tarde | 18/06, 23/06 |
| 5 | Franco | 19/06, 24/06 |

**Desde el 11/09 — otro régimen:** 2 mañanas, 2 tardes, 2 noches y 4 días sin
turno (ciclo de 10 días: 21/09 → 01/10 → 11/10…).

**Y excepciones normales de un sereno:** doble turno (21/04 mañana + tarde;
02/07 tarde + noche), cambio de turno (28/06 hizo noche en vez de tarde),
coberturas (18/09 hizo una mañana en un día libre).

Hoy el sistema solo tiene plantillas **semanales** (lunes a domingo). A
AGUILAR le asignaron "turno de 15 a 23" y cada salida de su noche (07:04) se
lee como "Entrada, a tiempo". El aviso "Fuera de horario" (publicado el
07/10) lo marca 80 días en el año: su plantilla no es la suya.

## 2. Principios (no negociables)

1. **Simple para quien configura.** El administrador ve tres cosas: Turnos,
   Plantillas (semanal o rotativa) y el Calendario de cada empleado. Nada de
   "patrón", "estrategia", "ROTATE/CALENDAR/INFERRED".
2. **Si una empresa no carga nada nuevo, todo se calcula exactamente igual
   que hoy.** Se verifica contra la copia de producción en cada etapa.
3. **Una sola función decide qué le toca a alguien un día** (Presentismo
   diario y mensual, Salidas, horas extra, régimen, portal). Nunca dos
   verdades.
4. **El pasado no se borra.** Cambiar de régimen = cerrar una asignación y
   abrir otra. Todo cambio lleva autor, fecha y motivo.
5. **Lo que el sistema "deduce" solo se propone.** (Ej. "parece un ciclo de 5
   días que empieza el 15/06"). Lo confirma una persona.

## 3. Los conceptos, como los ve el usuario

| Concepto | Qué es | Ejemplo |
|---|---|---|
| **Turno** | Un horario con nombre, reutilizable. Se cargan una vez por empresa | Mañana 07:00–15:00 · Tarde 15:00–23:00 · Noche 23:00–07:00 |
| **Plantilla semanal** | Lo de hoy: qué hace cada día de la semana | Administración: lunes a viernes 07:00–13:40 |
| **Plantilla rotativa** | Un ciclo de N días; cada día es un turno o "sin turno" | Sereno 4x1: Mañana, Noche, —, Tarde, — |
| **Asignación** | Qué plantilla tiene una persona, desde/hasta. En una rotativa además: **qué día del ciclo le toca la fecha de inicio** | AGUILAR: Sereno 4x1 desde 15/06 (ese día es el 1) |
| **Asignación temporal** | Pisa a la normal un rango de fechas y después vuelve sola | Cubre noches del 1 al 15/09 |
| **Calendario del empleado** | Vista de mes con lo que le toca cada día. **Tocás un día y lo cambiás** (otro turno o franco), con motivo | 28/06: Noche en lugar de Tarde (cambio con un compañero) |

Licencias, vacaciones, justificaciones y feriados **siguen como hoy** (los
carga el encargado de novedades) y no se tocan.

## 4. Qué le toca a alguien un día (la función única)

En este orden; gana el primero que tenga algo:

1. **Licencia / justificación** de ese día → no se espera que trabaje (como hoy).
2. **Cambio puntual** cargado en su calendario para ese día.
3. **Asignación temporal** vigente.
4. **Asignación normal** vigente:
   - semanal → el día de la semana (como hoy);
   - rotativa → `día del ciclo = ((fecha − fecha del día 1) mod N) + 1`.
5. **Horario de la empresa** (como hoy).
6. **Sin horario** → el aviso "configurá un horario" (como hoy).

**Turno de noche:** la jornada pertenece al **día en que empieza** (la noche
del 16/06 es del 16/06 aunque termine el 17 a las 07:00). Es la regla que el
motor ya aplica hoy a los bloques que cruzan medianoche; un turno con fin
menor o igual al inicio se marca solo como "cruza medianoche".

**Feriados (decisión del dueño, 2026-10-07):** en una plantilla rotativa **el
ciclo manda**: si le tocaba trabajar y fichó, es "trabajó feriado" (como
hoy). En una semanal, como hoy. Más adelante, opción por plantilla si alguna
empresa lo necesita distinto.

## 5. Esquema de tablas (propuesto)

Todo **aditivo**: tablas y columnas nuevas, nada se borra ni se renombra. Las
plantillas semanales actuales (`type = 'FIXED'` + `shift_blocks`) siguen
igual.

```sql
-- Turnos: catalogo por empresa, reutilizable.
CREATE TABLE shift_definitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  nombre VARCHAR(60) NOT NULL,          -- "Mañana", "Noche"
  inicio TIME NOT NULL,                 -- 23:00
  fin TIME NOT NULL,                    -- 07:00
  cruza_medianoche TINYINT(1) NOT NULL, -- 1 si fin <= inicio (se calcula al guardar)
  color VARCHAR(7) NULL,                -- para el calendario
  activo TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_turno (tenant_id, nombre),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Plantilla rotativa: el tipo nuevo y el largo del ciclo.
ALTER TABLE work_schedule_templates
  ADD COLUMN cycle_length SMALLINT NULL;  -- solo type = 'CYCLE' (2 a 60 dias)
-- type: 'FIXED' (semanal, lo de hoy) | 'CYCLE' (rotativa)

-- Los dias del ciclo: dia 1..N -> un turno, o NULL = sin turno.
CREATE TABLE template_cycle_days (
  template_id INT NOT NULL,
  day_number SMALLINT NOT NULL,         -- 1..cycle_length
  shift_id INT NULL,                    -- NULL = sin turno (franco / descanso)
  PRIMARY KEY (template_id, day_number),
  FOREIGN KEY (template_id) REFERENCES work_schedule_templates(id),
  FOREIGN KEY (shift_id) REFERENCES shift_definitions(id)
);

-- Asignacion: que dia del ciclo es el dia 1, y si es temporal.
ALTER TABLE employee_work_calendars
  ADD COLUMN cycle_start_date DATE NULL,   -- fecha que es "dia 1" (default: valid_from)
  ADD COLUMN es_temporal TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN motivo VARCHAR(255) NULL,
  ADD COLUMN created_by INT NULL;

-- Calendario del empleado: cambio puntual de UN dia (otro turno o franco).
-- Tambien la usa la programacion mes a mes (etapa 4): son filas de esta tabla.
CREATE TABLE employee_day_schedule (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  employee_id INT NOT NULL,             -- employees.id
  fecha DATE NOT NULL,
  shift_id INT NULL,                    -- NULL = franco ese dia
  origen ENUM('cambio','programacion') NOT NULL DEFAULT 'cambio',
  motivo VARCHAR(255) NOT NULL,
  created_by INT NULL, updated_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL,
  UNIQUE KEY uq_dia (tenant_id, employee_id, fecha),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (shift_id) REFERENCES shift_definitions(id)
);
-- + employee_day_schedule_log (quien, cuando, antes/despues), como
--   marker_correction_log.
```

**Por qué así y no de otra forma:**

- *Turnos separados de la plantilla:* la "Noche 23–07" se define una vez y la
  usan todas las plantillas rotativas y los cambios puntuales. Si cambia la
  hora de la noche, se cambia en un lugar.
- *Las semanales no migran a turnos (por ahora):* hoy funcionan y tienen
  datos reales; pasarlas a turnos es otra decisión, sin apuro.
- *"Día 1" en la asignación y no en la plantilla:* dos serenos con la misma
  plantilla "Sereno 4x1" pueden estar desfasados (uno hoy en Mañana, el otro
  en Noche). La plantilla dice el ciclo; la asignación dice dónde arranca cada uno.
- *Una fila por día solo para los cambios:* el ciclo no guarda un registro
  por día (se calcula); solo se guarda lo que se aparta del ciclo. Para 5.000
  empleados, eso es lo que hace que escale.
- *Temporal como columna, no como tabla aparte:* es una asignación más, con
  la marca de que no corta a la principal.

## 6. Cómo quedaría AGUILAR

1. Turnos de AVP: Mañana 07–15, Tarde 15–23, Noche 23–07.
2. Plantilla rotativa **"Sereno 4x1"** (5 días): Mañana, Noche, —, Tarde, —.
3. Plantilla rotativa **"Sereno 2-2-2"** (10 días): Mañana, Mañana, Tarde,
   Tarde, Noche, Noche, —, —, —, —.
4. Asignaciones: "Sereno 4x1" de abril al 10/09 (día 1 = 15/06, o cualquier
   día de Mañana); "Sereno 2-2-2" desde el 11/09 (día 1 = 11/09).
5. Cambios puntuales en su calendario: 28/06 Noche (en vez de Tarde), 18/09
   Mañana (cobertura), etc. Los dobles turnos no necesitan cambio: se ven
   como horas extra.
6. Verificación: "Fuera de horario" pasa de 80 días a los pocos que son
   excepciones reales.

## 7. Pantallas

| Pantalla | Qué tiene |
|---|---|
| **Turnos** (en Plantillas de horario) | Lista simple: nombre, desde, hasta, color |
| **Plantilla rotativa** | Largo del ciclo + una fila de N casillas; en cada una se elige un turno o "sin turno". Vista previa de las próximas 3 semanas |
| **Asignar** | Si la plantilla es rotativa: "¿qué día del ciclo le toca el [fecha desde]?" con la vista previa de los próximos 14 días para confirmar. Tilde "temporal (vuelve sola a su horario normal)" |
| **Calendario del empleado** (desde Empleados y desde el Detalle de Presentismo) | Mes con colores por turno; los días cambiados a mano marcados; tocar un día → elegir otro turno o franco + motivo. Lo ve el empleado en su portal (solo lectura) |
| **Programación** (etapa 4) | Grilla personas × días del mes, copiar/pegar el patrón |

**Quién edita:** quien tenga permiso de editar horarios (`schedules:update`,
"Horarios y reglas de cálculo") y el administrador de la empresa (decisión
del dueño, 2026-10-07).

## 8. Etapas

| Etapa | Qué | Resuelve |
|---|---|---|
| 1 | Turnos + plantilla rotativa + "día 1" al asignar + la función única | AGUILAR y todo rotativo regular |
| 2 | Calendario del empleado + cambio puntual por día (con historial) | Cambios, coberturas, patrones irregulares |
| 3 | Asignación temporal + **editar asignaciones** (hoy solo se pueden borrar) | Reemplazos, corregir errores de carga |
| 4 | Programación mes a mes en grilla | Empresas que programan por mes |
| 5 | "Sugerir plantilla" a partir de los fichajes | Puesta en marcha rápida |

En cada etapa: migración tolerante (el código funciona aunque no se haya
corrido), tests, y comparación contra la copia de producción de que AVP sin
datos nuevos da exactamente lo mismo.

## 9. Preguntas abiertas

- ¿El empleado puede **pedir** un cambio de turno desde su portal (y el
  encargado lo aprueba)? Sería una etapa posterior.
- Turnos partidos dentro de una rotativa (ej. "Mañana partida 7–11 y
  15–19"): ¿hace falta? El turno se podría definir con varios tramos.
- ¿Avisar al encargado los días de un rotativo que no tienen nadie asignado
  (cobertura)? Es otra funcionalidad ("dotación"), no de este diseño.
