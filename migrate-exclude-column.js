#!/usr/bin/env node
/**
 * Migración: Agregar columna exclude_from_report a la tabla employees
 * Ejecutar con: node migrate-exclude-column.js
 */

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
