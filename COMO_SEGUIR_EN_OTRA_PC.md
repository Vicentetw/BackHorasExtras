# Cómo seguir trabajando desde otra PC (con Claude Code)

> Escrito el 2026-10-16. La memoria del proyecto está en **archivos**, no en el
> chat. Por eso, en otra PC se sigue igual: una sesión nueva de Claude Code
> lee `CLAUDE.md` y `ESTADO_PROYECTO.md` (bloque "EMPEZÁ ACÁ") y sabe en qué
> estábamos.

## 1. Lo que viaja solo (está en GitHub)

| Qué | Dónde |
|---|---|
| Código del backend + `CLAUDE.md` + `ESTADO_PROYECTO.md` + docs | repo `BackHorasExtras` |
| Código del frontend | repo `horas-dedica-angular` |
| Landing | repo `horas-dedica-landing` |
| Ramas sin publicar (ej. `dias-a-revisar`) | se suben a GitHub como ramas: NO se publican por subirlas (Render publica solo `main`, y el frontend solo con `npm run deploy:live`) |

En la otra PC:

```
git clone <repo backend>   C:\angular\horasdedicacion-back-deploy\BackHorasExtras
git clone <repo frontend>  C:\angular\horasDedicacionOnlineAngular\horas-dedica-angular
cd ...\BackHorasExtras && npm install
cd ...\horas-dedica-angular && npm install
```

**Usá las mismas carpetas** que en esta PC. Claude Code guarda la memoria y
los chats por carpeta de proyecto: si la carpeta es otra, no los encuentra
(punto 3).

## 2. Lo que NO está en GitHub y hay que llevar a mano

| Qué | Por qué no está en GitHub | Cómo llevarlo |
|---|---|---|
| `.env` del backend | Tiene claves (base de datos, Firebase, etc.) | Pendrive o un gestor de contraseñas. **Nunca por mail ni chat, nunca a GitHub.** |
| `AUDITORIA_*.md` (auditorías) | Tienen datos de clientes (legajos) y el repo es público | Pendrive. Son solo para leer; no hacen falta para trabajar. |
| Backups de producción (`C:\Users\EURO\Backups\HorasDedica`) | Son datos reales | Solo si vas a hacer comparaciones con datos reales. Pendrive cifrado. |
| Base de pruebas (Docker `mysql_local`, puerto 3307) | Es local | En la otra PC: instalar Docker y crear el contenedor; los tests arman sus propios datos. |
| Firebase CLI | Login por PC | `npx firebase login` con la cuenta del hosting (ver `MAPA_FIREBASE_Y_CUENTAS.md`). |
| GitHub | Login por PC | `git` / `gh auth login`. |

## 3. Memoria y chats de Claude Code (opcional)

Claude Code guarda en esta PC, por proyecto:

```
C:\Users\EURO\.claude\projects\c--angular-horasdedicacion-back-deploy-BackHorasExtras\
    memory\        <- notas que Claude recuerda entre sesiones (MEMORY.md + un archivo por tema)
    *.jsonl        <- el historial de cada chat
C:\Users\EURO\.claude\settings.json   <- configuración general de Claude Code
```

- **Memoria:** copiá la carpeta `memory\` a la misma ruta en la otra PC (con el
  mismo usuario de Windows y la misma carpeta de proyecto, el nombre coincide).
  Si no la copiás, no se pierde nada importante: lo esencial también está en
  `ESTADO_PROYECTO.md`.
- **Historial del chat:** copiá los `*.jsonl` a la misma carpeta. En la otra
  PC, `claude --resume` (o `/resume` dentro de Claude Code) muestra los chats
  anteriores para retomarlos. Igual, los chats largos se resumen solos: lo que
  vale es lo anotado en `ESTADO_PROYECTO.md`.
- **Lo más simple:** no copiar nada de esto, abrir Claude Code en la carpeta
  del backend y decirle "leé ESTADO_PROYECTO.md y seguimos".

## 4. Para probar en la otra PC

Mismo procedimiento que en `CLAUDE.md` (sección Tests):

- levantar el backend local con las variables de prueba;
- `node scripts/correr-tests.js`;
- `ng serve` para ver las pantallas.

## 5. Al volver a esta PC

`git pull` en los dos repos (y en las ramas en las que se trabajó). Si en la
otra PC se usó la memoria, copiar de vuelta la carpeta `memory\`.
