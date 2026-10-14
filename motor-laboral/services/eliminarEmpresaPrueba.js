// ============================================================================
// Eliminar una empresa de PRUEBA con todos sus datos (2026-10-14)
// ============================================================================
//
// EL PROBLEMA
// -----------
// El "Eliminar" de Empresas solo borraba la fila de la empresa. Pero una
// empresa tiene ~50 tablas colgando (usuarios, permisos, suscripción, pedidos
// de plan, motivos, plantillas...) y muchas con clave foránea hacia ella: la
// base se negaba y la pantalla mostraba "No se pudo eliminar", sin decir por
// qué. Así quedaban en producción "Nueva de prueba" y "prueba2".
//
// QUÉ HACE
// --------
// 1. revisarEliminacion: cuenta qué tiene la empresa y si hay algo que la
//    convierte en REAL. No borra nada.
// 2. eliminarEmpresaPrueba: si no hay bloqueos y el nombre escrito coincide,
//    borra TODO en una sola transacción (o todo, o nada) y después borra las
//    cuentas de login de sus usuarios.
//
// QUÉ LA HACE "REAL" (no se borra desde acá, nunca)
// --------------------------------------------------
//   - tiene fichajes: es la historia de asistencia de personas reales;
//   - tiene pagos registrados: son registros contables.
// Una empresa así se da de baja con el proceso de baja, no se borra. (La
// Empresa Demo tiene fichajes inventados: se borra con su propio script,
// `scripts/crear-empresa-demo.js --borrar`.)
//
// CÓMO BORRA SIN UNA LISTA A MANO
// --------------------------------
// Las tablas se descubren solas (information_schema): toda tabla con
// `tenant_id`, más las tablas "hijas" que no lo tienen pero cuelgan de una
// que sí (por clave foránea, o por las relaciones sin clave de HIJAS_SIN_FK).
// El orden también se resuelve solo: se borra en pasadas, y una tabla que
// todavía está referenciada por otra se reintenta en la pasada siguiente.
// Así, una tabla nueva que se agregue mañana con `tenant_id` queda incluida
// sin tocar este archivo. Si algo no se puede borrar, se deshace todo y se
// informa qué tabla lo impidió.
//
// QUÉ SE CONSERVA
// ---------------
// Las solicitudes de alta, la prueba de aceptación de los términos, el
// registro de actividad y los avisos de MercadoPago se quedan, con la empresa
// en blanco (tenant_id = NULL): son constancias, no datos de la empresa.
const admin = require('firebase-admin');
const { initFirebaseAdmin } = require('../../firebaseAuth');

class ErrorDeEliminacion extends Error {
  constructor(status, mensaje, extra = {}) { super(mensaje); this.status = status; Object.assign(this, extra); }
}

const CONSERVAR_SIN_EMPRESA = ['signup_leads', 'aceptaciones_legales', 'registro_actividad', 'mercadopago_events'];

// Tablas hijas SIN clave foránea declarada: [hija, columna, padre].
const HIJAS_SIN_FK = [
  ['shift_blocks', 'template_id', 'work_schedule_templates'],
  ['employee_events', 'employee_id', 'employees'],
  ['employee_leave_balances', 'employee_id', 'employees'],
  ['attendance_calculation_results', 'run_id', 'attendance_calculation_runs'],
  ['day_overrides', 'calendar_id', 'employee_work_calendars'],
  ['tolerance_policies', 'convention_id', 'labor_conventions'],
  ['overtime_policies', 'convention_id', 'labor_conventions'],
];

const BLOQUEOS = [
  ['Checkins', 'fichajes'],
  ['payment_records', 'pagos registrados'],
];

const ER_REFERENCIADA = 'ER_ROW_IS_REFERENCED_2';

async function estructura(q) {
  const [cols] = await q(`SELECT c.TABLE_NAME t, c.IS_NULLABLE n FROM information_schema.COLUMNS c
     JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE'
     WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'tenant_id' AND c.TABLE_NAME <> 'tenants'`);
  const conEmpresa = new Map(cols.map((r) => [r.t, r.n === 'YES']));
  const [fks] = await q(`SELECT TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc, IS_NULLABLE n
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.COLUMNS col USING (TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME)
     WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
  const [todas] = await q(`SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`);
  const existe = new Set(todas.map((r) => r.t));
  // Hijas sin tenant_id que cuelgan de una tabla con tenant_id (por id).
  const hijas = [
    ...fks.filter((f) => !conEmpresa.has(f.t) && f.t !== 'tenants' && conEmpresa.has(f.rt) && f.rc === 'id')
      .map((f) => ({ hija: f.t, col: f.c, padre: f.rt, anulable: f.n === 'YES' })),
    ...HIJAS_SIN_FK.filter(([h, , p]) => existe.has(h) && conEmpresa.has(p))
      .map(([hija, col, padre]) => ({ hija, col, padre, anulable: false })),
  ];
  return { conEmpresa, hijas };
}

/** Qué tiene la empresa y si se puede borrar. No cambia nada. */
async function revisarEliminacion(db, tenantId) {
  const q = (...a) => db.query(...a);
  const [[empresa]] = await q('SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
  if (!empresa) throw new ErrorDeEliminacion(404, 'Empresa no encontrada');
  const { conEmpresa } = await estructura(q);
  const contenido = [];
  for (const tabla of [...conEmpresa.keys()].sort()) {
    const [[r]] = await q(`SELECT COUNT(*) n FROM \`${tabla}\` WHERE tenant_id = ?`, [tenantId]);
    if (r.n > 0) contenido.push({ tabla, filas: Number(r.n), seConserva: CONSERVAR_SIN_EMPRESA.includes(tabla) });
  }
  const bloqueos = BLOQUEOS
    .map(([tabla, que]) => ({ que, cantidad: (contenido.find((c) => c.tabla === tabla) || {}).filas || 0 }))
    .filter((b) => b.cantidad > 0);
  const [usuarios] = await q('SELECT email, is_superadmin FROM app_users WHERE tenant_id = ? ORDER BY email', [tenantId]);
  return {
    empresa: { id: empresa.id, nombre: empresa.name },
    eliminable: bloqueos.length === 0,
    bloqueos,
    contenido,
    usuarios: usuarios.filter((u) => !u.is_superadmin).map((u) => u.email),
  };
}

/**
 * Borra la empresa y todo lo suyo, en una transacción.
 * @param confirmacion  el nombre de la empresa, escrito a mano por el superadmin
 * @param deps.auth     admin.auth() (en los tests, uno falso)
 */
async function eliminarEmpresaPrueba(db, tenantId, confirmacion, { auth } = {}) {
  const revision = await revisarEliminacion(db, tenantId);
  if (String(confirmacion ?? '').trim() !== revision.empresa.nombre) {
    throw new ErrorDeEliminacion(400, 'El nombre escrito no coincide con el de la empresa. No se borró nada.');
  }
  if (!revision.eliminable) {
    throw new ErrorDeEliminacion(409, `No es una empresa de prueba: tiene ${revision.bloqueos.map((b) => `${b.cantidad} ${b.que}`).join(' y ')}. No se borró nada.`, { bloqueos: revision.bloqueos });
  }

  const conn = await db.getConnection();
  const q = (...a) => conn.query(...a);
  let uidsDeLogin = [];
  const borrado = {};
  const sumar = (tabla, n) => { if (n) borrado[tabla] = (borrado[tabla] || 0) + n; };
  try {
    await conn.beginTransaction();
    // Revisa OTRA VEZ dentro de la transacción, con la empresa bloqueada:
    // entre la revisión y el borrado pudo entrar un fichaje.
    await q('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
    for (const [tabla, que] of BLOQUEOS) {
      const [[r]] = await q(`SELECT COUNT(*) n FROM \`${tabla}\` WHERE tenant_id = ?`, [tenantId]).catch(() => [[{ n: 0 }]]);
      if (r.n > 0) throw new ErrorDeEliminacion(409, `No es una empresa de prueba: tiene ${r.n} ${que}. No se borró nada.`);
    }
    const { conEmpresa, hijas } = await estructura(q);

    const [usuarios] = await q('SELECT id, firebase_uid FROM app_users WHERE tenant_id = ? AND is_superadmin = 0', [tenantId]);
    uidsDeLogin = usuarios.map((u) => u.firebase_uid).filter(Boolean);
    // Un superadmin nunca se borra: si estaba asignado a esta empresa, queda sin empresa.
    await q('UPDATE app_users SET tenant_id = NULL WHERE tenant_id = ? AND is_superadmin = 1', [tenantId]);

    // 1. Constancias que se conservan, sin empresa.
    for (const tabla of CONSERVAR_SIN_EMPRESA) {
      if (conEmpresa.get(tabla) === true) {
        const [r] = await q(`UPDATE \`${tabla}\` SET tenant_id = NULL WHERE tenant_id = ?`, [tenantId]);
        if (r.affectedRows) borrado[`${tabla} (se conserva, sin empresa)`] = r.affectedRows;
      }
    }
    // 2. Hijas sin tenant_id. Si apuntan a un usuario (ej. "creado por") y la
    //    columna admite vacío, se deja en blanco en vez de borrar la fila.
    for (const h of hijas) {
      const sub = `SELECT id FROM \`${h.padre}\` WHERE tenant_id = ?`;
      if (h.padre === 'app_users' && h.anulable) {
        await q(`UPDATE \`${h.hija}\` SET \`${h.col}\` = NULL WHERE \`${h.col}\` IN (${sub})`, [tenantId]);
      } else {
        const [r] = await q(`DELETE FROM \`${h.hija}\` WHERE \`${h.col}\` IN (${sub})`, [tenantId]);
        sumar(h.hija, r.affectedRows);
      }
    }
    // 3. Tablas con tenant_id, en pasadas: la que todavía está referenciada
    //    por otra se reintenta después.
    let pendientes = [...conEmpresa.keys()].filter((t) => !CONSERVAR_SIN_EMPRESA.includes(t));
    for (let pasada = 0; pendientes.length && pasada < 15; pasada++) {
      const siguen = [];
      for (const tabla of pendientes) {
        try {
          const [r] = await q(`DELETE FROM \`${tabla}\` WHERE tenant_id = ?`, [tenantId]);
          sumar(tabla, r.affectedRows);
        } catch (err) {
          if (err.code !== ER_REFERENCIADA) throw err;
          siguen.push(tabla);
        }
      }
      if (siguen.length === pendientes.length) {
        throw new ErrorDeEliminacion(409, `No se pudo borrar: datos de otra empresa apuntan a estas tablas (${siguen.join(', ')}). No se borró nada.`);
      }
      pendientes = siguen;
    }
    if (pendientes.length) throw new ErrorDeEliminacion(500, `No se pudo terminar el borrado (${pendientes.join(', ')}). No se borró nada.`);

    const [r] = await q('DELETE FROM tenants WHERE id = ?', [tenantId]);
    if (r.affectedRows !== 1) throw new ErrorDeEliminacion(404, 'Empresa no encontrada');
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err && err.code === ER_REFERENCIADA) {
      throw new ErrorDeEliminacion(409, 'No se pudo borrar: hay datos que dependen de esta empresa. No se borró nada.');
    }
    throw err;
  } finally {
    conn.release();
  }

  // 4. Las cuentas de login de sus usuarios: sin la empresa ya no sirven. Va
  //    después del commit: si Firebase falla, la empresa igual quedó borrada
  //    y las cuentas sin usuario no tienen acceso a nada.
  let loginsBorrados = 0;
  if (uidsDeLogin.length) {
    try {
      auth = auth || (initFirebaseAdmin(), admin.apps.length ? admin.auth() : null);
      if (auth) loginsBorrados = (await auth.deleteUsers(uidsDeLogin)).successCount;
    } catch (err) {
      console.error('Eliminar empresa de prueba: no se pudieron borrar las cuentas de login:', err.message);
    }
  }
  return { ok: true, empresa: revision.empresa, borrado, loginsBorrados, usuarios: revision.usuarios };
}

module.exports = { revisarEliminacion, eliminarEmpresaPrueba, ErrorDeEliminacion, CONSERVAR_SIN_EMPRESA };
