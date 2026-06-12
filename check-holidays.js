require('dotenv').config();

const mysql = require('mysql2/promise');

async function main() {
  const db = mysql.createPool({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    waitForConnections: true,
    dateStrings: true,
    connectionLimit: 10
  });

  try {
    console.log('📋 Estructura de la tabla holidays:\n');
    const [cols] = await db.query('DESCRIBE holidays');
    console.table(cols);

    console.log('\n📋 Todos los registros:\n');
    const [rows] = await db.query('SELECT * FROM holidays ORDER BY date');
    console.table(rows);
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await db.end();
  }
}

main();