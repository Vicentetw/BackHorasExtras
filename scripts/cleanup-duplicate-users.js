// ============================================================================
// Limpieza de usuarios de reloj duplicados (mismo legajo en varias filas).
// ============================================================================
//
// ESTE SCRIPT CAUSO UN DESTROZO. LEER ANTES DE CORRERLO.
//
// La version anterior, corrida en algun momento sobre la base de AVP:
//
//   1. elegia cual fila conservar con `GROUP_CONCAT(USERID)` y se quedaba con
//      `userids[0]` -- o sea, una CUALQUIERA. MySQL no garantiza ese orden, y
//      en la practica salia la del USERID mas bajo: justamente una fila vieja
//      importada de un CSV que nunca habia fichado, en vez de la del reloj;
//   2. BORRABA las demas sin mover sus `Checkins`, dejando ~81.000 fichajes
//      apuntando a un USERID que ya no existia;
//   3. BORRABA sus `userexclusions` -- o sea, justificaciones y licencias
//      cargadas a mano, destruidas sin dejar rastro;
//   4. agregaba una UNIQUE KEY global sobre `Badgenumber`, que impedia que el
//      agente volviera a crear la fila borrada. El daño quedaba cerrado.
//
// (Los fichajes seguian llegando a los informes de milagro, por el
// `OR u.Badgenumber = c.USERID` de horasdedica.js:3109. Sin ese OR, habrian
// desaparecido de verdad.)
//
// QUE CAMBIA EN ESTA VERSION
// --------------------------
//   - Elige cual conservar POR EVIDENCIA: gana el que tiene fichajes, y entre
//     dos que fichan, el del fichaje mas reciente. Usa `rankCandidateUsers`
//     de matchingRules.js, la misma funcion que usa el matching y que tiene
//     tests.
//   - MUEVE los `Checkins` al USERID que se conserva antes de borrar nada.
//     Ningun fichaje queda huerfano.
//   - MUEVE (no borra) `userexclusions`, `specialusers` y `ManualEntries`.
//   - Trabaja POR EMPRESA: los duplicados se buscan dentro de un tenant, no
//     mezclando todas (dos empresas pueden tener el mismo legajo).
//   - NO agrega ninguna UNIQUE KEY. Ya existe `uq_users_tenant_badge`
//     (migracion 20260909) y es la correcta: por empresa, no global.
//   - Todo dentro de una transaccion por duplicado: o se mueve todo y se
//     borra, o no se toca nada.
//   - MODO SIMULACION POR DEFECTO: sin `--aplicar` solo informa que haria.
//
// USO
//   node scripts/cleanup-duplicate-users.js --tenant=6              (simula)
//   node scripts/cleanup-duplicate-users.js --tenant=6 --aplicar    (aplica)
require('dotenv').config();
const db = require('../db');
const auditLog = require('../auditLog');
const { rankCandidateUsers } = require('../matchingRules');

function arg(nombre) {
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split('=')[1] : null;
}

async function main() {
  const tenantArg = arg('tenant');
  const tenantId = Number(tenantArg);
  const aplicar = process.argv.includes('--aplicar');

  // Ojo: `Number(null)` es 0, no NaN, asi que chequear solo con
  // `Number.isFinite` dejaba pasar la falta del parametro como "empresa 0".
  // Lo encontro la propia prueba del script.
  if (tenantArg === null || !Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('Falta --tenant=<id>. Este script trabaja de a una empresa por vez.');
    console.error('Uso: node scripts/cleanup-duplicate-users.js --tenant=6 [--aplicar]');
    process.exit(1);
  }

  console.log(aplicar
    ? `MODO APLICAR -- se van a modificar datos de la empresa ${tenantId}`
    : `MODO SIMULACION (empresa ${tenantId}) -- no se modifica nada. Agrega --aplicar para hacerlo.`);

  const [duplicados] = await db.query(`
    SELECT TRIM(Badgenumber) AS badge, COUNT(*) AS n
    FROM \`users\`
    WHERE tenant_id = ? AND TRIM(COALESCE(Badgenumber, '')) <> ''
    GROUP BY TRIM(Badgenumber)
    HAVING n > 1`, [tenantId]);

  if (duplicados.length === 0) {
    console.log('\nNo hay legajos duplicados. Nada que hacer.');
    await db.end();
    return;
  }
  console.log(`\nLegajos con mas de una fila: ${duplicados.length}\n`);

  let movidos = 0;
  let borrados = 0;

  for (const dup of duplicados) {
    // Se traen los candidatos CON su evidencia de uso.
    const [filas] = await db.query(`
      SELECT u.USERID, u.Name AS user_name,
             COALESCE(ck.n, 0) AS checkinCount, ck.ultimo AS lastCheckin
      FROM \`users\` u
      LEFT JOIN (
        SELECT tenant_id, USERID, COUNT(*) n, MAX(CHECKTIME) ultimo
        FROM Checkins GROUP BY tenant_id, USERID
      ) ck ON ck.USERID = u.USERID AND ck.tenant_id = u.tenant_id
      WHERE u.tenant_id = ? AND TRIM(u.Badgenumber) = ?`, [tenantId, dup.badge]);

    // EL DESEMPATE: gana el que ficha. Nunca "el primero de la lista".
    const ordenados = rankCandidateUsers(filas);
    const conservar = ordenados[0];
    const aBorrar = ordenados.slice(1);

    console.log(`legajo ${dup.badge}: conservar #${conservar.USERID} (${conservar.checkinCount} fichajes, ultimo ${conservar.lastCheckin || 'nunca'})`);
    for (const v of aBorrar) {
      console.log(`   -> mover y borrar #${v.USERID} (${v.checkinCount} fichajes)`);
    }

    if (!aplicar) continue;

    for (const viejo of aBorrar) {
      await auditLog.inTransaction(db, async (conn) => {
        // 1. LOS FICHAJES PRIMERO. Esto es lo que la version vieja no hacia.
        const [ck] = await conn.query(
          'UPDATE Checkins SET USERID = ? WHERE USERID = ? AND tenant_id = ?',
          [conservar.USERID, viejo.USERID, tenantId]);
        movidos += ck.affectedRows;

        // 2. Lo cargado a mano se MUEVE, no se borra: son justificaciones,
        //    licencias y horas extra que alguien cargo y que no se pueden
        //    recuperar si se pierden.
        await conn.query('UPDATE `userexclusions` SET userId = ? WHERE userId = ? AND tenant_id = ?',
          [conservar.USERID, viejo.USERID, tenantId]);
        await conn.query('UPDATE `specialusers` SET userId = ? WHERE userId = ? AND tenant_id = ?',
          [conservar.USERID, viejo.USERID, tenantId]);
        await conn.query('UPDATE ManualEntries SET userId = ? WHERE userId = ? AND tenant_id = ?',
          [conservar.USERID, viejo.USERID, tenantId]);

        // 3. El vinculo con el empleado: si el viejo lo tenia y el que se
        //    conserva no, se traspasa.
        await conn.query(
          `UPDATE user_employee_map SET USERID = ?
           WHERE USERID = ? AND tenant_id = ?
             AND NOT EXISTS (SELECT 1 FROM (SELECT 1) x WHERE ? IN
               (SELECT USERID FROM user_employee_map WHERE tenant_id = ?))`,
          [conservar.USERID, viejo.USERID, tenantId, conservar.USERID, tenantId]);
        await conn.query('DELETE FROM user_employee_map WHERE USERID = ? AND tenant_id = ?',
          [viejo.USERID, tenantId]);

        // 4. Recien ahora, cuando ya no queda nada apuntandole.
        await conn.query('DELETE FROM `users` WHERE USERID = ? AND tenant_id = ?',
          [viejo.USERID, tenantId]);
        borrados++;
      });
    }
  }

  if (aplicar) {
    console.log(`\nListo. Fichajes movidos: ${movidos}. Filas de users borradas: ${borrados}.`);

    const [[huerfanos]] = await db.query(`
      SELECT COUNT(*) n FROM Checkins c
      LEFT JOIN \`users\` u ON u.USERID = c.USERID AND u.tenant_id = c.tenant_id
      WHERE c.tenant_id = ? AND u.USERID IS NULL`, [tenantId]);
    console.log(`Fichajes sin fila propia en users: ${huerfanos.n}`);
    console.log('(este numero NO deberia haber subido respecto de antes de correr el script)');
  } else {
    console.log('\nSimulacion terminada. Nada se modifico.');
  }

  await db.end();
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
