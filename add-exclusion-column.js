require('dotenv').config();
const mysql = require('mysql2/promise');

async function addExclusionColumn() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.MYSQL_ADDON_HOST,
      user: process.env.MYSQL_ADDON_USER,
      password: process.env.MYSQL_ADDON_PASSWORD,
      database: process.env.MYSQL_ADDON_DB,
      port: process.env.MYSQL_ADDON_PORT || 3306,
      dateStrings: true
    });

    console.log('✓ Conectado a la base de datos\n');

    // Check if column already exists
    console.log('[PASO 1] Verificando si la columna isExcluded existe...');
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'users' 
      AND COLUMN_NAME = 'isExcluded'
      AND TABLE_SCHEMA = DATABASE()
    `);

    if (columns.length > 0) {
      console.log('  ℹ La columna isExcluded ya existe\n');
    } else {
      console.log('  → Agregando columna isExcluded...');
      await connection.query(`
        ALTER TABLE users 
        ADD COLUMN isExcluded BOOLEAN DEFAULT FALSE AFTER USERID
      `);
      console.log('  ✓ Columna isExcluded agregada\n');
    }

    // Show updated users table structure
    console.log('[PASO 2] Estructura de tabla users:');
    const [structure] = await connection.query(`
      DESCRIBE users
    `);
    
    console.log('  Primeros 5 campos:');
    structure.slice(0, 5).forEach(row => {
      console.log(`    - ${row.Field}: ${row.Type}${row.Null === 'NO' ? ' (NOT NULL)' : ''}${row.Default ? ' DEFAULT ' + row.Default : ''}`);
    });

    // Count total users
    console.log('\n[PASO 3] Estadísticas:');
    const [[{ total }]] = await connection.query(`SELECT COUNT(*) as total FROM users`);
    const [[{ excluded }]] = await connection.query(`SELECT COUNT(*) as excluded FROM users WHERE isExcluded = TRUE`);
    
    console.log(`  → Total usuarios: ${total}`);
    console.log(`  → Usuarios excluidos: ${excluded}`);

    console.log('\n========================================');
    console.log('✓ MIGRACIÓN COMPLETADA CON ÉXITO');
    console.log('========================================\n');

  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

addExclusionColumn();
