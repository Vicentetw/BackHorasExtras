"""Prueba de la creacion automatica de los usuarios marcadores.

Se corre solo:  python test_marcadores.py

No necesita el reloj: se reemplaza la clase ZK por una simulada que recuerda
que usuarios tenia y que usuarios le pidieron crear.

Por que existe: crear_marcadores ESCRIBE en el reloj. La regla que lo hace
seguro -- "si el numero ya lo usa una persona real, no se toca" -- no se
puede probar a mano en produccion sin arriesgar justo lo que se quiere
evitar: borrarle el nombre y la huella a un empleado. Ver el comentario de
MARCADORES en zk_service.py.
"""
import zk_service
from zk_service import crear_marcadores

fallos = 0


def revisar(caso, esperado, obtenido):
    global fallos
    ok = esperado == obtenido
    if not ok:
        fallos += 1
    print(f"  {'OK  ' if ok else 'FALLA'} {caso}: esperado {esperado!r}, obtenido {obtenido!r}")


class UsuarioFalso:
    def __init__(self, uid, name, user_id):
        self.uid, self.name, self.user_id = uid, name, user_id


class ConexionFalsa:
    def __init__(self, usuarios):
        # La lista NO se copia a proposito: un reloj de verdad se acuerda de
        # lo que se le grabo, y el caso 4 (correr dos veces seguidas) solo
        # tiene sentido si el simulado tambien se acuerda.
        self.usuarios = usuarios
        self.creados = []       # lo que se mando a escribir al reloj
        self.desconectado = False

    def disable_device(self): pass
    def enable_device(self): pass
    def disconnect(self): self.desconectado = True
    def get_users(self): return self.usuarios

    def set_user(self, uid=None, name='', privilege=0, password='', group_id='', user_id='', card=0):
        self.creados.append({'uid': uid, 'name': name, 'password': password, 'user_id': user_id})
        self.usuarios.append(UsuarioFalso(uid, name, user_id))


class RelojFalso:
    ultima = None

    def __init__(self, usuarios):
        self.conn = ConexionFalsa(usuarios)

    def connect(self):
        RelojFalso.ultima = self.conn
        return self.conn


def con_reloj(usuarios):
    """Instala un reloj simulado con esos usuarios y corre crear_marcadores."""
    zk_service.ZK = lambda *a, **k: RelojFalso(usuarios)
    resultados, error = crear_marcadores('10.0.0.1')
    return resultados, error, RelojFalso.ultima


print("1. Reloj vacio: se crean los cuatro marcadores")
resultados, error, conn = con_reloj([])
revisar("sin error", None, error)
revisar("estados", ['creado'] * 4, [e for _, e, _ in resultados])
revisar("numeros creados", ['5', '6', '9', '10'], [c['user_id'] for c in conn.creados])
# El nombre TIENE que ser el numero: es lo que dispara la deteccion
# automatica en la pantalla de Marcadores del sistema.
revisar("nombre = numero", ['5', '6', '9', '10'], [c['name'] for c in conn.creados])
revisar("clave = numero", ['5', '6', '9', '10'], [c['password'] for c in conn.creados])

print()
print("2. LA REGLA IMPORTANTE: un empleado real ocupa el 5 -> no se toca")
empleado = UsuarioFalso(5, 'PORRAS, Leandro', '5')
resultados, error, conn = con_reloj([empleado])
estado_5 = dict((n, e) for n, e, _ in resultados)['5']
revisar("el 5 queda 'ocupado'", 'ocupado', estado_5)
revisar("no se escribio sobre el 5", [], [c for c in conn.creados if c['user_id'] == '5'])
revisar("el empleado conserva su nombre", 'PORRAS, Leandro', empleado.name)
revisar("los otros tres SI se crean", ['6', '9', '10'], [c['user_id'] for c in conn.creados])

print()
print("3. Ocupado por user_id aunque el uid sea otro (el reloj usa las dos claves)")
otro = UsuarioFalso(77, 'GOMEZ, Ana', '9')
resultados, error, conn = con_reloj([otro])
revisar("el 9 queda 'ocupado'", 'ocupado', dict((n, e) for n, e, _ in resultados)['9'])
revisar("no se escribio sobre el 9", [], [c for c in conn.creados if c['user_id'] == '9'])

print()
print("4. Correr dos veces no duplica nada")
usuarios = []
con_reloj(usuarios)
resultados, error, conn = con_reloj(usuarios)
revisar("la segunda vez ya existen", ['ya_existe'] * 4, [e for _, e, _ in resultados])
revisar("no se escribio nada", [], conn.creados)

print()
print("5. Se puede pedir un numero distinto si el 5 estaba ocupado")
zk_service.ZK = lambda *a, **k: RelojFalso([])
resultados, error = crear_marcadores('10.0.0.1', numeros=[55, 56])
revisar("se crean los pedidos", ['55', '56'], [n for n, _, _ in resultados])
revisar("ambos creados", ['creado', 'creado'], [e for _, e, _ in resultados])

print()
print("6. Si el reloj no responde, se avisa y no se inventa nada")
def romper(*a, **k):
    raise OSError('sin red')
zk_service.ZK = romper
resultados, error = crear_marcadores('10.0.0.1')
revisar("no hay resultados", None, resultados)
revisar("hay mensaje de error", True, bool(error))

print()
if fallos:
    print(f"RESULTADO: {fallos} fallas")
    raise SystemExit(1)
print("RESULTADO: todo OK")
