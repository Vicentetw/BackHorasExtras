# Variables de entorno del backend

Lista completa, extraída del código (no de memoria): son todas las
`process.env.*` que usa el backend fuera de los tests.

La columna que importa es la última: **qué pasa si falta**. Casi todas las
instalaciones que salen mal, salen mal por una variable que nadie cargó y cuyo
efecto no se nota hasta días después.

---

## Obligatorias — sin esto no arranca o no sirve

| Variable | Qué es | Si falta |
|---|---|---|
| `MYSQL_ADDON_HOST` | Host de la base | No conecta a nada |
| `MYSQL_ADDON_PORT` | Puerto (3306) | Asume 3306 |
| `MYSQL_ADDON_USER` | Usuario de la base | No conecta |
| `MYSQL_ADDON_PASSWORD` | Password | No conecta |
| `MYSQL_ADDON_DB` | Nombre de la base | No conecta |
| `FIREBASE_SERVICE_ACCOUNT` | El JSON entero de la cuenta de servicio, en una línea | **Con `NODE_ENV=production`, el servidor responde 503 a todo.** Es a propósito: ver F-01 en la auditoría |
| `CORS_ORIGINS` | Lista separada por comas de los orígenes permitidos | Cae a unos valores de localhost, y **el frontend no puede hablarle al backend** |
| `NODE_ENV` | `production` en los servidores reales | Sin esto, la autenticación no falla cerrada cuando debería |

### Sobre `CORS_ORIGINS`

Es la que más se olvida al mover algo de lugar. Tiene que incluir **todos** los
lugares desde donde se abre una página que llame al backend:

```
https://horasdedicacionavp.web.app,https://landing-horas-dedica.pages.dev
```

Cuando falta el origen correcto, el navegador no dice "CORS": dice algo como
"no se pudo conectar con el servidor". Es de los errores más difíciles de
diagnosticar si no sabés que acabás de mover el front.

### Sobre `FIREBASE_SERVICE_ACCOUNT`

Es el JSON completo que descarga Firebase, pegado como una sola línea. Alternativa:
`FIREBASE_SERVICE_ACCOUNT_PATH` con la ruta a un archivo, que sirve en local pero
no en Render (no hay dónde dejar el archivo).

⚠️ **Firebase son DOS proyectos distintos** (auth y hosting). Ver el aviso en
`REPLICAR_INSTALACION.md`: es la trampa que más tiempo hace perder al replicar.

---

## Por función — el sistema arranca sin ellas, pero esa parte no anda

| Variable | Qué habilita | Si falta |
|---|---|---|
| `TURNSTILE_SECRET_KEY` | El captcha del alta autoservicio | `/api/public/signup` responde 503 |
| `ANTHROPIC_API_KEY` | El chat de ventas | `/api/public/chat` responde 503 |
| `MERCADOPAGO_ACCESS_TOKEN` | Cobros y links de pago | No se pueden generar links ni sincronizar |
| `MERCADOPAGO_WEBHOOK_SECRET` | Validar la firma del webhook | No se puede verificar que el aviso venga de MercadoPago |
| `FRONTEND_URL` | A dónde vuelve el cliente después de pagar | El retorno de MercadoPago queda mal |
| `TELEGRAM_BOT_TOKEN` | Avisos de pedidos y pagos | **Falla en silencio**: nadie recibe nada y nada se rompe. El panel de Facturación avisa que falta |

---

## Opcionales

| Variable | Qué hace | Por defecto |
|---|---|---|
| `MYSQL_SSL` | `require` o `no-verify` para cifrar la conexión a la base | Sin definir = **sin cifrar**, y avisa por consola. En Clever Cloud va `no-verify` (certificado autofirmado, verificado el 2026-09-25) |
| `API_KEY` | Filtro anti-escaneo | Sin definir, deja pasar. **No es seguridad**: viaja en el bundle de Angular y está en el repo público |
| `SENTRY_DSN` | Reporte de errores | Sin definir, el monitoreo queda apagado |
| `SENTRY_ENVIRONMENT` | Etiqueta del entorno en Sentry | — |
| `PORT` | Puerto del servidor | Render lo define solo |
| `RENDER_GIT_COMMIT` | Lo pone Render solo. Es lo que expone `/health` como `version` | `desconocida` |
| `GIT_COMMIT` | Alternativa manual a la anterior, para otros hostings | — |

---

## Al montar un servidor nuevo

1. Cargá primero las **obligatorias**. Sin esas ocho, no tiene sentido seguir.
2. Verificá que arrancó y con qué versión:
   ```
   curl https://<tu-backend>/health
   ```
   Tiene que responder `{"ok":true,...,"version":"<commit>"}`.
3. Probá que la autenticación esté viva:
   ```
   curl -o /dev/null -w "%{http_code}" https://<tu-backend>/api/billing/plans
   ```
   - **401** → bien: pide credenciales.
   - **503** → Firebase no inicializó. Revisá `FIREBASE_SERVICE_ACCOUNT`.
   - **200** → algo está muy mal: está respondiendo sin autenticar.
4. Recién ahí cargá las de función, y probá cada una por su lado.

El paso 3 es el que conviene no saltear: distingue "arrancó" de "arrancó y está
protegido", que no son lo mismo.

---

## Frontend (Angular)

No usa variables de entorno: los valores están en
`src/environments/environment.ts` y se compilan adentro del bundle.

```ts
backendUrl: 'https://academypruebadep.onrender.com'
apiKey: '...'          // pública, viaja al navegador
firebaseConfig: { ... } // pública por diseño de Firebase
```

Cambiar cualquiera de estas exige **recompilar y redesplegar**, no alcanza con
tocar una configuración.

---

## Landing

Vive en su propio repositorio (`landing-horas-dedica`). Tampoco usa variables:
`BACKEND_URL` y `API_KEY` están al principio del `<script>` en `index.html`.
