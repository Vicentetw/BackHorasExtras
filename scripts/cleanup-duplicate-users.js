// Herramienta de mantenimiento MANUAL para limpiar usuarios duplicados en
// `users` (mismo Badgenumber repetido en más de una fila, típicamente por
// una importación vieja sin TRIM). Antes vivía como un endpoint HTTP GET
// (`/api/users/cleanup-duplicates`) sin ningún guard de permisos ni filtro
// de tenant -- cualquier app_user logueado, de cualquier empresa, podía
// disparar un borrado GLOBAL de datos de TODAS las empresas con un simple
// GET. Se retira de la app viva (Fase 8, seguridad/multi-tenant) y queda
// acá como script de un solo uso, para correr a mano cuando de verdad hace
// falta.
//
// USO: node scripts/cleanup-duplicate-users.js
// (parado en backendonline2/, con las mismas variables de entorno que usa
// el backend -- lee .env igual que horasdedica2.js)
require('dotenv').config();
const db = require('../db');

async function main() {
  console.log('[CLEANUP] Iniciando limpieza de usuarios duplicados...');

  const [duplicates] = await db.query(`
    SELECT TRIM(Badgenumber) as badge, COUNT(*) as count, GROUP_CONCAT(USERID) as userids
    FROM users
    GROUP BY TRIM(Badgenumber)
    HAVING count > 1
    ORDER BY count DESC
  `);

  console.log(`[CLEANUP] Encontrados ${duplicates.length} badges con duplicados`);

  let totalDeleted = 0;
  let totalMapsDeleted = 0;
  let totalExclusionsDeleted = 0;

  for (const dup of duplicates) {
    const userids = dup.userids.split(',').map(Number);
    const keepUID = userids[0];
    const deleteUIDs = userids.slice(1);

    console.log(`[CLEANUP] Badge: ${dup.badge} | Mantener: ${keepUID} | Eliminar: ${deleteUIDs.join(',')}`);

    for (const uid of deleteUIDs) {
      // Eliminar todas las referencias primero (ordenar por dependencias FK)
      const [deletedSpecial] = await db.query('DELETE FROM specialusers WHERE userId = ?', [uid]);
      console.log(`[CLEANUP]   → Eliminados ${deletedSpecial.affectedRows} registros de specialusers`);

      const [deletedExcl] = await db.query('DELETE FROM userexclusions WHERE userId = ?', [uid]);
      totalExclusionsDeleted += deletedExcl.affectedRows;

      const [deletedAttend] = await db.query('DELETE FROM dailyattendance WHERE userId = ?', [uid]);
      console.log(`[CLEANUP]   → Eliminados ${deletedAttend.affectedRows} registros de attendance`);

      const [deletedAssign] = await db.query('DELETE FROM dayassignments WHERE userId = ?', [uid]);
      console.log(`[CLEANUP]   → Eliminados ${deletedAssign.affectedRows} registros de assignments`);

      const [deletedMaps] = await db.query('DELETE FROM user_employee_map WHERE USERID = ?', [uid]);
      totalMapsDeleted += deletedMaps.affectedRows;

      const [deleted] = await db.query('DELETE FROM users WHERE USERID = ?', [uid]);
      totalDeleted += deleted.affectedRows;
    }
  }

  await db.query('UPDATE users SET Badgenumber = TRIM(Badgenumber)');

  let constraintAdded = false;
  try {
    await db.query(`ALTER TABLE users ADD UNIQUE KEY unique_badgenumber (Badgenumber)`);
    constraintAdded = true;
    console.log('[CLEANUP] UNIQUE constraint agregado');
  } catch (err) {
    console.log('[CLEANUP] UNIQUE constraint ya existe o error:', err.code);
  }

  const [[{ totalUsers }]] = await db.query('SELECT COUNT(DISTINCT USERID) as totalUsers FROM users WHERE USERID > 10');
  const [[{ totalBadges }]] = await db.query('SELECT COUNT(DISTINCT TRIM(Badgenumber)) as totalBadges FROM users WHERE USERID > 10');

  console.log('[CLEANUP] Limpieza completada', {
    duplicatesFound: duplicates.length,
    usersDeleted: totalDeleted,
    mapsDeleted: totalMapsDeleted,
    exclusionsDeleted: totalExclusionsDeleted,
    constraintAdded,
    finalStats: { totalUsers, uniqueBadges: totalBadges }
  });

  await db.end();
}

main().catch((err) => {
  console.error('[CLEANUP ERROR]:', err);
  process.exit(1);
});
