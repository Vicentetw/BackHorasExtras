#!/usr/bin/env node
/**
 * Migración: Agregar columna exclude_from_report a la tabla employees
 * Ejecutar con: node migrate-exclude-column.js
 */

// BLOQUEADO el 2026-09-21. Ver scripts/guardia-obsoleto.js.
//
// Doblemente obsoleto:
//   1. la columna `employees.exclude_from_report` YA EXISTE (verificado en
//      produccion), asi que no hay nada que migrar;
//   2. ni siquiera arranca: el `require` de abajo apunta a
//      '../backendonline2/db', que era la estructura del monorepo viejo
//      (horas-dedica-completo). En este repo el backend esta en la raiz, asi
//      que esa ruta no existe y el script explota antes de hacer nada.
//
// Se deja por historial. Las migraciones de verdad viven en migrations/ y se
// corren desde Actions o con run-sql.js, con guardas de information_schema
// que las hacen repetibles sin romper nada.
require('./scripts/guardia-obsoleto').bloquearSiEsObsoleto({
  nombre: 'migrate-exclude-column.js',
  motivo: 'La columna exclude_from_report ya existe, y el require apunta a una ruta ' +
          'del monorepo viejo que en este repo no existe: no puede funcionar.',
  reemplazo: 'las migraciones de migrations/, via Actions o run-sql.js'
});

const db = require('../backendonline2/db');

async function migrate() {
  try {
    console.log('🔄 Ejecutando migración: agregar columna exclude_from_report...');

    // Verificar si la columna ya existe
    const [columns] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_NAME = 'employees' AND COLUMN_NAME = 'exclude_from_report'`
    );

    if (columns.length > 0) {
      console.log('✅ La columna exclude_from_report ya existe. Nada que hacer.');
      process.exit(0);
    }

    // Agregar la columna
    await db.query(
      `ALTER TABLE employees ADD COLUMN exclude_from_report TINYINT(1) NOT NULL DEFAULT 0`
    );

    console.log('✅ Columna exclude_from_report agregada exitosamente.');
    console.log('📋 Cambios aplicados:');
    console.log('   - ALTER TABLE employees ADD COLUMN exclude_from_report TINYINT(1) NOT NULL DEFAULT 0');
    console.log('');
    console.log('✨ La migración está completa. El backend ya puede usar esta columna.');
    
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('❌ Error en la migración:', err.message);
    console.error('');
    
    if (err.code === 'ECONNREFUSED') {
      console.error('🔌 PROBLEMA: No se pudo conectar a la base de datos');
      console.error('');
      console.error('SOLUCIONES:');
      console.error('1. Asegúrate de que MySQL/MariaDB está ejecutándose');
      console.error('2. Verifica que las credenciales en db.js son correctas');
      console.error('3. Verifica que la base de datos existe');
      console.error('');
      console.error('ALTERNATIVA: Ejecuta la SQL manualmente:');
      console.error('   ALTER TABLE employees ADD COLUMN exclude_from_report TINYINT(1) NOT NULL DEFAULT 0;');
      console.error('');
      console.error('Ver MIGRATION_GUIDE.md para más detalles.');
    } else if (err.code === 'ER_DUP_FIELDNAME') {
      console.error('ℹ️ La columna exclude_from_report ya existe en la tabla.');
    } else {
      console.error('SQL:', err.sql);
      console.error('Message:', err.sqlMessage);
    }
    
    process.exit(1);
  }
}

migrate();
