// ============================================================================
// Guardia para scripts de mantenimiento viejos
// ============================================================================
//
// En la raiz del repo quedaron scripts de un solo uso, escritos para
// resolver un problema puntual de hace meses. Su trabajo YA ESTA HECHO: las
// columnas que creaban existen, los duplicados que limpiaban se limpiaron.
//
// El problema es que siguen ahi, se corren con un `node archivo.js`, y
// escriben en la base con las credenciales del entorno. Si alguien los
// ejecuta por curiosidad o por error -- o por buscar "fix" en la carpeta --
// borran datos sin preguntar nada.
//
// Uno de ellos, `cleanup-duplicate-users.js`, ya causo un destrozo real:
// borro usuarios de reloj sin mover sus fichajes ni sus justificaciones.
// Ese se reescribio (ahora simula por defecto). Estos tres no valia la pena
// reescribirlos, porque no hacen falta; lo que hacia falta era que no se
// pudieran correr de casualidad.
//
// Esta guardia los hace fallar con una explicacion. Para correrlos igual hay
// que pasar --si-se-lo-que-hago, que es lo bastante incomodo como para que
// nadie lo escriba sin leer antes por que estaba bloqueado.

function bloquearSiEsObsoleto({ nombre, motivo, reemplazo }) {
  if (process.argv.includes('--si-se-lo-que-hago')) {
    console.warn(`⚠️  ${nombre}: bloqueo salteado a mano. Espero que sepas lo que estas haciendo.`);
    return;
  }
  console.error('');
  console.error('='.repeat(70));
  console.error(` BLOQUEADO: ${nombre}`);
  console.error('='.repeat(70));
  console.error('');
  console.error(` ${motivo}`);
  console.error('');
  if (reemplazo) {
    console.error(` En su lugar: ${reemplazo}`);
    console.error('');
  }
  console.error(' Este script escribe en la base con las credenciales del entorno y');
  console.error(' no pregunta nada antes de borrar. Si de verdad hace falta correrlo,');
  console.error(' leelo entero primero y agrega --si-se-lo-que-hago.');
  console.error('');
  console.error(' Antes de cualquiera de estas cosas: hace un backup.');
  console.error('   .\\scripts\\backup-produccion.ps1');
  console.error('='.repeat(70));
  process.exit(1);
}

module.exports = { bloquearSiEsObsoleto };
