// Corre uno o varios archivos de migracion (separados por coma o salto de
// linea) contra la base de produccion -- pensado para dispararse a mano
// desde la pestaña Actions de GitHub (workflow_dispatch). Nunca corre
// solo -- ver .github/workflows/run-migration.yml.
//
// Version adaptada de horas-dedica-completo/migration-runner/run-migration.js
// a la estructura PLANA de este repo (migrations/ en la raiz, sin la
// carpeta backendonline2/ del monorepo de desarrollo).
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const raw = process.argv[2] || '';
  const files = raw
    .split(/[\n,]/)
    .map((f) => f.trim())
    .filter(Boolean);

  if (files.length === 0) {
    console.error('No se paso ningun archivo de migracion.');
    process.exit(1);
  }

  // Defensa extra: solo archivos .sql dentro de migrations/, sin ../ --
  // aunque disparar este workflow ya requiere permiso de escritura sobre
  // el repo, no hay motivo para permitir apuntar a cualquier ruta.
  const ALLOWED_PREFIX = 'migrations' + path.sep;
  for (const file of files) {
    const normalized = path.normalize(file);
    if (!normalized.startsWith(ALLOWED_PREFIX) || !normalized.endsWith('.sql') || normalized.includes('..')) {
      console.error(`Archivo no permitido: ${file} (debe ser migrations/algo.sql)`);
      process.exit(1);
    }
    if (!fs.existsSync(normalized)) {
      console.error(`No existe: ${normalized}`);
      process.exit(1);
    }
  }

  // Chequeo de credenciales ANTES de intentar conectar.
  //
  // Sin esto, cuando los secrets del repo no estan cargados, mysql2 recibe
  // host/user/password en `undefined`, asume localhost, y se estrella
  // contra un contenedor de GitHub donde no hay ninguna base escuchando.
  // El error que tira Node en ese caso llega con `.message` vacio, asi que
  // el workflow terminaba mostrando literalmente "ERROR:" y nada mas --
  // imposible de diagnosticar. Paso de verdad el 2026-09-19.
  //
  // (El script equivalente para correr a mano, run-sql.js en la raiz, ya
  // tenia esta validacion desde siempre; este runner se habia quedado sin
  // ella.)
  const requiredEnv = ['MYSQL_ADDON_HOST', 'MYSQL_ADDON_USER', 'MYSQL_ADDON_PASSWORD', 'MYSQL_ADDON_DB'];
  const missingEnv = requiredEnv.filter((k) => !process.env[k]);
  if (missingEnv.length) {
    console.error('');
    console.error('No hay credenciales de base de datos: ' + missingEnv.join(', ') + ' llegaron vacias.');
    console.error('');
    console.error('Casi seguro faltan los secrets de ESTE repositorio. Se cargan en:');
    console.error('  Settings > Secrets and variables > Actions > New repository secret');
    console.error('Hacen falta los cinco: MYSQL_ADDON_HOST, MYSQL_ADDON_USER,');
    console.error('MYSQL_ADDON_PASSWORD, MYSQL_ADDON_DB, MYSQL_ADDON_PORT.');
    console.error('');
    console.error('Los valores son los mismos que ya tiene configurados el servicio');
    console.error('de backend en Render (Environment), o se sacan del panel de Clever Cloud.');
    console.error('Ojo: cada repositorio tiene su propio almacen de secrets -- apuntar a');
    console.error('la misma base no los comparte automaticamente.');
    process.exit(1);
  }

  const db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    multipleStatements: true,
  });

  try {
    for (const file of files) {
      const sql = fs.readFileSync(file, 'utf8');
      console.log(`\n=== Aplicando ${file} ===`);
      const [results] = await db.query(sql);
      const rows = Array.isArray(results) ? results : [results];
      rows.forEach((r) => {
        if (Array.isArray(r)) r.forEach((row) => console.log(JSON.stringify(row)));
      });
      console.log(`OK: ${file}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  // `err.message` puede venir vacio (por ejemplo, los AggregateError que tira
  // Node cuando falla la conexion probando IPv6 e IPv4 a la vez). En ese caso
  // se imprime el error completo, porque un "ERROR:" pelado no sirve para
  // diagnosticar nada.
  console.error('ERROR:', err && err.message ? err.message : err);
  if (err && Array.isArray(err.errors)) {
    err.errors.forEach((e) => console.error('  causa:', e && e.message ? e.message : e));
  }
  process.exit(1);
});
