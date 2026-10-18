// ============================================================================
// Borra las empresas de prueba que dejan los tests
// ============================================================================
//
// EL PROBLEMA
// -----------
// Los tests crean empresas descartables (ids 999900 en adelante) y las
// borran en su `after()`. Pero 21 de ellos lo hacen en el ORDEN EQUIVOCADO:
//
//     await db.query('DELETE FROM tenants WHERE id = ?', [T]).catch(() => {});
//     await deleteTestUser(UID);   // <-- recien aca borra el usuario
//
// La empresa se intenta borrar mientras su propio app_user todavia la
// referencia, asi que MySQL lo rechaza por clave foranea... y el
// `.catch(() => {})` se traga el error en silencio. La empresa queda en la
// base para siempre, y despues aparece en /empresas y en /facturacion como
// si alguien la hubiera cargado a mano.
//
// POR QUE UNA RED DE SEGURIDAD Y NO ARREGLAR LOS 21
// -------------------------------------------------
// Arreglar el orden en cada archivo se puede, pero el problema vuelve con el
// proximo test que alguien escriba distraido -- y nadie se entera hasta que
// ve basura en la pantalla de administracion. Esto corre solo, antes y
// despues de cada `npm test`, y deja la base limpia sin depender de que los
// 48 archivos esten bien escritos.
//
// SEGURIDAD: SOLO toca ids >= 999900
// ----------------------------------
// Ese rango es el que usan los tests por convencion. Las empresas reales
// tienen ids chicos (AVP es la 6). El limite esta escrito abajo como
// constante y el script se niega a correr si alguien lo baja: borrar
// empresas de verdad seria catastrofico.
//
// USO
//   node scripts/limpiar-datos-de-prueba.js            (simula)
//   node scripts/limpiar-datos-de-prueba.js --aplicar  (borra)
require('dotenv').config();
const db = require('../db');

// Todo id por debajo de esto es una empresa REAL y no se toca jamas.
const PRIMER_ID_DE_PRUEBA = 999900;

if (PRIMER_ID_DE_PRUEBA < 999000) {
  console.error('El limite de ids de prueba quedo peligrosamente bajo. Abortando.');
  process.exit(1);
}

async function existeTabla(nombre) {
  const [[r]] = await db.query(
    `SELECT COUNT(*) k FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [nombre]);
  return r.k > 0;
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  const [tenants] = await db.query(
    'SELECT id, name FROM tenants WHERE id >= ? ORDER BY id', [PRIMER_ID_DE_PRUEBA]);

  if (tenants.length === 0) {
    if (aplicar) console.log('Base limpia: no hay empresas de prueba.');
    return;
  }

  console.log(`Empresas de prueba encontradas: ${tenants.length}`);
  tenants.forEach(t => console.log(`   ${t.id}  ${t.name}`));

  if (!aplicar) {
    console.log('\n(simulacion: no se borro nada -- agregar --aplicar)');
    return;
  }

  const ids = tenants.map(t => t.id);

  // Las tablas que referencian una empresa, en orden de dependencia: lo que
  // apunta a otras filas va primero. Si aparece una tabla nueva con
  // tenant_id y no se agrega aca, el borrado de esa empresa va a fallar --
  // por eso mas abajo se verifica y se avisa, en vez de fallar en silencio
  // como hacian los tests.
  const enOrden = [
    'manual_entry_log', 'user_exclusion_log', 'manual_checkin_log',
    'marker_correction_log', 'marker_corrections', 'event_type_quotas',
    'overtime_period_adjustments', 'overtime_period_results', 'overtime_period_closings',
    'overtime_excess_approvals', 'employee_overtime_authorizations', 'overtime_regime_policies',
    'rule_engine_shadow_diffs', 'work_schedule_template_config_history',
    'employee_convention_assignments', 'employee_work_calendars',
    'day_type_overtime_rules', 'labor_convention_regimes', 'labor_conventions',
    'ManualEntries', 'userexclusions', 'specialusers', 'dailyattendance',
    'dayassignments', 'attendance_calculation_results',
    'attendance_calculation_runs',
    'Checkins', 'user_employee_map', 'users',
    'shift_blocks', 'work_schedule_templates', 'companyschedule',
    'employee_events', 'leave_balances', 'staging_employees',
    'employees', 'employee_categories',
    'sucursales', 'ciudades', 'holidays',
    'event_type_count_modes', 'event_type_mappings', 'event_types',
    'vacation_scale', 'payroll_regime_settings',
    'payment_records', 'plan_requests', 'tenant_subscriptions',
    'tenant_agent_keys', 'agent_sync_status', 'app_settings',
    'signup_leads', 'app_users'
  ];

  const [existentes] = await db.query(
    `SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' AND TABLE_NAME <> 'tenants'`);
  const nombres = new Set(existentes.map(r => r.TABLE_NAME));

  // ¿Hay alguna tabla con tenant_id que esta lista no contemple?
  const olvidadas = [...nombres].filter(n => !enOrden.includes(n));
  if (olvidadas.length) {
    console.log(`\nAviso: estas tablas tienen tenant_id y no estan en la lista: ${olvidadas.join(', ')}`);
    console.log('Se borran al final, por las dudas.');
  }

  // Tablas HIJAS: no tienen tenant_id propio, lo heredan del padre. Si no se
  // borran primero, la clave foranea impide borrar al padre -- que es
  // exactamente el error que dejaba empresas colgadas. Descubiertas el
  // 2026-09-23 revisando que tablas no tienen tenant_id: el filtro de abajo
  // las salteaba en silencio porque solo mira las que SI lo tienen.
  const hijas = [
    ['shift_blocks', 'template_id', 'work_schedule_templates'],
    ['employee_events', 'employee_id', 'employees'],
    ['employee_leave_balances', 'employee_id', 'employees'],
  ];

  let total = 0;
  for (const [hija, fk, padre] of hijas) {
    if (!(await existeTabla(hija))) continue;
    try {
      const [r] = await db.query(
        `DELETE FROM \`${hija}\` WHERE \`${fk}\` IN
           (SELECT id FROM \`${padre}\` WHERE tenant_id IN (?))`, [ids]);
      if (r.affectedRows) {
        total += r.affectedRows;
        console.log(`   ${hija}: ${r.affectedRows}`);
      }
    } catch (err) {
      console.error(`   ${hija}: NO se pudo borrar (${err.code || err.message})`);
    }
  }

  for (const tabla of [...enOrden.filter(t => nombres.has(t)), ...olvidadas]) {
    try {
      const [r] = await db.query(`DELETE FROM \`${tabla}\` WHERE tenant_id IN (?)`, [ids]);
      if (r.affectedRows) {
        total += r.affectedRows;
        console.log(`   ${tabla}: ${r.affectedRows}`);
      }
    } catch (err) {
      // A diferencia de los tests, aca NO se traga el error: si algo no se
      // pudo borrar hay que enterarse, porque es lo que deja la empresa
      // colgada.
      console.error(`   ${tabla}: NO se pudo borrar (${err.code || err.message})`);
    }
  }

  const [r] = await db.query('DELETE FROM tenants WHERE id IN (?)', [ids]);
  console.log(`\nEmpresas de prueba borradas: ${r.affectedRows} de ${tenants.length} (${total} filas asociadas)`);

  if (r.affectedRows < tenants.length) {
    const [quedan] = await db.query(
      'SELECT id, name FROM tenants WHERE id >= ?', [PRIMER_ID_DE_PRUEBA]);
    console.error('\nQuedaron sin borrar:');
    quedan.forEach(t => console.error(`   ${t.id}  ${t.name}  <-- algo la sigue referenciando`));
    process.exitCode = 1;
  }
}

// ============================================================================
// Cuentas de login que dejan los tests (Firebase)
// ============================================================================
//
// Cada test entra con una cuenta de Firebase descartable (test-helpers/
// firebaseTestAuth.js) y la borra al terminar. Si el test se corta antes,
// la cuenta queda en Firebase para siempre: el 2026-10-14 había 8 juntadas
// desde julio. Y ese Firebase es el MISMO que usa producción (proyecto
// asistenciatw), así que hay que distinguir muy bien qué es de prueba.
//
// CÓMO SE RECONOCE UNA CUENTA DE PRUEBA
// -------------------------------------
// No tiene email NI ningún método de ingreso (ni contraseña, ni Google).
// Una cuenta así solo se puede crear con la llave de administrador
// (createCustomToken), que es lo que hacen los tests. El sistema real NUNCA
// la crea: toda cuenta de una persona tiene email (appUserRepository.js
// crea con email; el registro también). Si eso cambiara algún día, este
// criterio hay que revisarlo ANTES.
//
// Además solo se borran cuentas de más de 15 minutos, para no pisar a un
// test que esté corriendo en otra terminal en ese mismo momento. Las de una
// corrida que se cortó recién se limpian en la próxima corrida.
const MINUTOS_DE_GRACIA = 15;

function esCuentaDePrueba(u, ahora = Date.now()) {
  const sinIdentidad = !u.email && !u.phoneNumber && (!u.providerData || u.providerData.length === 0);
  const creada = Date.parse(u.metadata && u.metadata.creationTime);
  const vieja = Number.isFinite(creada) && ahora - creada > MINUTOS_DE_GRACIA * 60 * 1000;
  return sinIdentidad && vieja;
}

async function limpiarCuentasDeLogin(aplicar) {
  const path = require('path');
  // API modular de firebase-admin (la 'getAuth()' vieja no existe desde la v14).
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  const ruta = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!json && !ruta) {
    console.log('Cuentas de login: sin credenciales de Firebase, no se revisan.');
    return;
  }
  if (!getApps().length) {
    initializeApp({ credential: cert(json ? JSON.parse(json) : require(path.resolve(ruta))) });
  }
  const huerfanas = [];
  let pagina;
  do {
    const r = await getAuth().listUsers(1000, pagina);
    huerfanas.push(...r.users.filter((u) => esCuentaDePrueba(u)));
    pagina = r.pageToken;
  } while (pagina);
  if (!huerfanas.length) {
    if (aplicar) console.log('Cuentas de login: no quedaron cuentas de prueba.');
    return;
  }
  console.log(`Cuentas de login de prueba que quedaron: ${huerfanas.length}`);
  huerfanas.forEach((u) => console.log(`   ${u.uid}`));
  if (!aplicar) return;
  const r = await getAuth().deleteUsers(huerfanas.map((u) => u.uid));
  console.log(`Cuentas de login de prueba borradas: ${r.successCount} de ${huerfanas.length}`);
  if (r.failureCount) {
    r.errors.forEach((e) => console.error(`   ${huerfanas[e.index].uid}: ${e.error.message}`));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .then(() => limpiarCuentasDeLogin(process.argv.includes('--aplicar')))
    .catch((err) => { console.error('ERROR:', err.message); process.exitCode = 1; })
    .finally(() => db.end());
}

module.exports = { esCuentaDePrueba };
