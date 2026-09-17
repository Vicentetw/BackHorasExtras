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
  console.error('ERROR:', err.message);
  process.exit(1);
});
