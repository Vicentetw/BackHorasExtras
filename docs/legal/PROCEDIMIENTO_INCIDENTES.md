# Procedimiento ante incidentes de seguridad

*Uso interno de Horas Dedica — Versión 1.0 — [COMPLETAR fecha]*

> Basado en la Resolución AAIP 47/2018 (gestión de incidentes). No se
> publica.

## Qué es un incidente

Cualquier hecho que pueda haber expuesto, alterado o hecho perder datos:
acceso de alguien no autorizado, una empresa que ve datos de otra, una clave
publicada por error, una cuenta de proveedor comprometida, un borrado no
querido, un backup perdido.

## Los 6 pasos

### 1. Detectar y anotar (enseguida)
Anotar en `INCIDENTES.md` (privado, fuera del repo público): fecha y hora,
quién lo detectó, qué se vio. No borrar nada que sirva de evidencia (logs de
Render, Registro de actividad, backups).

### 2. Contener (primeras horas)
Según el caso:
- **Clave expuesta** (base, Firebase, MercadoPago, Anthropic, API_KEY):
  rotarla en el proveedor y en Render; redesplegar.
- **Cuenta comprometida:** deshabilitarla (Usuarios y Roles) y cerrar sus
  sesiones (Firebase → usuario → deshabilitar).
- **Error que mezcla datos entre empresas:** volver a la versión anterior
  (Render → Deploys → Rollback; Firebase Hosting → Rollback).
- **Datos borrados o dañados:** no tocar la base; restaurar el backup en una
  base nueva (`RECUPERACION_ANTE_DESASTRE.md`).

### 3. Evaluar (dentro de las 24 h)
- ¿Qué datos? ¿De qué empresas? ¿Cuántas personas?
- ¿Desde cuándo y hasta cuándo?
- Revisar el Registro de actividad y los logs para saber qué pasó.

### 4. Avisar (dentro de las 72 h)
- **A cada empresa cliente afectada** (lo exige el Acuerdo de Tratamiento):
  qué pasó, qué datos, qué se hizo, qué deben hacer ellos.
- Ellos, como responsables, deciden si avisar a sus empleados y a la AAIP;
  colaborar con lo que necesiten.
- Si los afectados son datos propios (clientes, registros de la página),
  evaluar con el abogado avisar a las personas y a la AAIP.

### 5. Corregir la causa
Arreglar el error de fondo, con un test que lo detecte si vuelve a pasar
(como `test/full-tenant-isolation.test.js` para la separación entre
empresas).

### 6. Cerrar y aprender
Completar en `INCIDENTES.md`: causa, impacto, avisos dados, corrección y
qué cambia para que no se repita.

## Contactos

| Qué | Dónde |
|---|---|
| Base de datos | Clever Cloud — panel / soporte |
| Servidor | Render — panel / soporte |
| Login y hosting | Firebase (Google) — consola |
| Pagos | MercadoPago — panel |
| Abogado | [COMPLETAR] |

## Prevención (revisar cada 6 meses)

- Verificación en dos pasos en todas las cuentas de proveedores.
- Revisar quién tiene acceso de superadmin y a los paneles.
- Probar restaurar un backup (`RECUPERACION_ANTE_DESASTRE.md`, ensayo mensual).
- Repos privados; ninguna clave en el código.
- Actualizar dependencias con avisos de seguridad.
