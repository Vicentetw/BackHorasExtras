/**
 * SCRIPT PARA LIMPIAR USUARIOS DUPLICADOS Y AGREGAR CONSTRAINT
 * Ejecutar: node fix-duplicate-users.js
 * 
 * Problema: Al importar usuarios múltiples veces, se crean duplicados
 * porque el ON DUPLICATE KEY UPDATE usa USERID como clave, no Badgenumber
 * 
 * Solución:
 * 1. Eliminar duplicados (guardar solo el primer USERID)
 * 2. Agregar UNIQUE constraint en Badgenumber
 */

const mysql = require('mysql2/promise');

async function fixDuplicateUsers() {
  try {
    console.log('🔧 Iniciando limpieza de usuarios duplicados...\n');

    const connection = await mysql.createConnection({
      host: process.env.MYSQL_ADDON_HOST || 'localhost',
      user: process.env.MYSQL_ADDON_USER || 'root',
      password: process.env.MYSQL_ADDON_PASSWORD || 'root',
      database: process.env.MYSQL_ADDON_DB || 'postgres',
      port: process.env.MYSQL_ADDON_PORT || 3306
    });

    // 1. Encontrar usuarios duplicados
    console.log('📊 Buscando usuarios duplicados por Badgenumber...');
    const [duplicates] = await connection.query(`
      SELECT Badgenumber, COUNT(*) as count, GROUP_CONCAT(USERID) as userids
      FROM users
      GROUP BY TRIM(Badgenumber)
      HAVING count > 1
      ORDER BY count DESC
    `);

    if (duplicates.length === 0) {
      console.log('✅ No hay duplicados encontrados.');
    } else {
      console.log(`\n⚠️ Encontrados ${duplicates.length} badges con duplicados:\n`);
      
      for (const dup of duplicates) {
        const userids = dup.userids.split(',');
        const keepUID = userids[0]; // Guardar el primero
        const deleteUIDs = userids.slice(1);
        
        console.log(`   Badge: ${dup.Badgenumber}`);
        console.log(`     Total registros: ${dup.count}`);
        console.log(`     Mantener USERID: ${keepUID}`);
        console.log(`     Eliminar USERIDs: ${deleteUIDs.join(', ')}`);

        // 2. Eliminar duplicados (guardar el primero, eliminar resto)
        for (const uid of deleteUIDs) {
          // Primero, eliminar referencias en user_employee_map
          const [deletedMaps] = await connection.query(
            'DELETE FROM user_employee_map WHERE USERID = ?',
            [uid]
          );
          console.log(`      → Eliminadas ${deletedMaps.affectedRows} mappings para USERID ${uid}`);

          // Luego eliminar el usuario duplicado
          const [deleted] = await connection.query(
            'DELETE FROM users WHERE USERID = ?',
            [uid]
          );
          console.log(`      → Eliminado usuario USERID ${uid}`);
        }
      }
    }

    // 3. Verificar integridad de datos
    console.log('\n📈 Verificando integridad...');
    const [[userCount]] = await connection.query(
      'SELECT COUNT(DISTINCT USERID) as count FROM users WHERE USERID > 10'
    );
    const [[badgeCount]] = await connection.query(
      'SELECT COUNT(DISTINCT Badgenumber) as count FROM users WHERE USERID > 10'
    );

    console.log(`   Total usuarios: ${userCount.count}`);
    console.log(`   Total badges únicos: ${badgeCount.count}`);

    // 4. Agregar UNIQUE constraint en Badgenumber si no existe
    console.log('\n🔐 Agregando constraint UNIQUE en Badgenumber...');
    try {
      // Primero hacer TRIM en la columna para eliminar espacios
      await connection.query(`
        UPDATE users SET Badgenumber = TRIM(Badgenumber)
      `);
      console.log('   ✓ Espacios en blanco eliminados');

      // Intentar crear el índice único
      await connection.query(`
        ALTER TABLE users ADD UNIQUE KEY unique_badgenumber (Badgenumber)
      `);
      console.log('   ✓ UNIQUE constraint agregado en Badgenumber');
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log('   ℹ️ UNIQUE constraint ya existe');
      } else if (err.code === 'ER_DUP_ENTRY') {
        console.log('   ⚠️ Aún hay duplicados sin resolver: ', err.message);
      } else {
        console.log(`   ⚠️ Error: ${err.message}`);
      }
    }

    // 5. Resumen final
    console.log('\n✅ Limpieza completada.');
    console.log('\n📝 Próximos pasos:');
    console.log('   1. Reinicia el servidor backend: taskkill /F /IM node.exe');
    console.log('   2. cd backendonline2 && node horasdedica2.js');
    console.log('   3. Intenta nuevamente el Auto-Matching');

    await connection.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
    process.exit(1);
  }
}

fixDuplicateUsers();
