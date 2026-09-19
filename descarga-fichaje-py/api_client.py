"""
Cliente HTTP del agente (Fase 18) -- habla con /api/agent/checkins y
/api/agent/users usando SOLO la libreria estandar (urllib), sin sumar
`requests` como dependencia nueva -- mismo criterio que el resto del
proyecto (el backend en Node tambien usa fetch nativo en vez de sumar SDKs).
"""
import json
import urllib.request
import urllib.error

# 40s (antes 20): un servidor recien despertando (Render free) o un sitio
# con internet lento tarda mas de 20s en dar la primera respuesta. Si
# igual no contesta, agent_runner reintenta la misma tanda varias veces
# antes de dejarla pendiente para el proximo ciclo.
TIMEOUT_SEGUNDOS = 40
MAX_POR_LOTE = 1000  # bien por debajo del limite del servidor (5000) -- lotes chicos, mas facil de reintentar sin perder trabajo si uno falla a mitad de camino.


class ErrorSincronizacion(Exception):
    """Cualquier fallo de red/servidor -- el llamador decide reintentar despues.
    retry_after: segundos sugeridos por el servidor antes de reintentar
    (header Retry-After, solo viene poblado en un 429 -- ver agent_runner,
    que lo usa para esperar y reintentar la MISMA tanda en vez de darse
    por vencido hasta el proximo ciclo)."""
    def __init__(self, mensaje, status=None, retry_after=None):
        super().__init__(mensaje)
        self.status = status
        self.retry_after = retry_after


def _post(url, api_key, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-agent-key": api_key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEGUNDOS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", errors="replace")
        try:
            detalle = json.loads(detalle).get("error", detalle)
        except Exception:
            pass
        # Retry-After (segundos) -- lo manda el limitador de pedidos del
        # servidor en un 429, para saber cuanto esperar antes de reintentar
        # en vez de adivinar (ver agent_runner._subir_pendientes_en_tandas).
        retry_after = None
        try:
            retry_after = int(e.headers.get("Retry-After"))
        except (TypeError, ValueError):
            pass
        raise ErrorSincronizacion(f"HTTP {e.code}: {detalle}", status=e.code, retry_after=retry_after)
    except urllib.error.URLError as e:
        raise ErrorSincronizacion(f"No se pudo conectar al servidor: {e.reason}")
    except (TimeoutError, OSError) as e:
        # Bug real: un timeout al LEER la respuesta (servidor que tarda en
        # contestar -- Render recien despertando, o internet lento del
        # sitio) NO lo tira urllib como URLError sino como TimeoutError /
        # OSError crudo, porque ocurre sobre el socket ya devuelto por
        # urlopen, fuera del try de urllib. Sin este except, ese timeout se
        # propagaba y CRASHEABA el hilo (traceback en pantalla) en vez de
        # quedar como "se reintenta en la proxima corrida" -- que es lo que
        # el resto del agente ya sabe manejar sin perder nada (la cola
        # local queda intacta y marcada como no sincronizada).
        raise ErrorSincronizacion(f"El servidor no respondió a tiempo: {e}")


def _en_lotes(lista, tam):
    for i in range(0, len(lista), tam):
        yield lista[i:i + tam]


def probar_conexion(base_url, api_key):
    """GET /api/agent/ping -- confirma que la clave es valida sin mandar datos."""
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/agent/ping",
        headers={"x-agent-key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEGUNDOS) as resp:
            return True, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, str(e.reason)
    except (TimeoutError, OSError) as e:
        # Mismo caso que en _post: un timeout de lectura llega como
        # TimeoutError/OSError crudo, no como URLError.
        return False, str(e)


def subir_fichajes(base_url, api_key, registros):
    """registros: lista de dicts {USERID, CHECKTIME, MACHINE_IP, MACHINE_SN}
    (MISMOS nombres de columna que exporter.py -- sin transformar nada).
    Devuelve (total_insertado, total_error) sumando todos los lotes.
    """
    url = f"{base_url.rstrip('/')}/api/agent/checkins"
    inserted, errors = 0, 0
    for lote in _en_lotes(registros, MAX_POR_LOTE):
        resultado = _post(url, api_key, {"records": lote})
        inserted += resultado.get("inserted", 0)
        errors += resultado.get("errors", 0)
    return inserted, errors


def subir_usuarios(base_url, api_key, registros):
    """registros: lista de dicts {USERID, Badgenumber, Name}."""
    url = f"{base_url.rstrip('/')}/api/agent/users"
    upserted = 0
    for lote in _en_lotes(registros, MAX_POR_LOTE):
        resultado = _post(url, api_key, {"records": lote})
        upserted += resultado.get("upserted", 0)
    return upserted
