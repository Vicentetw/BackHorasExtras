// BLOQUEADO el 2026-09-21. Ver scripts/guardia-obsoleto.js.
//
// Script de un solo uso, de cuando `userexclusions` tenia filas repetidas.
// Su trabajo ya esta hecho: la clave unica que agregaba existe desde la
// migracion 20260909, ahora por empresa (uq_userexclusions_tenant).
//
// Por que no conviene dejarlo suelto:
//   * BORRA justificaciones y licencias cargadas a mano, quedandose "con la
//     mas reciente". Eso no se puede deshacer: son datos que alguien cargo
//     y que no estan en ningun otro lado;
//   * no filtra por empresa, asi que tocaria las de todos los clientes;
//   * inserta un registro de PRUEBA en la base de produccion para verificar
//     la constraint, y despues lo borra. Si falla en el medio, queda.
require('dotenv').config();
require('./scripts/guardia-obsoleto').bloquearSiEsObsoleto({
  nombre: 'fix-userexclusions.js',
  motivo: 'Borra justificaciones y licencias sin filtrar por empresa, e inserta un ' +
          'registro de prueba en produccion. Su trabajo ya lo hizo la migracion 20260909.',
  reemplazo: 'nada: no hace falta. Si aparecieran duplicados nuevos, mirarlos primero ' +
             'con un SELECT antes de borrar nada.'
});

const mysql = require('mysql2/promise');

async function fixUserExclusions() {
  let connection;
  try {
    // Create connection
    connection = await mysql.createConnection({
      host: process.env.MYSQL_ADDON_HOST,
      user: process.env.MYSQL_ADDON_USER,
      password: process.env.MYSQL_ADDON_PASSWORD,
      database: process.env.MYSQL_ADDON_DB,
      port: process.env.MYSQL_ADDON_PORT || 3306,
      dateStrings: true
    });

    console.log('✓ Conectado a la base de datos');

    // Step 1: Count duplicates before fix
    console.log('\n[PASO 1] Contando duplicados...');
    const [dupCheck] = await connection.query(`
      SELECT userId, excDate, COUNT(*) as cnt
      FROM userexclusions
      GROUP BY userId, excDate
      HAVING cnt > 1
    `);
    
    console.log(`  → Encontrados ${dupCheck.length} (userId, excDate) duplicados`);
    if (dupCheck.length > 0) {
      console.log('  Ejemplos:', dupCheck.slice(0, 3));
    }

    // Step 2: Show total records before
    const [[{ totalBefore }]] = await connection.query(
      'SELECT COUNT(*) as totalBefore FROM userexclusions'
    );
    console.log(`  → Total registros antes: ${totalBefore}`);

    // Step 3: Delete duplicates (keep the most recent one)
    console.log('\n[PASO 2] Eliminando duplicados (conservando el más reciente)...');
    await connection.query(`
      DELETE FROM userexclusions
      WHERE id NOT IN (
        SELECT MAX(id) 
        FROM (
          SELECT MAX(id) as id 
          FROM userexclusions 
          GROUP BY userId, excDate
        ) t
      )
    `);
    console.log('  ✓ Duplicados eliminados');

    // Step 4: Show total records after
    const [[{ totalAfter }]] = await connection.query(
      'SELECT COUNT(*) as totalAfter FROM userexclusions'
    );
    console.log(`  → Total registros después: ${totalAfter}`);
    console.log(`  → Registros eliminados: ${totalBefore - totalAfter}`);

    // Step 5: Add UNIQUE constraint
    console.log('\n[PASO 3] Agregando restricción UNIQUE...');
    
    // Check if constraint already exists
    const [existingConstraints] = await connection.query(`
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_NAME = 'userexclusions' 
      AND TABLE_SCHEMA = DATABASE()
      AND COLUMN_NAME IN ('userId', 'excDate')
      AND CONSTRAINT_NAME = 'unique_exclusion'
    `);

    if (existingConstraints.length > 0) {
      console.log('  ℹ La restricción UNIQUE ya existe');
    } else {
      // Try to add the constraint
      try {
        await connection.query(`
          ALTER TABLE userexclusions 
          ADD CONSTRAINT unique_exclusion UNIQUE (userId, excDate)
        `);
        console.log('  ✓ Restricción UNIQUE agregada a (userId, excDate)');
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY' || err.code === 'ER_DUP_KEYNAME') {
          console.log('  ℹ La restricción ya existe o hay conflicto. Continuando...');
        } else {
          throw err;
        }
      }
    }

    // Step 6: Test the constraint
    console.log('\n[PASO 4] Probando la restricción...');
    try {
      const testDate = new Date().toISOString().split('T')[0];
      const testUserId = 1;
      
      // Insert a test record
      await connection.query(
        'INSERT INTO userexclusions (userId, excDate, reason, type) VALUES (?, ?, ?, ?)',
        [testUserId, testDate, 'Test', 'test']
      );
      console.log('  ✓ Registro de prueba insertado');

      // Try to insert duplicate (should fail)
      try {
        await connection.query(
          'INSERT INTO userexclusions (userId, excDate, reason, type) VALUES (?, ?, ?, ?)',
          [testUserId, testDate, 'Test 2', 'test']
        );
        console.log('  ✗ ERROR: Se permitió insertar duplicado (constraint no funciona)');
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          console.log('  ✓ La restricción UNIQUE está funcionando correctamente');
          console.log(`    Error esperado: ${err.message}`);
        } else {
          throw err;
        }
      }

      // Delete test record
      await connection.query(
        'DELETE FROM userexclusions WHERE userId = ? AND excDate = ?',
        [testUserId, testDate]
      );
      console.log('  ✓ Registro de prueba limpiado');
    } catch (err) {
      console.error('  ✗ Error durante la prueba:', err.message);
    }

    console.log('\n========================================');
    console.log('✓ CORRECCIÓN COMPLETADA CON ÉXITO');
    console.log('========================================\n');

  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

// Run the fix
fixUserExclusions();
