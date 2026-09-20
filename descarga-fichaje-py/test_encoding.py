"""Prueba del arreglo de codificacion de nombres del reloj.

Se corre solo:  python test_encoding.py

No necesita el reloj: simula los bytes tal como llegan por la red y
comprueba que el nombre salga bien escrito en los dos escenarios (reloj que
guarda en cp1252 y reloj que guarda en UTF-8).

Por que existe: el 2026-09-20 se descubrio que los nombres con enie o
acento llegaban con la letra BORRADA ("CAÑETE" -> "CAETE"), y eso rompia la
vinculacion del empleado con su usuario de reloj. Ver el comentario de
NAME_ENCODING en zk_service.py.
"""
from zk_service import reparar_mojibake, NAME_ENCODING

NOMBRES = ["CAÑETE, Nestor", "AGÜERO, Paola", "Gonzalez Rubén", "LIZARRALDE, Iñaky", "PEREZ, Juan"]

fallos = 0


def revisar(caso, esperado, obtenido):
    global fallos
    ok = esperado == obtenido
    if not ok:
        fallos += 1
    print(f"  {'OK  ' if ok else 'FALLA'} {caso}: esperado {esperado!r}, obtenido {obtenido!r}")


print("1. Como estaba ANTES (UTF-8 con errors='ignore'): la letra se pierde")
for n in NOMBRES:
    crudo = n.encode('cp1252')                       # lo que manda el reloj
    roto = crudo.decode('UTF-8', errors='ignore')    # como lo leia pyzk
    marca = "  <-- se perdio la letra" if roto != n else ""
    print(f"     {n!r} -> {roto!r}{marca}")

print()
print("2. Reloj que guarda en cp1252 (el caso de AVP), leido con el arreglo")
for n in NOMBRES:
    crudo = n.encode('cp1252')
    leido = crudo.decode(NAME_ENCODING, errors='ignore')
    revisar(n, n, reparar_mojibake(leido))

print()
print("3. Reloj que guarda en UTF-8, leido como cp1252 -> se detecta y se corrige")
for n in NOMBRES:
    crudo = n.encode('utf-8')
    leido = crudo.decode(NAME_ENCODING, errors='ignore')   # sale mojibake
    revisar(n, n, reparar_mojibake(leido))

print()
print("4. reparar_mojibake no debe tocar lo que ya esta bien")
for n in NOMBRES + ["", "9370", "MENDOZA"]:
    revisar(f"{n!r} intacto", n, reparar_mojibake(n))

print()
if fallos:
    print(f"RESULTADO: {fallos} fallas")
    raise SystemExit(1)
print("RESULTADO: todo OK")
