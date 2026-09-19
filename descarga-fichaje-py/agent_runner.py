"""
Ciclo completo del agente (Fase 18): baja de los relojes configurados,
guarda en la cola local (SQLite, sobrevive a un corte de red o un
reinicio), e intenta subir lo pendiente al servidor. Pensado para correr
tanto desatendido (--headless, disparado por el Programador de tareas de
Windows, o en --loop propio) como llamado desde el boton "Descargar Datos"
de la ventana -- UN SOLO camino de codigo para los tres casos, para que
nunca diverjan.

Si el servidor no esta configurado o no responde, el ciclo NO falla: los
fichajes quedan en la cola local (ya estan a salvo) para la proxima corrida.
"""
import time
from datetime import datetime
from zk_service import descargar_reloj
import db_local
import api_client
import config_loader


def ejecutar_ciclo(log=print, sincronizar="todo"):
    """log: funcion para reportar progreso (print en headless, o el panel
    de mensajes de la ventana en modo GUI) -- misma firma que ya usa
    log_mensaje en main.py, para poder pasarla directo.

    sincronizar: "todo" (default, usado por --headless/--loop/el boton
    "Descargar Datos"), "fichajes" o "usuarios" -- pedido real: botones
    separados en la ventana para subir SOLO fichajes o SOLO usuarios sin
    tocar la cola del otro tipo. La descarga de los relojes siempre trae
    ambos juntos (asi responde el reloj, no se puede pedir uno solo) --
    lo que cambia es unicamente que se sube despues.

    Devuelve un resumen (dict) -- pensado para poder mostrar un mensaje de
    confirmacion claro al final (messagebox en la ventana), no solo texto
    perdido en el panel de log."""
    resultado = {
        "fichajes_sincronizados": 0, "usuarios_sincronizados": 0,
        "pendientes_fichajes": 0, "pendientes_usuarios": 0,
        "errores": [],
    }
    cfg = config_loader.cargar()
    relojes = cfg["relojes"]

    if not relojes:
        log("No hay relojes configurados en config.ini -- nada para descargar.")
        return resultado

    # Pedido real: no molestar en horario de fichaje -- mientras se
    # descarga, el reloj queda con el lector apagado unos segundos
    # (ver zk_service.descargar_reloj, disable_device/enable_device).
    # Si cae dentro de un horario excluido (config.ini), se salta la
    # corrida ENTERA -- ni se conecta a los relojes -- y se reintenta en
    # el proximo ciclo.
    ahora = datetime.now().time()
    if config_loader.en_horario_excluido(ahora, cfg["horarios_excluidos"]):
        log(f"Horario excluido ({ahora.strftime('%H:%M')}) -- no se conecta a los relojes esta vez, se reintenta en el próximo ciclo.")
        return resultado

    for ip, password in relojes:
        log(f"{ip} -> Conectando...")
        users, attendances, error = descargar_reloj(ip, 4370, cfg["timeout_segundos"], password)
        if error:
            log(f"{error}")
            resultado["errores"].append(error)
            continue

        if attendances:
            nuevos = db_local.guardar_fichajes(attendances)
            log(f"{ip} -> {len(attendances)} fichajes descargados ({nuevos} nuevos en la cola local).")
        if users:
            db_local.guardar_usuarios(users)
            log(f"{ip} -> {len(users)} usuarios descargados.")

    pend_fichajes, pend_usuarios = db_local.contar_pendientes()
    resultado["pendientes_fichajes"] = pend_fichajes
    resultado["pendientes_usuarios"] = pend_usuarios
    log(f"Cola local: {pend_fichajes} fichajes y {pend_usuarios} usuarios pendientes de subir.")

    if not cfg["server_url"] or not cfg["api_key"]:
        log("Servidor no configurado (config.ini) -- se queda todo guardado local, no se sube nada todavia.")
        return resultado

    if sincronizar == "fichajes":
        sync = subir_fichajes_pendientes(cfg["server_url"], cfg["api_key"], log)
    elif sincronizar == "usuarios":
        sync = subir_usuarios_pendientes(cfg["server_url"], cfg["api_key"], log)
    else:
        sync = sincronizar_pendientes(cfg["server_url"], cfg["api_key"], log)
    resultado.update(sync)
    return resultado


# Bug real de produccion: obtener_pendientes_*() trae como mucho 2000 filas
# por consulta (limite de db_local.py) -- la version anterior solo pedia UNA
# tanda por ciclo, asi que con una cola grande (ej. la primera sincronizacion
# de un sitio con meses de historial -- se dio un caso real de 153.000
# fichajes pendientes) hacian falta decenas de corridas programadas para
# terminar de subir todo, a intervalo_minutos cada una. Ahora se repite
# tanda tras tanda DENTRO del mismo ciclo hasta vaciar la cola -- el limite
# de iteraciones de abajo es solo un freno de seguridad (200 tandas x 2000 =
# 400.000 registros como mucho por ciclo), no algo pensado para alcanzarse
# en un uso normal.
MAX_TANDAS_POR_CICLO = 200

# Bug real de produccion: al vaciar una cola grande (151.000 fichajes
# pendientes en un caso real) el agente mandaba tandas de 2000 registros
# (2 pedidos HTTP cada una, ver api_client.MAX_POR_LOTE) SIN pausa entre
# ellas -- en menos de un minuto ya habia mandado varios pedidos y el
# servidor empezo a devolver 429 (routes/agent.js limita los pedidos por
# minuto, a proposito, por ser la unica puerta del sistema alcanzable con
# solo una clave). Nada se pierde (lo que falla queda pendiente y se
# reintenta), pero asi hacian falta muchas corridas para vaciar una cola
# grande. Dos cosas lo resuelven:
#  1. Una pausa entre tandas para no acercarse siquiera al limite.
#  2. Si el servidor IGUAL frena, esperar lo que pide el header
#     Retry-After y reintentar la MISMA tanda ahi mismo, en vez de
#     abandonar hasta la proxima corrida programada.
PAUSA_ENTRE_TANDAS_SEGUNDOS = 4
MAX_REINTENTOS_429 = 8
ESPERA_429_POR_DEFECTO_SEGUNDOS = 65  # margen sobre la ventana de 60s del limite, por si el servidor no manda Retry-After.

# Pedido real: que una corrida no se corte por lentitud puntual. Ademas
# del reintento por 429 (limite de pedidos), se reintenta la MISMA tanda
# ante un fallo transitorio -- timeout de respuesta (servidor recien
# despertando, internet lento del sitio), corte de red momentaneo, o un
# error 5xx del servidor. Espera creciente (15s, 30s, 45s) y despues de
# MAX_REINTENTOS_RED se deja pendiente para el proximo ciclo, sin perder
# nada (la cola local queda marcada como no sincronizada). Un error
# 4xx (clave invalida, datos mal formados) NO se reintenta -- no se
# arregla esperando.
MAX_REINTENTOS_RED = 3
ESPERA_RED_BASE_SEGUNDOS = 15


def _subir_pendientes_en_tandas(obtener_pendientes, subir_fn, marcar_sincronizados, armar_registro, log, etiqueta):
    """Logica compartida por subir_usuarios_pendientes/subir_fichajes_pendientes
    -- pide tandas de la cola local y las sube una por una hasta vaciarla,
    respetando el limite de pedidos/minuto del servidor (pausa entre
    tandas) y reintentando en el momento si igual lo frenan (429), en vez
    de abandonar hasta la proxima corrida programada.

    obtener_pendientes: funcion sin argumentos, trae la proxima tanda
    (lista de filas de db_local, o vacia si no queda nada).
    subir_fn: funcion(registros) -> cantidad subida (numero), sube UNA
    tanda al servidor.
    marcar_sincronizados: funcion(ids) -- marca la tanda como ya subida en
    la cola local, dado el primer campo (id) de cada fila.
    armar_registro: funcion(fila) -> dict con el shape que espera el
    servidor.
    etiqueta: "usuarios" o "fichajes", solo para los mensajes de log.

    Devuelve (total_subido, lista_de_errores)."""
    total_subido = 0
    errores = []
    algo_pendiente = False
    reintentos_429 = 0
    reintentos_red = 0

    for _ in range(MAX_TANDAS_POR_CICLO):
        pendientes = obtener_pendientes()
        if not pendientes:
            break
        algo_pendiente = True
        registros = [armar_registro(fila) for fila in pendientes]
        try:
            subido = subir_fn(registros)
            marcar_sincronizados([fila[0] for fila in pendientes])
            total_subido += subido
            log(f"Servidor -> {subido} {etiqueta} sincronizados.")
            reintentos_429 = 0  # esta tanda salio bien -- resetear los contadores de reintentos
            reintentos_red = 0
            time.sleep(PAUSA_ENTRE_TANDAS_SEGUNDOS)
        except api_client.ErrorSincronizacion as e:
            if e.status == 429 and reintentos_429 < MAX_REINTENTOS_429:
                reintentos_429 += 1
                espera = e.retry_after or ESPERA_429_POR_DEFECTO_SEGUNDOS
                log(f"El servidor pidió bajar el ritmo -- se espera {espera}s y se reintenta la misma tanda de {etiqueta} ({reintentos_429}/{MAX_REINTENTOS_429}).")
                time.sleep(espera)
                continue  # reintentar la MISMA tanda -- no se marco como sincronizada

            # Fallo transitorio: sin status HTTP (timeout / corte de red) o
            # 5xx (error temporal del servidor). Se espera y se reintenta la
            # MISMA tanda unas cuantas veces antes de dejarla pendiente.
            es_transitorio = e.status is None or e.status >= 500
            if es_transitorio and reintentos_red < MAX_REINTENTOS_RED:
                reintentos_red += 1
                espera = ESPERA_RED_BASE_SEGUNDOS * reintentos_red  # 15s, 30s, 45s
                log(f"El servidor no respondió (lentitud o corte de red) -- se espera {espera}s y se reintenta la misma tanda de {etiqueta} ({reintentos_red}/{MAX_REINTENTOS_RED}).")
                time.sleep(espera)
                continue  # reintentar la MISMA tanda -- no se marco como sincronizada

            errores.append(f"{etiqueta}: {e}")
            log(f"No se pudieron subir los {etiqueta} (se reintenta en la próxima corrida): {e}")
            break

    if not algo_pendiente:
        log(f"{etiqueta.capitalize()}: nada nuevo para subir -- todo al día.")

    return total_subido, errores


def subir_usuarios_pendientes(server_url, api_key, log):
    """Sube SOLO la cola de usuarios pendientes, en tandas, hasta vaciarla.
    Separada de subir_fichajes_pendientes a proposito -- pedido real: un
    boton en la ventana para sincronizar solo usuarios sin tocar la cola
    de fichajes (y viceversa)."""
    total, errores = _subir_pendientes_en_tandas(
        obtener_pendientes=db_local.obtener_pendientes_usuarios,
        subir_fn=lambda registros: api_client.subir_usuarios(server_url, api_key, registros),
        marcar_sincronizados=db_local.marcar_sincronizados_usuarios,
        armar_registro=lambda u: {"USERID": u[1], "Badgenumber": u[2], "Name": u[3]},
        log=log,
        etiqueta="usuarios",
    )
    return {"usuarios_sincronizados": total, "errores": errores}


def subir_fichajes_pendientes(server_url, api_key, log):
    """Sube SOLO la cola de fichajes pendientes, en tandas, hasta vaciarla.
    Ver subir_usuarios_pendientes -- misma logica, tipo de registro
    distinto."""
    def _subir(registros):
        inserted, errors = api_client.subir_fichajes(server_url, api_key, registros)
        # errors: registros con formato invalido, ya rechazados del lado
        # del servidor -- nunca se van a poder subir, se avisa aparte pero
        # no cuenta como un fallo de sincronizacion (la tanda si se marca
        # como procesada).
        if errors:
            log(f"({errors} fichajes de esta tanda con error de formato -- no se van a poder subir)")
        return inserted

    total, errores = _subir_pendientes_en_tandas(
        obtener_pendientes=db_local.obtener_pendientes_fichajes,
        subir_fn=_subir,
        marcar_sincronizados=db_local.marcar_sincronizados_fichajes,
        armar_registro=lambda f: {"USERID": f[1], "CHECKTIME": f[2], "MACHINE_IP": f[3], "MACHINE_SN": f[4]},
        log=log,
        etiqueta="fichajes",
    )
    return {"fichajes_sincronizados": total, "errores": errores}


def sincronizar_pendientes(server_url, api_key, log):
    """Intenta subir TODO lo pendiente (usuarios y fichajes), en tandas,
    hasta vaciar la cola local. Un fallo de red no rompe el programa -- se
    reintenta en la proxima corrida, nada se pierde (sigue marcado como no
    sincronizado en la cola local). Devuelve un resumen con los TOTALES de
    todas las tandas. Usado por el ciclo completo (--headless/--loop/
    "Descargar Datos") -- para subir solo un tipo, ver
    subir_usuarios_pendientes/subir_fichajes_pendientes."""
    resultado_usuarios = subir_usuarios_pendientes(server_url, api_key, log)
    resultado_fichajes = subir_fichajes_pendientes(server_url, api_key, log)
    return {
        "usuarios_sincronizados": resultado_usuarios["usuarios_sincronizados"],
        "fichajes_sincronizados": resultado_fichajes["fichajes_sincronizados"],
        "errores": resultado_usuarios["errores"] + resultado_fichajes["errores"],
    }


def ejecutar_bucle(log=print):
    """Modo `--headless --loop`: se queda corriendo para siempre, repitiendo
    ejecutar_ciclo() cada `intervalo_minutos` (config.ini). Alternativa a
    programar el Programador de tareas de Windows -- mas simple de armar
    en un sitio sin nadie tecnico (un doble clic y listo), pero OJO: si el
    proceso se cuelga o la PC se reinicia, no se vuelve a levantar solo
    (el Programador de tareas si lo hace) -- por eso cada corrida esta
    protegida con try/except, para que un error puntual no tire abajo todo
    el bucle."""
    while True:
        cfg = config_loader.cargar()
        intervalo = max(1, cfg["intervalo_minutos"])
        try:
            ejecutar_ciclo(log=log)
        except Exception as e:
            log(f"Error inesperado en el ciclo (se reintenta en {intervalo} minutos): {e}")
        log(f"Esperando {intervalo} minutos hasta la próxima sincronización...")
        time.sleep(intervalo * 60)
