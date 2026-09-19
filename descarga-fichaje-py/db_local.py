"""
Cola local de sincronizacion (Fase 18 -- agente automatico).

Guarda los fichajes/usuarios descargados de los relojes en un SQLite local
ANTES de intentar subirlos -- si el servidor no esta disponible (sitio sin
internet en ese momento, servidor caido, etc.), quedan marcados como
pendientes y se reintentan solos en la proxima corrida, sin perder nada.

Se usa sqlite3 (viene con Python, sin instalar nada) -- mismo criterio que
el resto de este proyecto: evitar dependencias nuevas si no hacen falta.
"""
import sqlite3
import os
from datetime import datetime, timezone
from paths import directorio_base

# Bug real encontrado compilando el .exe (ver paths.py) -- no usar
# __file__ directo aca, se rompe dentro del ejecutable empaquetado.
DB_PATH = os.path.join(directorio_base(), "agente_local.db")


def _conectar():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fichajes_pendientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userid TEXT NOT NULL,
            checktime TEXT NOT NULL,
            machine_ip TEXT,
            machine_sn TEXT,
            sincronizado INTEGER NOT NULL DEFAULT 0,
            creado_en TEXT NOT NULL,
            UNIQUE(userid, checktime)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS usuarios_pendientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userid TEXT NOT NULL,
            badgenumber TEXT NOT NULL,
            name TEXT,
            sincronizado INTEGER NOT NULL DEFAULT 0,
            creado_en TEXT NOT NULL,
            UNIQUE(userid)
        )
    """)
    return conn


def _ahora():
    return datetime.now(timezone.utc).isoformat()


def guardar_fichajes(attendances):
    """attendances: lista de objetos con .user_id, .timestamp, .machine_ip, .machine_sn
    (el mismo shape que devuelve zk_service.descargar_reloj). Dedupe local
    por (userid, checktime) -- INSERT OR IGNORE, mismo criterio que el
    servidor (que tiene su propio UNIQUE ademas -- doble proteccion, nunca
    esta de mas dado que esto viaja por internet).
    """
    conn = _conectar()
    nuevos = 0
    try:
        for a in attendances:
            checktime = a.timestamp.strftime("%Y-%m-%d %H:%M:%S") if hasattr(a.timestamp, "strftime") else str(a.timestamp)
            cur = conn.execute(
                "INSERT OR IGNORE INTO fichajes_pendientes (userid, checktime, machine_ip, machine_sn, creado_en) VALUES (?, ?, ?, ?, ?)",
                (str(a.user_id), checktime, getattr(a, "machine_ip", None), getattr(a, "machine_sn", None), _ahora())
            )
            if cur.rowcount > 0:
                nuevos += 1
        conn.commit()
    finally:
        conn.close()
    return nuevos


def guardar_usuarios(users):
    """users: lista de objetos con .user_id, .name (shape de zk_service).
    A diferencia de los fichajes, un usuario se puede actualizar (nombre
    cambiado) -- REPLACE en vez de IGNORE, pero solo si todavia no se
    sincronizo (para no perder de vista una actualizacion pendiente).
    """
    conn = _conectar()
    try:
        for u in users:
            conn.execute(
                """INSERT INTO usuarios_pendientes (userid, badgenumber, name, creado_en) VALUES (?, ?, ?, ?)
                   ON CONFLICT(userid) DO UPDATE SET name=excluded.name, sincronizado=0
                   WHERE sincronizado=1 AND name != excluded.name""",
                (str(u.user_id), str(u.user_id), u.name, _ahora())
            )
        conn.commit()
    finally:
        conn.close()


def obtener_pendientes_fichajes(limite=2000):
    conn = _conectar()
    try:
        cur = conn.execute(
            "SELECT id, userid, checktime, machine_ip, machine_sn FROM fichajes_pendientes WHERE sincronizado = 0 ORDER BY id LIMIT ?",
            (limite,)
        )
        return cur.fetchall()
    finally:
        conn.close()


def obtener_pendientes_usuarios(limite=2000):
    conn = _conectar()
    try:
        cur = conn.execute(
            "SELECT id, userid, badgenumber, name FROM usuarios_pendientes WHERE sincronizado = 0 ORDER BY id LIMIT ?",
            (limite,)
        )
        return cur.fetchall()
    finally:
        conn.close()


def marcar_sincronizados_fichajes(ids):
    if not ids:
        return
    conn = _conectar()
    try:
        conn.executemany("UPDATE fichajes_pendientes SET sincronizado = 1 WHERE id = ?", [(i,) for i in ids])
        conn.commit()
    finally:
        conn.close()


def marcar_sincronizados_usuarios(ids):
    if not ids:
        return
    conn = _conectar()
    try:
        conn.executemany("UPDATE usuarios_pendientes SET sincronizado = 1 WHERE id = ?", [(i,) for i in ids])
        conn.commit()
    finally:
        conn.close()


def contar_pendientes():
    conn = _conectar()
    try:
        f = conn.execute("SELECT COUNT(*) FROM fichajes_pendientes WHERE sincronizado = 0").fetchone()[0]
        u = conn.execute("SELECT COUNT(*) FROM usuarios_pendientes WHERE sincronizado = 0").fetchone()[0]
        return f, u
    finally:
        conn.close()
