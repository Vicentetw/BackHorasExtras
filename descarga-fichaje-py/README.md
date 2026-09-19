# Agente de descarga de fichajes

Baja los fichajes y usuarios de uno o varios relojes biométricos ZKTeco y
los sube al sistema de asistencia -- automático (desatendido, programado)
o manual (con ventana), como prefieras. Pensado para instalarse en la PC
de cada sitio (una escuela, una dependencia) que tiene relojes en su red
local.

## Configuración de un sitio nuevo

1. Pedile al superadmin del sistema que te genere una **clave de agente**
   para tu empresa (Facturación → "Claves de agente" → "Generar clave
   nueva"). La clave se muestra **una sola vez** al generarla -- copiala
   en ese momento.
2. Copiá `main.exe` a la PC del sitio (no hace falta instalar Python).
3. Al ejecutarlo por primera vez (con ventana o con `--headless`) se crea
   un `config.ini` de ejemplo al lado del `.exe`. Editalo:

   ```ini
   [servidor]
   url = https://academypruebadep.onrender.com
   clave = hda_...   ; la clave que generó el superadmin

   [relojes]
   192.168.1.10
   192.168.1.11,123456   ; IP,clave si el reloj tiene clave configurada

   [agente]
   intervalo_minutos = 15
   ; opcional -- no se conecta a los relojes en estos horarios (ver abajo)
   horarios_excluidos = 07:45-08:15, 12:45-13:15, 17:45-18:15

   [relojes_conexion]
   ; segundos de espera por reloj antes de darlo por caido -- si la descarga
   ; de usuarios funciona pero la de fichajes no (reloj con mucho historial),
   ; subir este numero.
   timeout_segundos = 20
   ```

   Si dejás `url`/`clave` vacíos, el agente sigue funcionando en modo
   **solo local**: baja los relojes y genera los CSV (`CHECKINOUT.csv`,
   `USERINFO.csv`) como siempre, sin subir nada a ningún servidor.

## Horarios excluidos (no molestar en horario de fichaje)

Mientras el agente descarga de un reloj, ese reloj queda con el lector
apagado unos segundos (`disable_device()`/`enable_device()`) -- para no
interferir justo cuando la gente está fichando, `horarios_excluidos` en
`config.ini` (sección `[agente]`) define rangos `HH:MM-HH:MM` (formato
24 horas, separados por coma) en los que el agente **no se conecta a
ningún reloj** -- ni en `--headless`, ni en `--loop`, ni con el botón de
la ventana. Si un ciclo cae dentro de un rango excluido, se salta esa
corrida entera y se reintenta en la próxima (según `intervalo_minutos`).

```ini
horarios_excluidos = 07:45-08:15, 12:45-13:15, 17:45-18:15
```

Soporta rangos que cruzan la medianoche (ej. `22:00-02:00` para un turno
noche). Dejalo vacío (`horarios_excluidos =`) para no excluir ningún
horario.

## Sincronización automática al abrir la ventana

Pedido real: para sitios donde el Programador de tareas de Windows no se
pudo configurar (problema real y conocido: pide la contraseña de la
cuenta de Windows/Microsoft y la rechaza, o solo acepta el PIN y ese
nunca sirve para tareas desatendidas), abrir la ventana **ya sincroniza
solo** apenas termina de dibujarse -- no hace falta apretar ningún botón.
Usa el mismo `ejecutar_ciclo` que `--headless` (respeta
`horarios_excluidos` igual), y no muestra ningún cartel emergente -- solo
se ve en el panel de mensajes, para no interrumpir con un "Aceptar" cada
vez que alguien abre el programa a mirar cómo viene todo. Si
`config.ini` no tiene servidor configurado, no hace nada (mismo
comportamiento silencioso de siempre en modo solo-local).

## Uso manual (con ventana)

Ejecutá `main.exe` normal, cargá las IPs (o dejá las que ya están
precargadas -- ver abajo) y hacé clic en "Descargar Datos". Genera los CSV
de siempre **y además**, si `config.ini` tiene servidor configurado, guarda
todo en una cola local y lo sincroniza automáticamente -- ningún cambio en
lo que ya conocías, solo se suma la sincronización. Al terminar, aparece un
cartel de confirmación con cuántos fichajes y usuarios se sincronizaron
(o si algo falló, para no tener que revisar el panel de mensajes).

Las IPs que cargues quedan guardadas solas en `config.ini` apenas termina
una descarga -- la próxima vez que abras la ventana (o corra
`--headless`), ya van a estar precargadas.

### Sincronizar solo fichajes o solo usuarios

Debajo de "Descargar Datos" hay dos botones más: **"Sincronizar solo
fichajes"** y **"Sincronizar solo usuarios"**. Bajan de los relojes igual
que siempre (un reloj siempre entrega ambos juntos, no se le puede pedir
uno solo), pero **suben al servidor únicamente el tipo elegido** -- útil,
por ejemplo, si ya sabés que los usuarios están al día y solo querés
forzar la subida de fichajes nuevos, o si una sincronización previa dejó
fichajes pendientes por un error puntual del lado de usuarios. Requieren
`[servidor] url` y `clave` configurados en `config.ini` -- si no,
muestran un aviso en vez de intentar nada.

### Configuración del agente automático desde la ventana

Un panel nuevo ("Configuración del agente automático") permite editar,
sin tocar `config.ini` a mano:

- **Horarios excluidos**: mismo formato `HH:MM-HH:MM` separados por coma
  que en el archivo (ver más abajo). Si el texto tiene un rango mal
  escrito, avisa con un error en vez de guardarlo silenciosamente mal.
- **Sincronizar cada (horas)**: reemplazo, en horas, del
  `intervalo_minutos` de `config.ini` (podés poner decimales, ej. `0.5`
  para cada 30 minutos). Se guarda convertido a minutos -- `--headless`,
  `--headless --loop` y el Programador de tareas de Windows no necesitan
  ningún cambio, siguen leyendo el mismo `intervalo_minutos` de siempre.

El botón "Guardar configuración" escribe directo en `config.ini`. **Si el
`.exe` está corriendo en modo `--headless --loop`, hay que reiniciarlo**
para que tome el nuevo intervalo (lo relee recién al empezar cada vuelta
del bucle); si usás el Programador de tareas de Windows, el próximo
disparo ya lo toma solo, no hace falta reiniciar nada.

## Uso automático (desatendido, recomendado para producción)

`main.exe --headless` baja de todos los relojes de `config.ini`, guarda
en la cola local, y sincroniza -- sin abrir ninguna ventana. Si el
servidor no está disponible en ese momento, lo que se descargó queda
guardado local y se reintenta solo en la próxima corrida (nada se pierde).

Hay **dos formas** de que esto se repita solo cada tantos minutos --
elegí una de las dos, no hace falta usar ambas:

### Opción A: Programador de tareas de Windows (recomendado)

Más robusto: si el proceso se cuelga una vez, Windows simplemente lo
vuelve a lanzar en el próximo horario -- no se queda trabado.

1. Buscá "Programador de tareas" en el menú Inicio → **Crear tarea básica**.
2. Nombre: algo como "Sincronizar fichajes".
3. Desencadenador: **Diariamente**.
4. Repetir la tarea cada: **15 minutos** (o el intervalo que prefieras),
   durante: **1 día** (para que se repita todo el día, no una sola vez).
5. Acción: **Iniciar un programa** → Programa/script: la ruta completa a
   `main.exe` → Agregar argumentos: `--headless`.
6. Terminar. Podés hacer clic derecho en la tarea → **Ejecutar**, para
   probarla ya mismo sin esperar al próximo horario.

**Problema real y conocido: "Programador de tareas no acepta mi contraseña"**
-- si al crear la tarea pide usuario/contraseña (pestaña General → "Ejecutar
tanto si el usuario inició sesión como si no") y no toma ni la contraseña
de tu cuenta Microsoft ni el PIN: el PIN **nunca** sirve ahí (es solo para
desbloquear ese equipo puntual, no una credencial válida para tareas
desatendidas), y con cuentas Microsoft (no locales) esa validación falla
seguido aunque la contraseña esté bien -- es una limitación conocida de
Windows. Si la PC del sitio queda siempre con la sesión iniciada (aunque
bloqueada), la solución simple es elegir **"Ejecutar solo cuando el
usuario haya iniciado sesión"** en su lugar -- esa opción no pide ninguna
contraseña. Si la PC se reinicia o cierra sesión seguido, mejor usar la
Opción B (`--loop`) de abajo, que tampoco necesita ninguna contraseña.

### Opción B: bucle interno (`--headless --loop`)

Más simple de dejar andando en un sitio sin nadie técnico -- un solo
doble clic (o un acceso directo en la carpeta de Inicio de Windows) y
queda corriendo solo, repitiendo cada `intervalo_minutos` (config.ini).
Contra: si el proceso se cierra o la PC se reinicia, no se vuelve a
levantar solo -- alguien tiene que volver a abrirlo.

1. Creá un acceso directo a `main.exe`.
2. Click derecho → Propiedades → en "Destino", agregale ` --headless --loop`
   al final (con un espacio antes), quedando algo como:
   `"C:\ruta\main.exe" --headless --loop`
3. (Opcional, para que arranque solo al prender la PC) copiá ese acceso
   directo a la carpeta de Inicio de Windows: `Win + R` → escribí
   `shell:startup` → Enter → pegar el acceso directo ahí.

## Red -- qué necesita el técnico del sitio

- **Hacia el servidor**: HTTPS normal, puerto **443** (el mismo que
  cualquier navegador) hacia el host de `[servidor] url` en `config.ini`
  (ej. `academypruebadep.onrender.com`). Si esa PC ya navega internet, no
  hace falta ninguna regla de firewall extra.
- **Hacia cada reloj**: TCP puerto **4370** (protocolo ZKTeco), desde la PC
  del agente hacia la IP de cada reloj -- tienen que estar en la misma red
  local, o el firewall/router del sitio tiene que permitir ese puerto si
  están en segmentos distintos.

No busca relojes solo en la red -- las IPs se cargan a mano (una vez, ya
quedan guardadas). Un escaneo automático de la red es técnicamente
posible pero no está implementado: es lento (recorrer un rango entero de
IPs), poco confiable si el sitio tiene varias redes/VLANs, y en la
práctica un sitio no cambia de relojes tan seguido como para justificarlo.

## Archivos

- `config.ini` -- configuración del sitio (servidor, relojes). Se crea
  solo la primera vez, con un ejemplo comentado.
- `agente_local.db` -- cola local (SQLite). Se crea sola, no hace falta
  tocarla -- guarda lo que todavía no se pudo subir al servidor.
- `CHECKINOUT.csv` / `USERINFO.csv` -- exportación local de la última
  corrida (se pueden seguir subiendo a mano por la pantalla de Importar,
  como siempre).

## Notas para quien mantiene esto

- Para el agente en sí (sincronización): sin dependencias nuevas a
  propósito -- `sqlite3`, `configparser` y `urllib` vienen con Python, no
  hace falta `requests` ni nada más.
- Única dependencia agregada, sólo para la ventana: `sv-ttk` (tema visual
  "Sun Valley", look Windows 11). Es Tcl/Python puro, no tiene binarios
  nativos. Instalar con `pip install sv-ttk` en el venv antes de
  compilar. **Si falta, la ventana igual abre** con el tema `clam` y la
  misma paleta (fallback en `main.py`), y el modo `--headless` ni lo
  toca. Para que entre al `.exe`, `main.spec` la agrega con
  `collect_data_files('sv_ttk')` -- si no, PyInstaller copia el `.py`
  pero no los assets del tema y no carga.
- El dedupe es doble: local (SQLite, `UNIQUE(userid, checktime)`) y en
  el servidor (`INSERT IGNORE` sobre la misma clave) -- reintentar un
  lote que ya se subió no duplica nada.
- `zk_service.py` es el que sabe hablar con los relojes (pyzk) -- no se
  tocó, se reusa tal cual tanto desde la ventana como desde el agente.
