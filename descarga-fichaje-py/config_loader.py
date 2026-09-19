"""
Config del agente (Fase 18) -- un config.ini al lado del ejecutable,
editable a mano por quien instala el agente en cada sitio (una escuela,
una entidad). Usa configparser (viene con Python).
"""
import configparser
import os
from datetime import time as time_type
from paths import directorio_base

# Bug real encontrado compilando el .exe (ver paths.py) -- no usar
# __file__ directo aca, se rompe dentro del ejecutable empaquetado.
CONFIG_PATH = os.path.join(directorio_base(), "config.ini")

PLANTILLA = """[servidor]
; URL del backend y la clave de agente de ESTA empresa (se genera desde
; Facturacion -> Claves de agente, en el panel del superadmin). Dejar
; server_url y clave vacios si todavia no se va a sincronizar automatico
; -- el agente sigue pudiendo exportar los CSV localmente igual.
url =
clave =

[relojes]
; Una IP por linea. Si el reloj tiene clave, IP,clave (mismo formato que
; ya usaba la ventana de descarga manual).
; 172.155.0.16
; 172.155.0.17,123456

[agente]
; Cada cuantos minutos corre el ciclo completo en modo desatendido
; (--headless). Sin efecto en el modo con ventana -- eso lo dispara el
; Programador de tareas de Windows llamando al .exe con --headless.
intervalo_minutos = 15
zona_horaria = local

; Rangos HH:MM-HH:MM separados por coma en los que NO se conecta a los
; relojes -- pensado para no interferir en el horario de fichaje real
; (mientras descarga, el reloj queda con el lector apagado unos segundos).
; Si el ciclo cae dentro de uno de estos rangos, se salta esa corrida
; entera (ni se conecta a los relojes ni sincroniza) y se reintenta en el
; proximo intervalo. Se puede dejar vacio para no excluir ningun horario.
; Soporta rangos que cruzan la medianoche (ej. 22:00-02:00).
horarios_excluidos =

[relojes_conexion]
; Segundos de espera por reloj antes de darlo por caido. 5 (el valor
; anterior, fijo en el codigo) es poco para un reloj con bastante
; historial de fichajes guardado -- si la descarga de usuarios funciona
; pero la de fichajes no, probar subiendo este numero.
timeout_segundos = 20
"""


def asegurar_config():
    """Crea un config.ini de ejemplo si todavia no existe -- para que la
    primera corrida en un sitio nuevo no falle por archivo faltante, sino
    que deje algo editable con instrucciones adentro."""
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            f.write(PLANTILLA)
    return CONFIG_PATH


def cargar():
    asegurar_config()
    # allow_no_value=True -- la seccion [relojes] tiene lineas "bare" (solo
    # la IP, sin "= algo"), que es el formato mas simple de editar a mano.
    cfg = configparser.ConfigParser(allow_no_value=True)
    cfg.read(CONFIG_PATH, encoding="utf-8")

    relojes = []
    if cfg.has_section("relojes"):
        for key in cfg["relojes"]:
            valor = cfg["relojes"][key]
            if not valor:
                # configparser guarda "172.155.0.16" (sin "=") como una key
                # con valor None -- se recupera del nombre de la key, no del value.
                linea = key.strip()
            else:
                linea = f"{key.strip()},{valor.strip()}"
            if not linea or linea.startswith(';') or linea.startswith('#'):
                continue
            partes = linea.split(',')
            ip = partes[0].strip()
            password = partes[1].strip() if len(partes) > 1 else ""
            relojes.append((ip, password))

    horarios_excluidos = _parsear_horarios_excluidos(cfg.get("agente", "horarios_excluidos", fallback=""))

    return {
        "server_url": cfg.get("servidor", "url", fallback="").strip(),
        "api_key": cfg.get("servidor", "clave", fallback="").strip(),
        "relojes": relojes,
        "intervalo_minutos": cfg.getint("agente", "intervalo_minutos", fallback=15),
        "zona_horaria": cfg.get("agente", "zona_horaria", fallback="local"),
        "horarios_excluidos": horarios_excluidos,
        "timeout_segundos": cfg.getint("relojes_conexion", "timeout_segundos", fallback=20),
    }


def _parsear_horarios_excluidos(texto):
    """'07:45-08:15, 12:45-13:15' -> [(time(7,45), time(8,15)), (time(12,45), time(13,15))].
    Una linea mal escrita se ignora (no rompe el resto) -- mejor perder UN
    rango excluido que frenar todo el agente por un typo en el config.ini."""
    rangos = []
    for parte in texto.split(","):
        parte = parte.strip()
        if not parte:
            continue
        try:
            inicio_str, fin_str = parte.split("-")
            h1, m1 = (int(x) for x in inicio_str.strip().split(":"))
            h2, m2 = (int(x) for x in fin_str.strip().split(":"))
            rangos.append((time_type(h1, m1), time_type(h2, m2)))
        except (ValueError, TypeError):
            continue
    return rangos


def en_horario_excluido(ahora, rangos):
    """ahora: datetime.time. rangos: lista de (inicio, fin) de _parsear_horarios_excluidos.
    Soporta rangos que cruzan la medianoche (ej. 22:00-02:00)."""
    for inicio, fin in rangos:
        if inicio <= fin:
            if inicio <= ahora <= fin:
                return True
        else:
            if ahora >= inicio or ahora <= fin:
                return True
    return False


def guardar_relojes(lineas):
    """Bug real reportado: la ventana siempre mostraba la MISMA IP de
    ejemplo hardcodeada al abrir, sin importar lo que se hubiera tipeado
    y usado la vez anterior. Esto persiste la lista de relojes tal cual
    quedo escrita en el cuadro de texto (una linea por reloj, "IP" o
    "IP,clave") en el config.ini -- se llama despues de una descarga
    exitosa, asi la proxima vez que se abra la ventana (o corra
    --headless/--loop) ya esta precargada. Reescribe SOLO la seccion
    [relojes], conserva servidor/clave/intervalo tal como estaban.
    """
    asegurar_config()
    cfg = configparser.ConfigParser(allow_no_value=True)
    cfg.read(CONFIG_PATH, encoding="utf-8")

    if not cfg.has_section("relojes"):
        cfg.add_section("relojes")
    for key in list(cfg["relojes"]):
        cfg.remove_option("relojes", key)

    for linea in lineas:
        linea = linea.strip()
        if not linea or linea.startswith(';') or linea.startswith('#'):
            continue
        cfg.set("relojes", linea)

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        cfg.write(f)


def guardar_config_agente(intervalo_minutos, horarios_excluidos_texto):
    """Pedido real: poder tocar el intervalo y los horarios excluidos desde
    la ventana en vez de editar config.ini a mano (el publico de estos
    sitios no siempre es tecnico). Reescribe SOLO esas dos claves de
    [agente], conserva zona_horaria, [servidor] y [relojes] tal como
    estaban. horarios_excluidos_texto se guarda tal cual (ya viene
    validado/normalizado por quien llama, ver _parsear_horarios_excluidos
    para el formato esperado)."""
    asegurar_config()
    cfg = configparser.ConfigParser(allow_no_value=True)
    cfg.read(CONFIG_PATH, encoding="utf-8")

    if not cfg.has_section("agente"):
        cfg.add_section("agente")
    cfg.set("agente", "intervalo_minutos", str(int(intervalo_minutos)))
    cfg.set("agente", "horarios_excluidos", horarios_excluidos_texto.strip())

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        cfg.write(f)
