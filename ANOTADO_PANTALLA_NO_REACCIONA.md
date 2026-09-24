# "Dejo la pantalla un rato, vuelvo, hago clic y no pasa nada"

Anotado el 2026-09-24. **Diagnosticado, no corregido.**

Síntoma: la página queda abierta sin usarse un rato. Al volver, se hace clic
en cualquier parte del menú y no reacciona. Hay que refrescar (F5) para que
vuelva a funcionar.

---

## Por qué pasa

Son **dos causas que se suman**, y ninguna de las dos tiene un tiempo límite
ni le avisa nada al usuario.

### Causa 1 — El token de Firebase vence a la hora

`auth.ts:127`:

```ts
async getIdToken(): Promise<string | null> {
  await this.ready();
  const current = this.auth.currentUser;
  if (!current) return null;
  return current.getIdToken();   // <-- sin timeout
}
```

`getIdToken()` sin argumentos devuelve el token guardado si todavía sirve, y
si venció **sale a renovarlo por red**. Los tokens de Firebase duran una hora.

El interceptor (`auth-interceptor.ts:20`) llama a esto **antes de cada
pedido** al backend. O sea que después de una hora sin usar la página:

1. se hace clic en el menú;
2. la ruta resuelve bien (el guard usa el perfil ya cacheado, no pide nada);
3. la pantalla nueva dispara su pedido HTTP;
4. el interceptor pide el token → Firebase tiene que renovarlo por red;
5. si esa renovación tarda o se cuelga —la computadora recién despertó, el
   wifi todavía no volvió—, **la promesa nunca resuelve**;
6. el pedido nunca sale. Ni falla: queda esperando.

Por eso "no hace nada": no hay error, no hay spinner que termine, no hay
nada. Y por eso refrescar lo arregla: al recargar, Firebase se inicializa de
nuevo y renueva el token limpio.

### Causa 2 — El servidor de Render se duerme

El plan gratuito de Render apaga el servicio cuando nadie lo usa. El primer
pedido después de eso tarda entre 30 y 60 segundos en despertarlo.

La app **ya contempla esto, pero solo al arrancar**: `current-user.ts` tiene
reintentos, tiempos límite de 8 y 20 segundos, y la animación de "Conectando…"
con el mensaje de que el servidor se está despertando.

Nada de eso corre en una navegación posterior. Un pedido hecho al hacer clic
en el menú sale sin tiempo límite, sin reintento y sin ningún cartel.

Las dos causas dan el mismo síntoma y se potencian: después de un rato largo
es probable que estén las dos a la vez.

---

## Cómo confirmarlo

Con la consola del navegador abierta (F12), dejar la página quieta más de una
hora y después hacer clic en el menú:

- **Pestaña Network sin ningún pedido nuevo** → es la causa 1: el pedido ni
  siquiera sale, está esperando el token.
- **Un pedido en estado "pending" mucho tiempo** → es la causa 2: salió y el
  servidor está despertando.

---

## Cómo se arregla

### 1. Ponerle un tiempo límite a la renovación del token

Es la corrección más directa y la que más tapa. Si la renovación no vuelve en
unos segundos, hay que cortar y decidir: reintentar, o mandar a la pantalla de
login.

Hoy no hay ningún límite: si se cuelga, se cuelga para siempre.

### 2. Que el manejo de "el servidor está despertando" no sea solo del arranque

Ya existe, probado y funcionando, en `current-user.ts`. Lo que falta es que
cualquier pedido pueda usarlo, no solo el del arranque. El lugar natural es el
interceptor, que es por donde pasan todos.

### 3. Detectar que se volvió a la pestaña

El navegador avisa cuando una pestaña vuelve a estar visible
(`visibilitychange`) y cuando la conexión vuelve (`online`). Aprovecharlo para
renovar el token y despertar el servidor **antes** de que la persona haga
clic, en vez de que se entere al hacerlo.

Es lo que convierte el arreglo en algo que no se nota: para cuando hace clic,
ya está todo listo.

### 4. Que un pedido colgado se vea

Aunque se arreglen las tres cosas de arriba, algún pedido va a tardar. Que la
pantalla muestre que está esperando —y ofrezca reintentar— es mejor que
parecer rota.

---

## Por qué conviene hacerlo

No es solo incomodidad. Una pantalla que no responde y no explica nada es
indistinguible de una rota: quien la usa no tiene forma de saber si tiene que
esperar, refrescar, o avisar que el sistema se cayó.

Y con un cliente afuera es peor: lo va a leer como que el sistema no anda.
