// ============================================================================
// Corre la suite y deja la base limpia, pasen o fallen los tests
// ============================================================================
//
// POR QUE NO ALCANZABA CON LOS HOOKS DE NPM
// -----------------------------------------
// La primera version de esto usaba `pretest` y `posttest`. Suena bien, pero
// npm corre `posttest` SOLO si los tests pasaron. Y el caso que hay que
// limpiar es justo el contrario: cuando algo falla a mitad de camino, los
// `after()` de los archivos siguientes no llegan a correr y quedan empresas
// de prueba colgadas. Verificado en vivo el 2026-09-22: con la suite en rojo,
// quedaron las 7 empresas de siempre en la base.
//
// Aca la limpieza va en un `finally` de verdad: corre antes, corre despues,
// y el codigo de salida que se devuelve sigue siendo el de los tests -- si
// la suite fallo, `npm test` falla, y el CI se entera igual que antes.
const { spawnSync } = require('child_process');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const LIMPIAR = path.join(__dirname, 'limpiar-datos-de-prueba.js');

function limpiar(momento) {
  const r = spawnSync(process.execPath, [LIMPIAR, '--aplicar'],
    { cwd: RAIZ, stdio: 'inherit' });
  if (r.status !== 0) {
    // No se aborta la corrida por esto: que la limpieza falle es un
    // problema, pero no una razon para no correr los tests. Se avisa fuerte.
    console.error(`\n[${momento}] La limpieza de datos de prueba no termino bien.\n`);
  }
}

limpiar('antes');

const tests = spawnSync(
  process.execPath,
  ['--test', '--test-force-exit', '--test-concurrency=1', ...process.argv.slice(2)],
  { cwd: RAIZ, stdio: 'inherit' }
);

limpiar('despues');

// El codigo de salida de los tests es el que vale.
process.exit(tests.status === null ? 1 : tests.status);
