// ============================================================================
// Tests que necesitan los DATOS REALES de AVP
// ============================================================================
//
// Algunos tests comparan contra datos de produccion copiados a la base local:
// "junio 2026 da los mismos totales que hoy", "Perrotta (legajo 2525) da los
// valores conocidos", etc. Son utiles en la maquina del desarrollador, que
// tiene esa copia, pero NO pueden correr en el CI: su base arranca vacia y
// este repo es publico, asi que nunca va a tener datos de empleados reales.
//
// Antes, en una base sin esos datos fallaban con errores confusos ("legajo
// 2525 debe tener un USERID de reloj"), mezclados con las fallas de verdad.
// Ahora se SALTEAN, con el motivo a la vista en el reporte:
//
//   test('...', async (t) => {
//     if (await saltarSinDatosReales(t)) return;
//     ...
//   });
//
// Un test salteado no es un test que pasa: el reporte los cuenta aparte
// ("skipped"), asi que no se puede confundir con verde.
const db = require('../db');

const TENANT_REAL = 6;
const LEGAJO_REFERENCIA = 2525; // PERROTTA, usado por varios tests de caracterizacion

let cache = null;

async function hayDatosReales() {
  if (cache !== null) return cache;
  const [[fila]] = await db.query(
    `SELECT COUNT(*) AS n
     FROM employees e
     JOIN user_employee_map uem ON uem.employee_id = e.id AND uem.tenant_id = e.tenant_id
     JOIN Checkins c ON c.tenant_id = e.tenant_id AND c.USERID = uem.USERID
     WHERE e.tenant_id = ? AND e.employee_id = ?
       AND c.CHECKTIME >= '2026-06-01' AND c.CHECKTIME < '2026-07-01'`,
    [TENANT_REAL, LEGAJO_REFERENCIA]
  );
  cache = fila.n > 0;
  return cache;
}

/**
 * Saltea el test si la base no tiene los datos reales de AVP. Devuelve true
 * si lo salteo (el test tiene que hacer `return` en ese caso).
 * @param {import('node:test').TestContext} t
 */
async function saltarSinDatosReales(t) {
  if (await hayDatosReales()) return false;
  t.skip('necesita los datos reales de AVP (junio 2026, legajo 2525): no estan en esta base (por ejemplo, en el CI)');
  return true;
}

module.exports = { hayDatosReales, saltarSinDatosReales };
