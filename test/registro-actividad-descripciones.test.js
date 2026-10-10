// Registro de actividad: TODA ruta que cambia algo tiene que quedar descrita
// en palabras ("Cargó una justificación"), no con la ruta técnica
// ("Creó/cargó /api/event-types", que fue lo que apareció en producción el
// 2026-10-09). Recorre el código buscando las rutas POST/PUT/PATCH/DELETE,
// así una ruta nueva sin nombre hace fallar este test.
// No necesita el backend ni la base: solo lee archivos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { describir } = require('../registroActividad');

const RAIZ = path.join(__dirname, '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');

function rutasQueCambian() {
  const rutas = new Set();
  const principal = leer('horasdedica.js');
  for (const m of principal.matchAll(/app\.(post|put|patch|delete)\('([^']+)'/g)) rutas.add(`${m[1].toUpperCase()} ${m[2]}`);

  // Routers montados con app.use('/prefijo', ...): se busca su archivo.
  const archivoDe = (ref) => {
    if (ref.startsWith('./')) return `${ref.slice(2)}.js`;
    const m = principal.match(new RegExp(`const ${ref}\\s*=\\s*require\\('\\./([^']+)'\\)`));
    return m ? `${m[1]}.js` : null;
  };
  for (const m of principal.matchAll(/app\.use\('([^']+)',\s*(?:\w+,\s*)?(?:require\('([^']+)'\)|(\w+))/g)) {
    const prefijo = m[1];
    if (prefijo === '/api/labor-engine') {
      for (const [archivo, sub] of [['motor-laboral/routes/admin.js', '/admin'], ['motor-laboral/routes/attendance.js', '']]) {
        for (const r of leer(archivo).matchAll(/router\.(post|put|patch|delete)\('([^']+)'/g)) rutas.add(`${r[1].toUpperCase()} ${prefijo}${sub}${r[2]}`);
      }
      continue;
    }
    const archivo = archivoDe(m[2] || m[3]);
    if (!archivo || !fs.existsSync(path.join(RAIZ, archivo))) continue;
    for (const r of leer(archivo).matchAll(/router\.(post|put|patch|delete)\('([^']+)'/g)) {
      rutas.add(`${r[1].toUpperCase()} ${prefijo}${r[2] === '/' ? '' : r[2]}`);
    }
  }
  return [...rutas];
}

test('se encuentran las rutas que cambian algo (si da pocas, el recorrido se rompió)', () => {
  assert.ok(rutasQueCambian().length > 100);
});

test('ninguna ruta queda descrita con la ruta técnica', () => {
  const sinNombre = rutasQueCambian()
    // /webhooks y /api/public no tienen usuario logueado: no se registran.
    .filter((r) => !/ \/(webhooks|api\/public|api\/agent\/)/.test(r))
    .map((r) => {
      const [metodo, ruta] = r.split(' ');
      return [r, describir(metodo, ruta.replace(/:\w+/g, '1'))];
    })
    .filter(([, d]) => /(^|\s)\/[a-z]/i.test(d));
  assert.deepEqual(sinNombre, [], `Rutas sin descripción en registroActividad.js (agregalas a QUE_ES o ACCIONES):\n${sinNombre.map(([r, d]) => `  ${r} -> ${d}`).join('\n')}`);
});

test('las justificaciones se llaman justificaciones (no "exclusión")', () => {
  assert.equal(describir('POST', '/config/user-exclusions'), 'Cargó una justificación');
  assert.equal(describir('DELETE', '/config/user-exclusions/5'), 'Borró una justificación');
  assert.equal(describir('POST', '/api/event-types'), 'Creó/cargó un motivo de ausencia');
});
