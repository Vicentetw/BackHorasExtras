const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function runMigration() {
  const db = mysql.createPool({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    waitForConnections: true,
    dateStrings: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  const schemaPath = path.join(__dirname, 'schemas', 'initial_schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    console.log('Iniciando migración del Motor Laboral...');
    const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);

    for (const statement of statements) {
      await db.query(statement);
    }

    console.log('Migración completada correctamente.');
  } catch (err) {
    console.error('Error ejecutando la migración del Motor Laboral:', err);
    process.exit(1);
  } finally {
    await db.end();
  }
}

runMigration();
