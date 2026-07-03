# Motor Laboral

Esta carpeta contendrá la nueva capa del motor laboral para horarios complejos.

## Objetivo

Crear un servicio independiente que interprete los `Checkins` existentes y genere cálculos avanzados de presentismo sin modificar la lógica legacy actual.

## Estructura inicial planeada

- `index.js` - punto de entrada del motor laboral
- `services/` - lógica de cálculo y reglas del dominio
- `repositories/` - acceso a datos y adaptadores de BD
- `routes/` - endpoints nuevos para el motor laboral
- `schemas/` - definiciones SQL / migraciones independientes si se decide usar un motor propio
- `tests/` - pruebas unitarias y de integración futuras

## Primeros pasos

1. Definir el esquema de datos nuevo.
2. Crear el servicio que lea `Checkins`, `users` y `employees`.
3. Exponer un endpoint nuevo que calcule asistencia diaria sin alterar el endpoint legacy.
4. Dejar el endpoint legacy funcionando como fallback.
