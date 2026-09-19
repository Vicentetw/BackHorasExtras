import socket
try:
    from zk import ZK
except Exception:
    ZK = None


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
        zk = ZK(ip, port=puerto, timeout=timeout, password=pwd)
        conn = zk.connect()
        conn.disable_device()

        if callback_progreso:
            try:
                callback_progreso(f"{ip} → Descargando usuarios...")
            except Exception:
                pass

        users = conn.get_users()

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
        zk = ZK(ip, port=puerto, timeout=5, password=pwd)
        conn = zk.connect()
        conn.disable_device()

        usuario = None
        try:
            usuario = conn.get_user(int(user_id)) if user_id is not None else None
        except Exception:
            usuario = None

        if not usuario:
            # crear usuario con uid=user_id, nombre=user_id y privilege 0
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
