# Qué hacer si se pierde la base

Este documento existe para el peor día. Está escrito para leerse apurado y
nervioso, así que va directo al grano y después explica.

**Dato verificado el 2026-09-25:** restaurar un backup completo tarda
**11 segundos** (52 tablas, 484 empleados, 159.057 fichajes). No es una
estimación: se cronometró restaurando el backup real del 24/09 en una base
descartable.

---

## El procedimiento, corto

```powershell
# 1. Conseguir el backup más reciente (ver "Dónde están los backups")

# 2. Restaurarlo en una base NUEVA (no encima de la rota)
.\scripts\restaurar-backup.ps1 `
  -Archivo "C:\ruta\backup-xxx.zip" `
  -DbHost <host> -Puerto 3306 -Usuario <usuario> `
  -Base <base_nueva> -ConfirmoBase <base_nueva>

# 3. Apuntar el backend a la base nueva:
#    Render -> Environment -> MYSQL_ADDON_DB (y host/usuario/password si cambiaron)
#    Guardar reinicia el servicio solo.

# 4. Verificar
curl https://academypruebadep.onrender.com/health
#    y entrar al sistema: login + abrir Presentismo
```

**Restaurar en una base nueva y no encima de la rota** es a propósito. Mientras
la base rota siga ahí, tenés a dónde volver si la restauración sale mal. Pisarla
es quemar la única evidencia de qué pasó.

---

## Dónde están los backups

Hay tres lugares, y conviene que sean tres. La regla clásica es **3 copias, en
2 medios distintos, 1 fuera del lugar** — no por manía, sino porque cada copia
falla por un motivo distinto y es raro que fallen todas juntas.

| Dónde | Cuándo | Qué lo puede dejar sin correr |
|---|---|---|
| Tu PC (`%USERPROFILE%\Backups\HorasDedica`) | Diario 23:14, tarea programada | Que la PC esté apagada. **Ya pasó: falta el 22/09** |
| GitHub Actions (repo privado) | Diario 03:00 ART | Que GitHub desactive el workflow por inactividad (avisa por mail) |
| Clever Cloud | Según el plan | Que el problema sea Clever Cloud |

Si los tres fallan a la vez, el problema es más grande que la base.

---

## Montar el backup diario en la nube

El de la PC ya funciona. Falta el que no depende de ella.

1. Creá un repositorio **privado** en GitHub, por ejemplo `horas-dedica-backups`.
   Privado, no público: ahí van credenciales de producción.
2. Copiá `scripts/github-actions-backup.yml` a ese repo, en
   `.github/workflows/backup.yml`.
3. Settings → Secrets and variables → Actions → New repository secret, y cargá
   los cinco: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`,
   `MYSQL_DB`.
4. Solapa **Actions** → el workflow → **Run workflow**. Corrilo a mano ahora.
   Si algo está mal configurado, mejor enterarse hoy que dentro de tres semanas.
5. Cuando termine, bajá el artifact y **restauralo** con el script de abajo.
   Un backup que no restauraste no cuenta.

### Dos cosas que lo van a romper en silencio

- **GitHub desactiva los workflows programados de un repo sin actividad por
  60 días.** Como ese repo no lo vas a tocar nunca, es casi seguro que pase.
  Avisa por mail: cuando llegue, entrá y reactivalo.
- **Si el workflow falla, GitHub te manda un mail.** Revisá que te llegue y que
  no caiga en spam. Un backup que dejó de correr y nadie notó es el caso
  clásico.

---

## El ensayo mensual

Poné un recordatorio. Una vez por mes, quince minutos:

```powershell
.\scripts\restaurar-backup.ps1 `
  -Archivo "<el backup más reciente>" `
  -Base ensayo_restore -ConfirmoBase ensayo_restore `
  -Usuario root -Contenedor mysql_local
```

Restaura en el MySQL local de Docker, sin tocar nada real. Al final imprime los
conteos: si ves 52 tablas y una cantidad de empleados y fichajes parecida a la
de producción, el backup sirve.

Después: `DROP DATABASE ensayo_restore;`

**Por qué mensual y no "cuando me acuerde":** lo que rompe un backup no es un
evento dramático, es la deriva. Cambia una versión de MySQL, se agrega una
tabla con un charset distinto, alguien toca un permiso. El dump sigue
generándose igual y sigue diciendo "Dump completed". La única forma de detectar
eso es intentar restaurarlo.

---

## Por qué el script verifica tanto

Tanto `backup-produccion.ps1` como el workflow revisan que el dump termine con
`-- Dump completed`, y que contengan las tablas principales.

No es exceso de celo. Si `mysqldump` se corta a la mitad —se cae la red, se
llena el disco, el servidor cierra la conexión— **el archivo queda igual**: con
tamaño razonable, con aspecto de backup, abriéndose sin error. Lo único que le
falta es esa línea final.

Un backup truncado que nadie revisó es peor que no tener backup, porque te hace
tomar decisiones distintas. Si sabés que no tenés respaldo, tenés cuidado. Si
creés que tenés uno y no sirve, no lo tenés.

---

## Lo que este documento NO cubre

Levantar todo desde cero en servidores nuevos (base + backend + frontend +
Firebase) está en **`REPLICAR_INSTALACION.md`**, que ya tiene el paso a paso
completo, incluida la trampa de los dos proyectos de Firebase.

Este documento asume que los servidores están y que lo que se perdió son los
datos.
