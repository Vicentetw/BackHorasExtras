import socket
try:
    from zk import ZK
except Exception:
    ZK = None


# ============================================================================
# CODIFICACION DE LOS NOMBRES DEL RELOJ
# ============================================================================
#
# EL BUG (detectado el 2026-09-20 mirando datos reales de produccion):
# los nombres con enie o acento llegaban MUTILADOS, con la letra faltante:
#
#     "CAÑETE, Nestor"  ->  "CAETE"
#     "AGÜERO, Paola"   ->  "AGERO"
#     "Gonzalez Rubén"  ->  "Gonzalez Rubn"
#     "LIZARRALDE, Iñaky" -> "LIZARRALDE, Iaky"
#
# Fijate que la letra no sale cambiada: DESAPARECE. Esa es la firma del
# problema. La libreria pyzk decodifica asi (zk/base.py:1095):
#
#     name = (name.split(b'\x00')[0]).decode(self.encoding, errors='ignore')
#
# y `self.encoding` es 'UTF-8' por defecto. El reloj guarda los nombres en
# una codificacion de UN byte por caracter (latin-1 / cp1252): la "Ñ" es el
# byte 0xD1, que en UTF-8 no es un comienzo valido. Con errors='ignore' ese
# byte se descarta en silencio y el nombre queda sin la letra.
#
# Ese destrozo despues rompia el matching: "CAETE" no se parece a "CAÑETE",
# asi que el empleado quedaba sin vincular.
#
# EL ARREGLO: leer en cp1252, que NUNCA descarta un byte (los 256 valores
# tienen caracter). Asi la "Ñ" vuelve a ser "Ñ".
#
# LA PRECAUCION: hay relojes que SI guardan en UTF-8. Leidos como cp1252,
# esos nombres salen al reves -- "CAÑETE" se ve como "CAÃETE" (lo que se
# suele llamar "mojibake"). `reparar_mojibake` detecta ese caso y lo
# deshace, asi que el agente funciona con los dos tipos de reloj sin que
# haya que configurar nada.
NAME_ENCODING = 'cp1252'


def reparar_mojibake(texto):
    """Deshace el caso 'texto UTF-8 leido como cp1252'.

    Si el reloj guardaba UTF-8 y lo leimos como cp1252, "Ñ" aparece como
    "Ã‘" y "é" como "Ã©". Se detecta por esos caracteres delatores; si al
    re-codificar el texto a bytes cp1252 y releerlo como UTF-8 el resultado
    es valido, era mojibake y se devuelve corregido. Si algo falla, se
    devuelve el texto original sin tocar: ante la duda, no empeorar.
    """
    if not texto or not any(c in texto for c in ('Ã', 'Â', 'â€')):
        return texto
    try:
        return texto.encode('cp1252').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return texto


def descargar_reloj(ip, puerto=4370, timeout=5, password='', callback_progreso=None):
    """Conecta con un reloj ZK y devuelve (users, attendances, error_msg).
    Si todo OK, error_msg es None. Se intentan capturar errores comunes.
    """
    if ZK is None:
        return None, None, 'Paquete `zk` no disponible. Instala la dependencia (pip install pyzk o zk)'

    try:
        pwd = int(password) if password else 0
    except Exception:
        pwd = 0

    try:
        # encoding=cp1252: ver el comentario de NAME_ENCODING arriba. Sin
        # esto, los nombres con enie o acento llegan con la letra borrada.
        zk = ZK(ip, port=puerto, timeout=timeout, password=pwd, encoding=NAME_ENCODING)
        conn = zk.connect()
        conn.disable_device()

        if callback_progreso:
            try:
                callback_progreso(f"{ip} → Descargando usuarios...")
            except Exception:
                pass

        users = conn.get_users()

        # Segunda red de seguridad: si este reloj guardaba en UTF-8, leerlo
        # como cp1252 deja los nombres al reves ("CAÃETE"). Se detecta y se
        # corrige aca, para que el resto del programa reciba siempre el
        # nombre bien escrito, venga del reloj que venga.
        for u in users or []:
            try:
                if getattr(u, 'name', None):
                    u.name = reparar_mojibake(u.name)
            except Exception:
                pass

        if callback_progreso:
            try:
                callback_progreso(f"{ip} → Descargando registros...")
            except Exception:
                pass

        attendances = conn.get_attendance()

        # Intentar extraer identificación del dispositivo (serial/sn) mediante varias alternativas
        machine_sn = None
        try:
            # Intenta métodos/atributos comunes sin lanzar si no existen
            if hasattr(conn, 'get_serialnumber'):
                try:
                    machine_sn = conn.get_serialnumber()
                except Exception:
                    machine_sn = None

            if not machine_sn and hasattr(conn, 'get_device_info'):
                try:
                    info = conn.get_device_info()
                    # info puede ser dict-like o string
                    if isinstance(info, dict):
                        machine_sn = info.get('serial') or info.get('sn') or info.get('Serial')
                    else:
                        machine_sn = str(info)
                except Exception:
                    machine_sn = None

            if not machine_sn and hasattr(conn, 'get_firmware_version'):
                try:
                    # algunos SDK exponen versión y serial juntos
                    fw = conn.get_firmware_version()
                    machine_sn = str(fw)
                except Exception:
                    machine_sn = None

            # atributos directos
            if not machine_sn:
                for attr in ('serialnumber', 'serial', 'sn', 'device_sn'):
                    if hasattr(conn, attr):
                        try:
                            val = getattr(conn, attr)
                            if callable(val):
                                val = val()
                            if val:
                                machine_sn = str(val); break
                        except Exception:
                            continue
        except Exception:
            machine_sn = None

        # Anotar metadata en cada attendance
        if attendances:
            for a in attendances:
                try:
                    a.machine_ip = ip
                except Exception:
                    pass
                try:
                    a.machine_sn = machine_sn or getattr(a, 'machine_sn', '') or ''
                except Exception:
                    try:
                        a.machine_sn = machine_sn or ''
                    except Exception:
                        pass

        conn.enable_device()
        conn.disconnect()

        return users, attendances, None

    except socket.timeout:
        return None, None, f"{ip} → Tiempo de conexión agotado."
    except ConnectionRefusedError:
        return None, None, f"{ip} → Error de conexión. El reloj no responde."
    except OSError:
        return None, None, f"{ip} → Error de conexión. Verifique red o IP."
    except Exception as e:
        return None, None, f"{ip} → Error inesperado: {str(e)}"


# ============================================================================
# Usuarios marcadores
# ============================================================================
#
# QUE SON
# -------
# Los marcadores son usuarios del reloj que NO son personas. Sirven para que
# el empleado avise QUE clase de fichaje esta por hacer: primero ficha el
# marcador, despues ficha el. El backend los interpreta asi:
#
#     5  -> se va por un tema particular
#     6  -> vuelve de ese tema particular
#     9  -> empieza a hacer horas extra
#     10 -> termina de hacer horas extra
#
# POR QUE TIENEN QUE EXISTIR EN EL RELOJ
# --------------------------------------
# El marcador solo sirve si alguien puede FICHARLO, y solo se puede fichar lo
# que esta cargado en el reloj. Crearlo unicamente en la base del sistema no
# alcanza: nunca llegaria un fichaje suyo. Por eso esto escribe en el reloj.
#
# Una vez creados aca, el resto sale solo: la sincronizacion de usuarios los
# trae a la tabla `users`, y la pantalla de Marcadores los detecta sola
# porque el backend busca usuarios cuyo Badgenumber sea de 1-2 digitos y cuyo
# nombre sea ese mismo numero. De ahi que el nombre se cargue como "5" y no
# como "Salida particular": ese formato es la senal que dispara la
# deteccion automatica.
#
# LA REGLA QUE PIDIO EL USUARIO: no pisar a nadie
# -----------------------------------------------
# Un reloj puede tener ya ocupado el numero 5 con una persona de verdad (una
# empresa que arranco los legajos desde el 1). Escribir ahi le borraria el
# nombre y la huella a un empleado real. Entonces cada numero se crea SOLO si
# esta libre; si esta ocupado se informa por quien y no se toca.
MARCADORES = [
    ('5', 'Salida por tema particular'),
    ('6', 'Regreso de tema particular'),
    ('9', 'Inicio de horas extra'),
    ('10', 'Fin de horas extra'),
]


def crear_marcadores(ip, puerto=4370, admin_password='', numeros=None, timeout=5):
    """Crea en el reloj los usuarios marcadores que falten.

    Devuelve (resultados, error_msg). `resultados` es una lista de tuplas
    (numero, estado, detalle) con estado en 'creado' | 'ya_existe' |
    'ocupado' | 'error'. Ningun usuario existente se modifica ni se borra.
    """
    if ZK is None:
        return None, 'Paquete `zk` no disponible. Instala la dependencia (pip install pyzk o zk)'

    pedidos = [n for n, _ in MARCADORES] if numeros is None else [str(n) for n in numeros]
    descripciones = dict(MARCADORES)

    try:
        pwd = int(admin_password) if admin_password else 0
    except Exception:
        pwd = 0

    conn = None
    try:
        zk = ZK(ip, port=puerto, timeout=timeout, password=pwd, encoding=NAME_ENCODING)
        conn = zk.connect()
        conn.disable_device()

        existentes = conn.get_users() or []

        # Se indexa por las DOS claves con las que el reloj identifica a un
        # usuario, porque no son lo mismo: `uid` es la posicion interna y
        # `user_id` es el numero de credencial (el Badgenumber que despues
        # viaja en cada fichaje). Un numero esta ocupado si coincide con
        # cualquiera de las dos: escribir sobre uno u otro pisaria a alguien.
        ocupados = {}
        for u in existentes:
            for clave in (getattr(u, 'uid', None), getattr(u, 'user_id', None)):
                if clave not in (None, ''):
                    ocupados.setdefault(str(clave), u)

        resultados = []
        for numero in pedidos:
            ocupante = ocupados.get(numero)
            if ocupante is not None:
                nombre = (getattr(ocupante, 'name', '') or '').strip()
                # Ya es el marcador (el reloj lo tiene con el numero como
                # nombre): no hay nada que hacer, no es un problema.
                if nombre == numero:
                    resultados.append((numero, 'ya_existe', 'ya estaba creado'))
                else:
                    resultados.append((numero, 'ocupado',
                                       f'lo usa "{nombre or "(sin nombre)"}" -- no se toco'))
                continue

            try:
                # password = el propio numero, para que el marcador se pueda
                # fichar por teclado sin huella (es el uso normal: nadie
                # enrola la huella de un usuario que no es una persona).
                conn.set_user(uid=int(numero), name=numero, privilege=0,
                              password=numero, user_id=numero)
                resultados.append((numero, 'creado', descripciones.get(numero, '')))
            except Exception as e:
                resultados.append((numero, 'error', str(e)))

        conn.enable_device()
        conn.disconnect()
        return resultados, None

    except socket.timeout:
        return None, f"{ip} → Tiempo de conexión agotado."
    except ConnectionRefusedError:
        return None, f"{ip} → Error de conexión. El reloj no responde."
    except OSError:
        return None, f"{ip} → Error de conexión. Verifique red o IP."
    except Exception as e:
        return None, f"{ip} → Error inesperado: {str(e)}"
    finally:
        if conn is not None:
            try:
                conn.enable_device()
                conn.disconnect()
            except Exception:
                pass


def registrar_huella(ip, puerto=4370, admin_password='', user_id=None, dedo=1):
    """Enrola huella en el reloj. Devuelve (ok:bool, mensaje:str)."""
    if ZK is None:
        return False, 'Paquete `zk` no disponible. Instala la dependencia (pip install pyzk o zk)'

    try:
        pwd = int(admin_password) if admin_password else 0
    except Exception:
        pwd = 0

    try:
        zk = ZK(ip, port=puerto, timeout=5, password=pwd, encoding=NAME_ENCODING)
        conn = zk.connect()
        conn.disable_device()

        usuario = None
        try:
            usuario = conn.get_user(int(user_id)) if user_id is not None else None
        except Exception:
            usuario = None

        if not usuario:
            # crear usuario con uid=user_id, nombre=user_id y privilege 0
            #
            # OJO: poner el legajo como NOMBRE tiene una consecuencia rio
            # abajo. En produccion hay usuarios de reloj llamados "9370" o
            # "2489" -- salieron de aca. Despues, al vincular el usuario del
            # reloj con el empleado, el nombre no sirve para corroborar nada
            # y esos casos quedan marcados como "sin_nombre" (ver
            # matchingRules.js en el backend): se pueden vincular igual, pero
            # obligan a una revision manual.
            # Mejora pendiente: recibir el nombre real del empleado como
            # parametro y escribirlo aca.
            try:
                conn.set_user(uid=int(user_id), name=str(user_id), privilege=0)
            except Exception:
                pass

        # iniciar enrolamiento del dedo
        try:
            conn.enroll_user(int(user_id), int(dedo))
        except Exception as e:
            try:
                conn.enable_device()
                conn.disconnect()
            except Exception:
                pass
            return False, f'Error enrolando huella: {str(e)}'

        try:
            conn.enable_device()
            conn.disconnect()
        except Exception:
            pass

        return True, f'Reloj esperando huella para {user_id}, dedo {dedo}'

    except Exception as e:
        return False, f'Error: {str(e)}'
