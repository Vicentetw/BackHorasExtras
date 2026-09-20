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
