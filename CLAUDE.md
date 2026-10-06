# Horas Dedica — instrucciones para cualquier sesión nueva

Este archivo lo carga Claude Code automáticamente al empezar. Las
conversaciones se cortan y la siguiente no sabe en qué estábamos: **la memoria
del proyecto está en archivos, no en el chat.**

## Lo primero, siempre

1. Leer el bloque **"EMPEZÁ ACÁ"** de `ESTADO_PROYECTO.md` (estado, qué falta,
   reglas de trabajo del dueño, bitácora). Tiene una tabla "Dónde está
   explicado cada tema" con el documento de cada parte del sistema.
2. Mirar `git status` y `git log` de los repos antes de tocar nada:
   - backend: este repo (`C:\angular\horasdedicacion-back-deploy\BackHorasExtras`);
   - frontend: `C:\angular\horasDedicacionOnlineAngular\horas-dedica-angular`;
   - landing aparte: `C:\angular\horas-dedica-landing`.
   El directorio `C:\angular\horasDedicacionOnline` (monorepo viejo) está
   **obsoleto**: no se usa.
3. Al terminar cada bloque de trabajo, actualizar "EMPEZÁ ACÁ" y la bitácora
   de `ESTADO_PROYECTO.md`.

## Reglas del dueño (resumen; el detalle está en ESTADO_PROYECTO.md)

- **No cambiar nada que ya funciona en producción sin preguntar.** Listar los
  cambios con letras (A, B, C…) y esperar el sí. Lo nuevo y aditivo sí se puede.
- **Nunca escribir en la base de producción.** Para probar con datos reales
  está la copia local `horas_prod_copia` (MySQL de Docker, puerto 3307).
- Las migraciones las corre el dueño a mano. Todo código nuevo tiene que
  funcionar también **sin** la migración aplicada.
- Dejar todo probado y decir qué no se pudo probar. El dueño está aprendiendo:
  explicar el porqué, no solo el qué.
- No subir credenciales ni secretos a GitHub.

## ⚠️ Trampa conocida: marcadores (salidas particulares y horas extra)

Antes de tocar Presentismo, Salidas, horas extra, campaña o el portal del
empleado, **leer `MARCADORES_Y_SALIDAS.md`**. Resumen de lo que ya salió mal:

- Un marcador del reloj se lo lleva el **siguiente fichaje de cualquier
  persona**. Por eso `detectMovements` necesita **todos los fichajes de la
  empresa** del período. Filtrar por empleado antes de detectar (para
  "optimizar") hizo que el detalle mostrara salidas y horas extra distintas
  del resumen y de Salidas (corregido el 2026-10-05).
- Salidas, el resumen mensual, el detalle (calendario) y el portal **tienen
  que dar exactamente lo mismo**. Verificarlo comparando pantallas entre sí
  sobre `horas_prod_copia`, no solo con tests.
- Bajar la tolerancia en segundos (`markerMaxGapSeconds`) **no** resuelve
  marcadores mal atribuidos: está medido.

## Tests

- Levantar el backend local (puerto 3000) con estas variables de prueba, y
  después correr `node scripts/correr-tests.js`:
  ```
  TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA   (clave pública de prueba de Cloudflare)
  SIGNUP_TOPE_DIARIO_POR_IP=100000
  CHAT_TOPE_DIARIO_POR_IP=100000
  ```
  En PowerShell: `$env:VARIABLE='valor'` antes de `node horasdedica.js`.
- Si cientos de tests fallan de golpe, es el MySQL de Docker caído:
  `docker start mysql_local`.
