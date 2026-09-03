#!/usr/bin/env node
/**
 * Corre un archivo .sql contra la base indicada por las variables de
 * entorno MYSQL_ADDON_* (las mismas 5 que usa db.js / que ya tiene
 * configuradas Render para el backend en produccion).
 *
 * No lee ningun .env -- las credenciales se pasan por variable de
 * entorno en la misma terminal, para no dejar nunca la contraseña de
 * produccion escrita en un archivo de este repo.
 *
 * Uso (Git Bash):
 *   export MYSQL_ADDON_HOST="<host>"
 *   export MYSQL_ADDON_PORT="<puerto>"
 *   export MYSQL_ADDON_USER="<usuario>"
 *   export MYSQL_ADDON_PASSWORD="<password>"
 *   export MYSQL_ADDON_DB="<nombre de la base>"
 *   node run-sql.js PRODUCTION_DB_CHECK.sql
 *   node run-sql.js migrations/20260902_add_roles.sql
 *
 * IMPORTANTE: nunca escribas los valores reales aca en el archivo --
 * solo en la terminal, con export. Este archivo se commitea a git.
 */
const fs = require('fs');
const mysql = require('mysql2/promise');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: node run-sql.js <archivo.sql>');
    process.exit(1);
  }
  const required = ['MYSQL_ADDON_HOST', 'MYSQL_ADDON_USER', 'MYSQL_ADDON_PASSWORD', 'MYSQL_ADDON_DB'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Faltan variables de entorno: ' + missing.join(', '));
    console.error('Setealas antes de correr este script (ver comentario al principio del archivo).');
    process.exit(1);
  }

  const sql = fs.readFileSync(file, 'utf8');
  console.log('Conectando a ' + process.env.MYSQL_ADDON_HOST + ' / db ' + process.env.MYSQL_ADDON_DB + ' ...');

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    multipleStatements: true,
    dateStrings: true
  });

  try {
    console.log('Corriendo ' + file + ' ...\n');
    const [results] = await conn.query(sql);
    const rowsSets = Array.isArray(results) && Array.isArray(results[0]) ? results : [results];

    for (const set of rowsSets) {
      if (Array.isArray(set) && set.length && set[0] && typeof set[0] === 'object' && 'chequeo' in set[0]) {
        // Salida linda para PRODUCTION_DB_CHECK.sql
        for (const row of set) {
          console.log((row.existe ? '[SI]' : '[NO]') + '  ' + row.chequeo);
        }
      } else if (Array.isArray(set)) {
        console.log('OK -- filas afectadas/leidas: ' + set.length);
      } else if (set && typeof set.affectedRows === 'number') {
        console.log('OK -- ' + set.affectedRows + ' fila(s) afectada(s).');
      }
    }
    console.log('\nListo, sin errores.');
  } catch (err) {
    console.error('\nERROR: ' + err.message);
    if (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_TABLE_EXISTS_ERROR' || err.code === 'ER_DUP_KEYNAME') {
      console.error('(Esto suele significar que esa parte de la migracion ya se habia corrido antes.');
      console.error(' Revisa PRODUCTION_DB_CHECK.sql y correlo de nuevo para confirmar que estado quedo.)');
    }
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
