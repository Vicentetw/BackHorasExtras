import sys
import threading
import ipaddress
from datetime import datetime
from zk_service import descargar_reloj
from exporter import exportar_checkinout, exportar_userinfo
import db_local
import config_loader
import agent_runner

# Bug real encontrado compilando el .exe: la consola por defecto de
# Windows (cp1252, la que usa el Programador de tareas sin configuracion
# especial) no puede imprimir ciertos caracteres Unicode (ej. "→") --
# zk_service.py y otros mensajes los usan, y print() explota con
# UnicodeEncodeError apenas aparece uno. En vez de perseguir cada
# caracter en cada archivo, se reconfigura la salida a UTF-8 con
# errors="replace" (nunca revienta, en el peor caso cambia el caracter
# raro por un "?") -- soluciona esto de raiz para TODO lo que se
# imprima, sin importar de donde venga.
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None:
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

PUERTO = 4370
TIMEOUT = 5

# =========================
# MODO DESATENDIDO (Fase 18)
# =========================
# `main.exe --headless` -- pensado para el Programador de tareas de
# Windows, corriendo cada tantos minutos sin que nadie este mirando la
# pantalla. Se resuelve ANTES de importar tkinter (no hace falta abrir
# ninguna ventana para esto, y algunos sitios corren esto sin sesion
# grafica activa).
#
# `--headless --loop` -- alternativa sin Programador de tareas: el propio
# programa se queda corriendo para siempre, repitiendo el ciclo cada
# intervalo_minutos (config.ini). Mas simple de dejar andando en un sitio
# sin nadie tecnico, pero si el proceso se cuelga no se reinicia solo
# (ver el comentario largo en agent_runner.ejecutar_bucle).
if "--headless" in sys.argv:
    if "--loop" in sys.argv:
        agent_runner.ejecutar_bucle(log=print)
    else:
        agent_runner.ejecutar_ciclo(log=print)
    sys.exit(0)

import tkinter as tk
from tkinter import ttk, messagebox

# Tema visual (restyle). sv_ttk = "Sun Valley", clonado del aspecto de
# Windows 11 -- es Tcl/Python puro, sin binarios nativos, no genera
# conflictos en Windows y se empaqueta con PyInstaller sumando su carpeta
# de datos al .spec (ver main.spec: collect_data_files('sv_ttk')). Si por
# lo que sea no esta disponible (no instalado, o un build que no lo
# incluyo), se cae al tema 'clam' pintado a mano con los mismos colores:
# la app sigue funcionando y se ve decente igual, nunca queda rota por
# esto.
try:
    import sv_ttk
    _TEMA_MODERNO = True
except Exception:
    sv_ttk = None
    _TEMA_MODERNO = False

# Paleta compartida con la web (mismo azul marino del panel lateral y
# familia de azules) para que el agente y el sistema se sientan lo mismo.
COL_NAVY = "#1a2036"
COL_ACCENT = "#3b6ef0"
COL_TEXT_LIGHT = "#e4e7f5"
COL_BORDE = "#c7ccda"

# =========================
# OBTENER ZONA HORARIA SISTEMA
# =========================
def obtener_zona_sistema():
    return str(datetime.now().astimezone().tzinfo)

# =========================
# VALIDACIÓN IP
# =========================
def ip_valida(ip):
    try:
        ipaddress.ip_address(ip)
        return True
    except ValueError:
        return False

# =========================
# LOG PANEL
# =========================
# El panel es una consola oscura (mismo azul marino que el panel lateral
# de la web, para que el agente y el sistema se vean de la misma familia).
# Cada linea se pinta segun `tipo`: rojo para errores, verde para "hecho",
# celeste para pasos intermedios, y el color base claro para info normal.
# Los tags de color se definen una sola vez al crear el widget.
def log_mensaje(texto, tipo="info"):
    panel_mensajes.insert(tk.END, texto + "\n")
    tag = tipo if tipo in ("error", "ok", "paso") else None
    if tag:
        panel_mensajes.tag_add(tag, "end-1l", "end-1c")
    panel_mensajes.see(tk.END)
    root.update_idletasks()


# =========================
# INDICADOR DE ESTADO (restyle)
# =========================
# Antes habia que leer el panel de mensajes con atencion para saber si el
# programa estaba trabajando, terminado o con errores. Ahora hay una
# linea fija arriba ("● Listo" / "● Sincronizando…" / "● Con errores")
# con color. Se llama desde los hilos de fondo, asi que el cambio real de
# widget se agenda con root.after(0, ...) -- mismo criterio que los
# messagebox de proceso_descarga (Tkinter no es seguro entre hilos).
_ESTADO_COLORES = {
    "ok": "#2fa84f",
    "trabajando": "#c8871d",
    "error": "#d64545",
    "reposo": "#8b90a5",
}


def set_estado(texto, tono="reposo"):
    color = _ESTADO_COLORES.get(tono, _ESTADO_COLORES["reposo"])

    def _aplicar():
        estado_var.set(texto)
        estado_dot.configure(foreground=color)
        estado_label.configure(foreground=color)

    try:
        root.after(0, _aplicar)
    except Exception:
        pass

# =========================
# PROCESO DESCARGA
# =========================
def proceso_descarga():
    panel_mensajes.delete(1.0, tk.END)
    set_estado("Descargando de los relojes…", "trabajando")
    zona = combo_zona.get()
    lineas = ip_text.get("1.0", tk.END).strip().split("\n")
    relojes = []

    for linea in lineas:
        linea = linea.strip()
        if not linea:
            continue
        partes = linea.split(",")
        ip = partes[0].strip()
        password = partes[1].strip() if len(partes) > 1 else ""
        relojes.append((ip, password))

    if not relojes:
        log_mensaje("Debe ingresar al menos una IP.", "error")
        return

    progreso["maximum"] = len(relojes)
    progreso["value"] = 0
    todas_asistencias = []
    todos_usuarios = []
    # Bug real reportado: con el timeout viejo (5s fijo), la descarga de
    # usuarios podia funcionar pero la de fichajes cortarse a mitad de
    # camino en un reloj con bastante historial guardado -- ahora sale
    # de config.ini (20s por defecto, editable sin recompilar).
    timeout = config_loader.cargar().get("timeout_segundos", TIMEOUT)

    for ip, password in relojes:
        if not ip_valida(ip):
            log_mensaje(f"{ip} → IP mal formada.", "error")
            progreso["value"] += 1
            continue

        log_mensaje(f"{ip} → Conectando...")
        users, attendances, error = descargar_reloj(ip, PUERTO, timeout, password)

        if error:
            log_mensaje(error, "error")
        else:
            log_mensaje(f"{ip} → Registros descargados correctamente.")
            if attendances:
                # Anotar origen del reloj en cada attendance (ip y posible serial)
                for a in attendances:
                    try:
                        a.machine_ip = ip
                    except Exception:
                        pass
                    try:
                        # si el objeto attendance trae serial, respetarlo
                        if hasattr(a, 'machine_sn') and getattr(a, 'machine_sn'):
                            pass
                        else:
                            a.machine_sn = ''
                    except Exception:
                        a.machine_sn = ''
                todas_asistencias.extend(attendances)
            if users:
                todos_usuarios.extend(users)

        progreso["value"] += 1
        root.update_idletasks()

    # =========================
    # EXPORTACIÓN
    # =========================
    if todas_asistencias:
        archivo1 = exportar_checkinout(todas_asistencias, zona)
        log_mensaje(f"Archivo generado: {archivo1}")
    else:
        log_mensaje("No se exportaron registros de asistencia.", "error")

    if todos_usuarios:
        archivo2 = exportar_userinfo(todos_usuarios)
        log_mensaje(f"Archivo generado: {archivo2}")
    else:
        log_mensaje("No se exportaron usuarios.", "error")

    # Bug real reportado: la ventana siempre mostraba la MISMA ip de
    # ejemplo al abrir, sin recordar lo que se habia tipeado y usado la
    # vez anterior. Se persiste en config.ini apenas termina de bajar
    # (aunque la sincronizacion de abajo falle) -- la proxima vez que se
    # abra la ventana, o corra --headless, ya esta precargada.
    try:
        config_loader.guardar_relojes([f"{ip},{pw}" if pw else ip for ip, pw in relojes])
    except Exception:
        pass

    # Fase 18 -- ademas de los CSV de siempre (sin cambios, la descarga
    # manual sigue funcionando exactamente igual), se guarda todo en la
    # cola local y se intenta sincronizar con el servidor si config.ini
    # tiene una URL y una clave cargadas. Envuelto en try/except a
    # proposito: un problema con esto NUNCA debe romper la descarga/
    # exportacion manual que ya funciona.
    resumen_sync = None
    try:
        cfg = config_loader.cargar()
        if todas_asistencias:
            db_local.guardar_fichajes(todas_asistencias)
        if todos_usuarios:
            db_local.guardar_usuarios(todos_usuarios)
        if cfg["server_url"] and cfg["api_key"]:
            resumen_sync = agent_runner.sincronizar_pendientes(cfg["server_url"], cfg["api_key"], lambda m: log_mensaje(m))
        else:
            log_mensaje("Servidor no configurado en config.ini -- solo se exportó local (CSV + cola).")
    except Exception as e:
        log_mensaje(f"No se pudo sincronizar con el servidor (los CSV ya se generaron igual): {e}", "error")

    log_mensaje("Proceso finalizado.")

    if resumen_sync is not None and resumen_sync["errores"]:
        set_estado("Sincronizado con errores", "error")
    elif resumen_sync is not None:
        set_estado("Todo sincronizado", "ok")
    else:
        set_estado("Exportado local (sin servidor)", "reposo")

    # Pedido real: un mensaje de confirmacion que no se pueda pasar por
    # alto (a diferencia del panel de log, que hay que leer con atencion).
    # OJO: esta funcion corre en un hilo de fondo (ver iniciar_descarga) --
    # Tkinter no es seguro para llamar desde otro hilo que no sea el
    # principal, asi que el messagebox se agenda con root.after() en vez
    # de llamarse directo desde aca.
    if resumen_sync is not None:
        if resumen_sync["errores"]:
            texto = (
                f"Se sincronizaron {resumen_sync['fichajes_sincronizados']} fichajes y "
                f"{resumen_sync['usuarios_sincronizados']} usuarios, pero hubo problemas:\n\n"
                + "\n".join(resumen_sync["errores"])
                + "\n\nLo que falló queda guardado local y se reintenta en la próxima corrida."
            )
            root.after(0, lambda: messagebox.showwarning("Sincronización con errores", texto))
        else:
            texto = (
                f"Se sincronizaron {resumen_sync['fichajes_sincronizados']} fichajes y "
                f"{resumen_sync['usuarios_sincronizados']} usuarios con el servidor."
            )
            root.after(0, lambda: messagebox.showinfo("Sincronización completa", texto))
    else:
        root.after(0, lambda: messagebox.showinfo("Descarga completa", "Se generaron los archivos CHECKINOUT.csv y USERINFO.csv localmente."))

def iniciar_descarga():
    hilo = threading.Thread(target=proceso_descarga)
    hilo.start()


# =========================
# SINCRONIZAR AL ABRIR LA VENTANA (pedido real)
# =========================
# Antes, abrir la ventana no disparaba nada -- solo servia para descargar a
# mano con el boton. Pedido real: que abrir el programa (aunque sea sin
# tocar nada) ya deje todo al dia, sobre todo para sitios donde el
# Programador de tareas de Windows no se pudo configurar (problema real:
# pide contraseña de cuenta Microsoft y no la toma) -- asi el uso normal
# ("abro el programa a ver como viene todo") ya cumple la misma funcion.
# Mismo ejecutar_ciclo que usa --headless (respeta horarios_excluidos), sin
# ningun cartel emergente -- solo se ve en el panel de mensajes, para no
# interrumpir con un OK cada vez que alguien abre la ventana.
def _auto_sync_al_abrir():
    cfg = config_loader.cargar()
    if not cfg["server_url"] or not cfg["api_key"]:
        return  # sin servidor configurado, nada que sincronizar -- silencioso
    set_estado("Sincronizando al abrir…", "trabajando")
    log_mensaje("🔄 Sincronización automática al abrir el programa...")
    # Envuelto en try/except (igual que proceso_descarga): un problema de
    # red al abrir NUNCA debe tirar un traceback en pantalla ni dejar el
    # estado clavado en "Sincronizando…". Lo pendiente ya quedó a salvo en
    # la cola local y se reintenta solo en la próxima corrida.
    try:
        agent_runner.ejecutar_ciclo(log=lambda m: log_mensaje(m), sincronizar="todo")
        log_mensaje("Sincronización automática finalizada.")
        set_estado("Al día", "ok")
    except Exception as e:
        log_mensaje(f"No se pudo completar la sincronización automática (se reintenta luego): {e}", "error")
        set_estado("Sin conexión con el servidor", "error")


def iniciar_auto_sync_al_abrir():
    threading.Thread(target=_auto_sync_al_abrir, daemon=True).start()


# =========================
# SINCRONIZAR SOLO FICHAJES / SOLO USUARIOS (pedido real)
# =========================
# Antes solo existia "Descargar Datos", que baja de los relojes y sube
# AMBOS tipos juntos. La descarga de un reloj siempre trae usuarios y
# fichajes juntos (asi responde el protocolo ZK, no se puede pedir uno
# solo) -- lo que estos botones separan es la SUBIDA: bajan igual que
# siempre, pero solo suben el tipo elegido (ver ejecutar_ciclo(sincronizar=...)).
def _proceso_sincronizar_solo(sincronizar):
    cfg = config_loader.cargar()
    if not cfg["server_url"] or not cfg["api_key"]:
        root.after(0, lambda: messagebox.showwarning(
            "Servidor no configurado",
            "Cargá [servidor] url y clave en config.ini antes de sincronizar con el sistema."))
        return
    panel_mensajes.delete(1.0, tk.END)
    etiqueta = "fichajes" if sincronizar == "fichajes" else "usuarios"
    set_estado(f"Sincronizando {etiqueta}…", "trabajando")
    log_mensaje(f"Sincronizando solo {etiqueta}...")
    try:
        resumen = agent_runner.ejecutar_ciclo(log=lambda m: log_mensaje(m), sincronizar=sincronizar)
    except Exception as e:
        log_mensaje(f"No se pudo sincronizar (se reintenta luego): {e}", "error")
        set_estado("Sin conexión con el servidor", "error")
        root.after(0, lambda: messagebox.showwarning(
            "Sin conexión",
            f"No se pudo contactar al servidor:\n\n{e}\n\n"
            "Lo pendiente queda guardado en la cola local y se reintenta en la próxima corrida."))
        return
    log_mensaje("Proceso finalizado.")
    set_estado("Con errores" if resumen["errores"] else "Sincronizado", "error" if resumen["errores"] else "ok")

    if resumen["errores"]:
        texto = (
            f"Se sincronizaron {resumen['fichajes_sincronizados']} fichajes y "
            f"{resumen['usuarios_sincronizados']} usuarios, pero hubo problemas:\n\n"
            + "\n".join(resumen["errores"])
            + "\n\nLo que falló queda guardado local y se reintenta en la próxima corrida."
        )
        root.after(0, lambda: messagebox.showwarning("Sincronización con errores", texto))
    else:
        texto = (
            f"Se sincronizaron {resumen['fichajes_sincronizados']} fichajes y "
            f"{resumen['usuarios_sincronizados']} usuarios con el servidor."
        )
        root.after(0, lambda: messagebox.showinfo("Sincronización completa", texto))


def sincronizar_solo_fichajes():
    threading.Thread(target=_proceso_sincronizar_solo, args=("fichajes",)).start()


def sincronizar_solo_usuarios():
    threading.Thread(target=_proceso_sincronizar_solo, args=("usuarios",)).start()


# =========================
# GUARDAR CONFIGURACIÓN DEL AGENTE (horarios excluidos + intervalo)
# =========================
# Pedido real: hoy esto solo se puede tocar editando config.ini a mano --
# se agrega un panel simple en la ventana para no obligar a eso. Se guarda
# en HORAS en la ventana (mas natural para pensar "cada cuanto"), pero se
# sigue almacenando en MINUTOS en config.ini (asi --headless/--loop, que ya
# leen intervalo_minutos, no necesitan ningun cambio).
def guardar_configuracion():
    texto_horarios = entry_horarios.get().strip()
    # Validar ANTES de guardar -- que un typo en un rango no rompa el
    # agente en silencio (_parsear_horarios_excluidos ignora lo invalido,
    # mejor avisar aca que dejar que el usuario piense que quedo cargado).
    rangos_validos = config_loader._parsear_horarios_excluidos(texto_horarios)
    partes_no_vacias = [p for p in texto_horarios.split(",") if p.strip()]
    if len(rangos_validos) != len(partes_no_vacias):
        messagebox.showerror(
            "Formato inválido",
            "Los horarios excluidos deben tener el formato HH:MM-HH:MM separados por coma.\n"
            "Ejemplo: 07:45-08:15, 12:45-13:15")
        return
    try:
        horas = float(entry_intervalo_horas.get().strip().replace(",", "."))
        if horas <= 0:
            raise ValueError
    except ValueError:
        messagebox.showerror("Formato inválido", "El intervalo debe ser un número mayor a 0 (en horas, ej. 0.5 para 30 minutos).")
        return

    intervalo_minutos = round(horas * 60)
    config_loader.guardar_config_agente(intervalo_minutos, texto_horarios)
    messagebox.showinfo(
        "Configuración guardada",
        f"Se guardó: sincroniza cada {horas:g} horas ({intervalo_minutos} min), "
        f"horarios excluidos: {texto_horarios or '(ninguno)'}.\n\n"
        "Esto aplica a --headless / --loop (Programador de tareas) -- "
        "si el .exe está corriendo en modo --loop hace falta reiniciarlo "
        "para que tome el nuevo intervalo.")


# =========================
# INTERFAZ
# =========================
root = tk.Tk()
root.title("Descarga de fichajes — Sistema de Asistencia")
root.minsize(620, 740)

# Tema: si sv_ttk esta disponible, look Windows 11 (claro, igual que el
# modo por defecto de la web). Si no, 'clam' con la misma paleta -- nunca
# queda con los botones grises de Tk crudo, pase lo que pase.
if _TEMA_MODERNO:
    try:
        sv_ttk.set_theme("light")
    except Exception:
        _TEMA_MODERNO = False
if not _TEMA_MODERNO:
    try:
        ttk.Style().theme_use("clam")
    except Exception:
        pass
    root.option_add("*Font", ("Segoe UI", 9))

_style = ttk.Style()
_style.configure("Titulo.TLabel", font=("Segoe UI Semibold", 15))
_style.configure("Sub.TLabel", font=("Segoe UI", 9), foreground="#6b7086")
_style.configure("Estado.TLabel", font=("Segoe UI Semibold", 9))
try:
    _style.configure("Accent.TButton", font=("Segoe UI Semibold", 10))
except Exception:
    pass
if not _TEMA_MODERNO:
    # 'clam' no trae boton de acento -- se arma a mano con el azul de la web.
    _style.configure("Accent.TButton", background=COL_ACCENT, foreground="#ffffff",
                     font=("Segoe UI Semibold", 10), borderwidth=0, padding=(10, 8))
    _style.map("Accent.TButton", background=[("active", "#5b8bff"), ("pressed", "#2f5fd6")])

cont = ttk.Frame(root, padding=(18, 16))
cont.pack(fill="both", expand=True)

# --- Encabezado: titulo + subtitulo a la izquierda, estado a la derecha ---
_header = ttk.Frame(cont)
_htxt = ttk.Frame(_header)
titulo = ttk.Label(_htxt, text="Descarga de fichajes", style="Titulo.TLabel")
titulo.pack(anchor="w")
ttk.Label(_htxt, text="Relojes ZK  →  Sistema de asistencia", style="Sub.TLabel").pack(anchor="w")
_htxt.pack(side="left")

_estado_box = ttk.Frame(_header)
estado_var = tk.StringVar(value="Listo")
estado_dot = ttk.Label(_estado_box, text="●", style="Estado.TLabel", foreground="#8b90a5")
estado_dot.pack(side="left", padx=(0, 4))
estado_label = ttk.Label(_estado_box, textvariable=estado_var, style="Estado.TLabel", foreground="#8b90a5")
estado_label.pack(side="left")
_estado_box.pack(side="right", anchor="n", pady=(4, 0))
_header.pack(fill="x", pady=(0, 14))

# --- Relojes biometricos ---
frame_relojes = ttk.Labelframe(cont, text=" Relojes biométricos ", padding=(12, 10))
label_ips = ttk.Label(frame_relojes, text="Una IP por línea. Si el reloj tiene contraseña:  IP,contraseña")
label_ips.pack(anchor="w", pady=(0, 6))
ip_text = tk.Text(frame_relojes, height=4, wrap="none", font=("Consolas", 10),
                  relief="flat", borderwidth=0, highlightthickness=1,
                  highlightbackground=COL_BORDE, highlightcolor=COL_ACCENT,
                  padx=10, pady=8)
ip_text.pack(fill="x")

# Bug real reportado: esto antes SIEMPRE mostraba la misma IP de ejemplo,
# sin importar lo que se hubiera tipeado y usado la vez anterior -- ahora
# se precarga con lo ultimo guardado en config.ini (ver guardar_relojes,
# llamado al final de una descarga exitosa). Si todavia no hay nada
# guardado (primera vez), se deja el ejemplo de siempre para no arrancar
# con el cuadro vacio.
_relojes_guardados = config_loader.cargar()["relojes"]
if _relojes_guardados:
    _texto_inicial = "\n".join(f"{ip},{pw}" if pw else ip for ip, pw in _relojes_guardados)
else:
    _texto_inicial = "172.155.0.33\n172.155.0.17,123456"
ip_text.insert(tk.END, _texto_inicial)

_row_zona = ttk.Frame(frame_relojes)
label_zona = ttk.Label(_row_zona, text="Zona horaria de exportación")
label_zona.pack(side="left")
combo_zona = ttk.Combobox(_row_zona, width=32)
zona_sistema = obtener_zona_sistema()
combo_zona["values"] = [
    "local", zona_sistema,
    "America/Argentina/Buenos_Aires",
    "America/Santiago",
    "America/Mexico_City",
    "UTC"
]
combo_zona.set("local")
combo_zona.pack(side="left", padx=(10, 0))
_row_zona.pack(fill="x", pady=(10, 0))
frame_relojes.pack(fill="x")

# --- Accion principal + acciones separadas ---
btn = ttk.Button(cont, text="Descargar y sincronizar", command=iniciar_descarga, style="Accent.TButton")
btn.pack(fill="x", pady=(14, 0))

# Pedido real: ademas del boton combinado de arriba, poder sincronizar
# SOLO fichajes o SOLO usuarios (bajan de los relojes igual que siempre,
# pero suben solo el tipo elegido -- ver _proceso_sincronizar_solo).
frame_sync_solo = ttk.Frame(cont)
ttk.Button(frame_sync_solo, text="Solo fichajes", command=sincronizar_solo_fichajes).pack(side="left", expand=True, fill="x", padx=(0, 4))
ttk.Button(frame_sync_solo, text="Solo usuarios", command=sincronizar_solo_usuarios).pack(side="left", expand=True, fill="x", padx=(4, 0))
frame_sync_solo.pack(fill="x", pady=(6, 0))

progreso = ttk.Progressbar(cont, orient="horizontal", mode="determinate")
progreso.pack(fill="x", pady=(12, 0))

# =========================
# CONFIGURACIÓN DEL AGENTE (horarios excluidos + intervalo)
# =========================
# Pedido real: hoy solo se podia tocar editando config.ini a mano.
_cfg_actual = config_loader.cargar()

frame_config = ttk.Labelframe(cont, text=" Agente automático  (--headless / --loop) ", padding=(12, 10))
frame_config.pack(fill="x", pady=(14, 0))

ttk.Label(frame_config, text="Horarios excluidos (no sincronizar), formato HH:MM-HH:MM separados por coma:",
          wraplength=560, justify="left").pack(anchor="w")
entry_horarios = ttk.Entry(frame_config)
entry_horarios.pack(pady=(4, 10), fill="x")
if _cfg_actual["horarios_excluidos"]:
    _texto_horarios_inicial = ", ".join(f"{h1.strftime('%H:%M')}-{h2.strftime('%H:%M')}" for h1, h2 in _cfg_actual["horarios_excluidos"])
    entry_horarios.insert(0, _texto_horarios_inicial)

frame_intervalo = ttk.Frame(frame_config)
frame_intervalo.pack(anchor="w", fill="x")
ttk.Label(frame_intervalo, text="Sincronizar cada (horas):").pack(side="left")
entry_intervalo_horas = ttk.Entry(frame_intervalo, width=8)
entry_intervalo_horas.pack(side="left", padx=6)
entry_intervalo_horas.insert(0, f"{_cfg_actual['intervalo_minutos'] / 60:g}")
ttk.Button(frame_intervalo, text="Guardar configuración", command=guardar_configuracion).pack(side="left", padx=10)

# --- Consola de actividad (oscura, mismo azul marino que el panel de la web) ---
label_log = ttk.Label(cont, text="Actividad", style="Sub.TLabel")
label_log.pack(anchor="w", pady=(14, 4))

_log_frame = ttk.Frame(cont)
panel_mensajes = tk.Text(_log_frame, height=10, wrap="word", font=("Consolas", 9),
                         bg=COL_NAVY, fg=COL_TEXT_LIGHT, insertbackground=COL_TEXT_LIGHT,
                         relief="flat", borderwidth=0, highlightthickness=1,
                         highlightbackground="#2b3350", padx=12, pady=10)
_log_scroll = ttk.Scrollbar(_log_frame, command=panel_mensajes.yview)
panel_mensajes.configure(yscrollcommand=_log_scroll.set)
_log_scroll.pack(side="right", fill="y")
panel_mensajes.pack(side="left", fill="both", expand=True)
panel_mensajes.tag_config("error", foreground="#ff7a7a")
panel_mensajes.tag_config("ok", foreground="#69d08a")
panel_mensajes.tag_config("paso", foreground="#8ab4ff")
_log_frame.pack(fill="both", expand=True)

# Centrar la ventana al abrir (antes aparecia pegada arriba-izquierda).
root.update_idletasks()
_w, _h = 660, 830
_x = max(0, (root.winfo_screenwidth() - _w) // 2)
_y = max(0, (root.winfo_screenheight() - _h) // 2 - 20)
root.geometry(f"{_w}x{_h}+{_x}+{_y}")

# 800ms de margen para que la ventana termine de dibujarse antes de
# arrancar el hilo de fondo -- log_mensaje usa panel_mensajes, que recien
# existe a partir de la linea de arriba.
root.after(800, iniciar_auto_sync_al_abrir)

root.mainloop()