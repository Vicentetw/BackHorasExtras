"""
Bug real encontrado compilando el .exe por primera vez: tanto config.ini
como agente_local.db se armaban con `os.path.dirname(os.path.abspath(__file__))`
-- eso funciona corriendo main.py como script, pero DENTRO de un .exe de
PyInstaller, __file__ apunta a la carpeta temporal donde se descomprime el
programa (borrada al cerrar), no a la carpeta donde esta el .exe de
verdad. Resultado: cada corrida "olvidaba" todo -- config.ini y la cola
local nunca se encontraban entre una ejecucion y la siguiente.

directorio_base() es el unico lugar que resuelve esto -- lo usan
config_loader.py y db_local.py, para no duplicar el fix ni arriesgarse a
que uno de los dos quede con la version vieja.
"""
import sys
import os


def directorio_base():
    if getattr(sys, "frozen", False):
        # Corriendo como .exe (PyInstaller) -- sys.executable ES el .exe real.
        return os.path.dirname(sys.executable)
    # Corriendo como script .py normal.
    return os.path.dirname(os.path.abspath(__file__))
