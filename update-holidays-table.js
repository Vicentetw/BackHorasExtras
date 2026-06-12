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
    console.log('🔄 Verificando estructura actual de holidays...');
    
    const [cols] = await db.query('DESCRIBE holidays');
    console.log('Columnas actuales:', cols.map(c => c.Field).join(', '));

    // Verificar si ya tiene las columnas nuevas
    const hasName = cols.some(c => c.Field === 'name');
    const hasType = cols.some(c => c.Field === 'type');
    
    if (hasName && hasType) {
      console.log('✅ La tabla ya tiene las columnas necesarias');
    } else {
      console.log('🔄 Agregando nuevas columnas...');
      
      // Agregar columnas si no existen
      if (!hasName) {
        await db.query(`ALTER TABLE holidays ADD COLUMN name VARCHAR(255) AFTER date`);
        console.log('  ✓ Columna name agregada');
      }
      if (!cols.some(c => c.Field === 'year')) {
        await db.query(`ALTER TABLE holidays ADD COLUMN year YEAR AFTER date`);
        console.log('  ✓ Columna year agregada');
      }
      if (!hasType) {
        await db.query(`ALTER TABLE holidays ADD COLUMN type ENUM('NATIONAL', 'PROVINCIAL', 'LOCAL', 'EXCEPTIONAL', 'OPTIONAL') DEFAULT 'NATIONAL'`);
        console.log('  ✓ Columna type agregada');
      }
      if (!cols.some(c => c.Field === 'reason')) {
        await db.query(`ALTER TABLE holidays ADD COLUMN reason TEXT`);
        console.log('  ✓ Columna reason agregada');
      }
      if (!cols.some(c => c.Field === 'isWorkDay')) {
        await db.query(`ALTER TABLE holidays ADD COLUMN isWorkDay BOOLEAN DEFAULT FALSE`);
        console.log('  ✓ Columna isWorkDay agregada');
      }
      if (!cols.some(c => c.Field === 'recurring')) {
        await db.query(`ALTER TABLE holidays ADD COLUMN recurring BOOLEAN DEFAULT FALSE`);
        console.log('  ✓ Columna recurring agregada');
      }
    }

    // Migrar datos existentes
    console.log('\n🔄 Migrando datos existentes...');
    const [result] = await db.query(`
      UPDATE holidays SET 
        name = description,
        type = 'NATIONAL',
        isWorkDay = FALSE,
        recurring = TRUE,
        year = YEAR(date)
      WHERE name IS NULL OR name = ''
    `);
    console.log(`  ✓ ${result.affectedRows} registros actualizados`);

    // Verificar resultado
    console.log('\n📋 Estructura final:');
    const [finalCols] = await db.query('DESCRIBE holidays');
    finalCols.forEach(c => console.log(`  - ${c.Field}: ${c.Type}`));

    console.log('\n📋 Datos de ejemplo:');
    const [rows] = await db.query('SELECT id, date, name, type, isWorkDay, recurring, year FROM holidays LIMIT 5');
    console.table(rows);

    console.log('\n✅ Tabla holidays actualizada correctamente');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await db.end();
  }
}

main();