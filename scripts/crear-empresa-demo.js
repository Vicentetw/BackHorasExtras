#!/usr/bin/env node
/**
 * Crea (o renueva) la EMPRESA DE DEMOSTRACION: una empresa con empleados y
 * fichajes INVENTADOS, para sacar capturas y mostrarle el sistema a un
 * interesado sin exponer los datos de un cliente real.
 *
 * POR QUE EXISTE
 * --------------
 * Las pantallas de un cliente real muestran nombres y horarios de personas
 * reales: son datos personales de terceros. Usarlos en una captura de venta
 * o en una demo es un problema legal y de confianza con ese cliente. Aca
 * todos los nombres, legajos y documentos son inventados.
 *
 * QUE CREA
 * --------
 *   - la empresa "Empresa Demo S.A." (codigo `empresa-demo`), con suscripcion
 *     en estado 'free' (no se cobra ni se bloquea)
 *   - 1 ciudad, 2 sucursales, 2 plantillas de horario (8 a 16 y 6 a 14)
 *   - 24 empleados, cada uno con su usuario de reloj ya vinculado
 *   - fichajes de los ultimos 45 dias HASTA HOY, con variedad creible:
 *     llegadas a tiempo, algunas tardes, algunas ausencias, y horas extra
 *     con marcadores para unos pocos
 *   - un reloj con nombre ("Reloj recepción"), recien sincronizado
 *
 * Las fechas son relativas al dia en que se corre: volver a correrlo antes de
 * una demo deja todo "al dia". Es idempotente: borra lo que habia de la demo
 * y lo vuelve a crear. NO toca ninguna otra empresa: todo lo que escribe y
 * borra lleva el tenant_id de la demo.
 *
 * USO (PowerShell), igual que run-sql.js -- las credenciales van por variable
 * de entorno, nunca escritas en un archivo:
 *   $env:MYSQL_ADDON_HOST="..."; $env:MYSQL_ADDON_PORT="3306"
 *   $env:MYSQL_ADDON_USER="..."; $env:MYSQL_ADDON_PASSWORD="..."; $env:MYSQL_ADDON_DB="..."
 *   node scripts/crear-empresa-demo.js            # crea o renueva
 *   node scripts/crear-empresa-demo.js --borrar   # la saca del todo
 *
 * DESPUES: el superadmin crea un usuario para "Empresa Demo S.A." en Usuarios
 * y Roles (rol Administrador de Empresa) y entra con ese usuario.
 */
const mysql = require('mysql2/promise');
const { fechaEnZona } = require('../motor-laboral/services/hoyEmpresa');

const CODIGO = 'empresa-demo';
const NOMBRE = 'Empresa Demo S.A.';
const ZONA = 'America/Argentina/Buenos_Aires';
const DIAS_DE_HISTORIA = 45;
const RELOJ_IP = '10.20.0.11';
const USERID_BASE = 7700000; // lejos de los USERID de un reloj real

// Nombres inventados (apellido, nombre). Cualquier parecido es casualidad.
const PERSONAS = [
  ['ACOSTA', 'Lucía Belén'], ['BENÍTEZ', 'Marcos Ariel'], ['CABRERA', 'Sofía Antonella'], ['DOMÍNGUEZ', 'Julián Ezequiel'],
  ['ESPINOSA', 'Carla Noemí'], ['FIGUEROA', 'Tomás Agustín'], ['GIMÉNEZ', 'Valeria Soledad'], ['HERRERA', 'Nicolás Matías'],
  ['IBARRA', 'Florencia Daniela'], ['JUÁREZ', 'Sebastián Darío'], ['LEDESMA', 'Micaela Rocío'], ['MANSILLA', 'Gonzalo Iván'],
  ['NAVARRO', 'Paula Andrea'], ['OJEDA', 'Federico Luis'], ['PAREDES', 'Camila Ayelén'], ['QUIROGA', 'Ramiro Emanuel'],
  ['RIVERO', 'Natalia Verónica'], ['SALINAS', 'Diego Hernán'], ['TOLEDO', 'Agustina Milagros'], ['URQUIZA', 'Leandro Fabián'],
  ['VALLEJOS', 'Romina Gisela'], ['WALSH', 'Ignacio Martín'], ['YAPURA', 'Brenda Estefanía'], ['ZALAZAR', 'Cristian Omar'],
];
// Los primeros 16 trabajan de 8 a 16 (administracion); el resto de 6 a 14.
const TURNOS = [
  { nombre: 'Administración (8 a 16)', inicio: 8, fin: 16, desde: 0, hasta: 16, sucursal: 'Casa central' },
  { nombre: 'Depósito (6 a 14)', inicio: 6, fin: 14, desde: 16, hasta: 24, sucursal: 'Depósito' },
];
// Indices de quienes hacen horas extra (con marcadores) dos dias por semana.
const HACEN_HORAS_EXTRA = new Set([1, 9, 17, 21]);

// Azar repetible: la misma persona y el mismo dia dan siempre lo mismo, asi
// volver a correr el script no cambia lo que ya se mostro en una demo.
function azar(semilla) {
  let h = 2166136261;
  for (const c of String(semilla)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const p2 = (n) => String(n).padStart(2, '0');
const hora = (minutosDelDia, seg = 0) => `${p2(Math.floor(minutosDelDia / 60))}:${p2(minutosDelDia % 60)}:${p2(seg)}`;

async function borrarDatos(db, t) {
  const emp = `SELECT id FROM employees WHERE tenant_id = ${Number(t)}`;
  const tpl = `SELECT id FROM work_schedule_templates WHERE tenant_id = ${Number(t)}`;
  // Del mas dependiente al menos. Las tablas opcionales (segun migraciones) se
  // intentan y, si no existen, se saltean.
  const sentencias = [
    `DELETE FROM overtime_period_adjustments WHERE tenant_id = ?`, `DELETE FROM overtime_period_results WHERE tenant_id = ?`,
    `DELETE FROM overtime_period_closings WHERE tenant_id = ?`, `DELETE FROM overtime_excess_approvals WHERE tenant_id = ?`,
    `DELETE FROM employee_overtime_authorizations WHERE tenant_id = ?`, `DELETE FROM overtime_regime_policies WHERE tenant_id = ?`,
    `DELETE FROM employee_convention_assignments WHERE tenant_id = ?`,
    `DELETE FROM employee_events WHERE employee_id IN (${emp}) AND ? IS NOT NULL`,
    `DELETE FROM ManualEntries WHERE tenant_id = ?`, `DELETE FROM userexclusions WHERE tenant_id = ?`,
    `DELETE FROM Checkins WHERE tenant_id = ?`, `DELETE FROM specialusers WHERE tenant_id = ?`,
    `DELETE FROM user_employee_map WHERE tenant_id = ?`, `DELETE FROM users WHERE tenant_id = ?`,
    `DELETE FROM employee_work_calendars WHERE tenant_id = ?`,
    `DELETE FROM shift_blocks WHERE template_id IN (${tpl}) AND ? IS NOT NULL`,
    `DELETE FROM work_schedule_templates WHERE tenant_id = ?`,
    `UPDATE app_users SET employee_id = NULL WHERE tenant_id = ?`,
    `DELETE FROM employees WHERE tenant_id = ?`, `DELETE FROM sucursales WHERE tenant_id = ?`, `DELETE FROM ciudades WHERE tenant_id = ?`,
    `DELETE FROM agent_sync_status WHERE tenant_id = ?`,
  ];
  for (const sql of sentencias) {
    await db.query(sql, [t]).catch((err) => {
      if (!['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(err.code)) throw err;
    });
  }
}

async function main() {
  const faltan = ['MYSQL_ADDON_HOST', 'MYSQL_ADDON_USER', 'MYSQL_ADDON_PASSWORD', 'MYSQL_ADDON_DB'].filter((v) => !process.env[v]);
  if (faltan.length) {
    console.error(`Faltan variables de entorno: ${faltan.join(', ')}\nSetealas antes de correr este script (ver el comentario al principio del archivo).`);
    process.exit(1);
  }
  const db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST, port: Number(process.env.MYSQL_ADDON_PORT || 3306),
    user: process.env.MYSQL_ADDON_USER, password: process.env.MYSQL_ADDON_PASSWORD, database: process.env.MYSQL_ADDON_DB,
    dateStrings: true,
  });
  console.log(`Conectado a ${process.env.MYSQL_ADDON_HOST} / base ${process.env.MYSQL_ADDON_DB}`);

  let [[empresa]] = await db.query('SELECT id FROM tenants WHERE code = ?', [CODIGO]);

  if (process.argv.includes('--borrar')) {
    if (!empresa) { console.log('La empresa de demostración no existe: nada que borrar.'); await db.end(); return; }
    await borrarDatos(db, empresa.id);
    const [[u]] = await db.query('SELECT COUNT(*) AS n FROM app_users WHERE tenant_id = ?', [empresa.id]);
    if (u.n > 0) {
      console.log(`Se borraron los datos, pero la empresa queda: tiene ${u.n} usuario(s). Borralos en Usuarios y Roles y volvé a correr --borrar.`);
    } else {
      await db.query('DELETE FROM app_settings WHERE tenant_id = ?', [empresa.id]);
      await db.query('DELETE FROM tenant_subscriptions WHERE tenant_id = ?', [empresa.id]);
      await db.query('DELETE FROM tenants WHERE id = ?', [empresa.id]);
      console.log('Empresa de demostración borrada del todo.');
    }
    await db.end();
    return;
  }

  // --- empresa y suscripcion
  if (!empresa) {
    const [r] = await db.query('INSERT INTO tenants (name, code, timezone) VALUES (?, ?, ?)', [NOMBRE, CODIGO, ZONA]);
    empresa = { id: r.insertId };
  }
  const T = empresa.id;
  await borrarDatos(db, T);

  const [[plan]] = await db.query('SELECT id FROM plans WHERE active = 1 ORDER BY is_default DESC, id LIMIT 1');
  if (plan) {
    await db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status) VALUES (?, ?, 'free')
       ON DUPLICATE KEY UPDATE status = 'free'`, [T, plan.id]);
  }

  // --- ciudad, sucursales, plantillas
  const [ciu] = await db.query('INSERT INTO ciudades (tenant_id, nombre) VALUES (?, ?)', [T, 'Trelew']);
  const sucursalDe = {};
  for (const nombre of ['Casa central', 'Depósito']) {
    const [s] = await db.query('INSERT INTO sucursales (tenant_id, ciudad_id, nombre) VALUES (?, ?, ?)', [T, ciu.insertId, nombre]);
    sucursalDe[nombre] = s.insertId;
  }
  for (const turno of TURNOS) {
    const [tpl] = await db.query(
      `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default, rules_engine_mode) VALUES (?, ?, 'FIXED', 1, ?, 'legacy')`,
      [T, turno.nombre, turno === TURNOS[0] ? 1 : 0]);
    turno.templateId = tpl.insertId;
    for (let dow = 1; dow <= 5; dow++) {
      await db.query(
        `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, active) VALUES (?, ?, 'Jornada', ?, ?, 'WORK', 1)`,
        [tpl.insertId, dow, `${p2(turno.inicio)}:00:00`, `${p2(turno.fin)}:00:00`]);
    }
  }

  // --- empleados, usuarios de reloj y vinculo
  const empleados = [];
  for (const [i, [apellido, nombres]] of PERSONAS.entries()) {
    const turno = TURNOS.find((t) => i >= t.desde && i < t.hasta);
    const legajo = 101 + i;
    const [e] = await db.query(
      `INSERT INTO employees (employee_id, nombre, documento, tipo_documento, tenant_id, activo, fecha_alta, exclude_from_report, ciudad_id, sucursal_id, overtime_authorized)
       VALUES (?, ?, ?, 1, ?, 1, ?, 0, ?, ?, 1)`,
      [legajo, `${apellido}, ${nombres}`, String(30000000 + i * 137911), T, `${2019 + (i % 5)}-0${1 + (i % 9)}-01`, ciu.insertId, sucursalDe[turno.sucursal]]);
    const userId = USERID_BASE + legajo;
    await db.query('INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, ?)', [userId, T, String(legajo), `${apellido}, ${nombres}`]);
    await db.query(`INSERT INTO user_employee_map (USERID, tenant_id, employee_id, match_type) VALUES (?, ?, ?, 'demo')`, [userId, T, e.insertId]);
    await db.query(`INSERT INTO employee_work_calendars (employee_id, tenant_id, template_id, valid_from, valid_to) VALUES (?, ?, ?, '2020-01-01', NULL)`, [e.insertId, T, turno.templateId]);
    empleados.push({ i, id: e.insertId, userId, turno });
  }
  // Marcadores de horas extra (los "botones" 9 y 10 del reloj).
  const M9 = USERID_BASE + 9;
  const M10 = USERID_BASE + 10;
  for (const [uid, badge, dir] of [[M9, '9', 'SALIDA'], [M10, '10', 'REGRESO']]) {
    await db.query(`INSERT INTO users (USERID, tenant_id, Badgenumber, Name) VALUES (?, ?, ?, 'Marcador')`, [uid, T, badge]);
    await db.query(`INSERT INTO specialusers (userId, tenant_id, badgeNumber, name, category, direction, isActive) VALUES (?, ?, ?, 'Marcador horas extra', 'HE', ?, 1)`, [uid, T, badge, dir]);
  }

  // --- fichajes: de hace DIAS_DE_HISTORIA dias hasta hoy
  const ahora = new Date();
  const hoy = fechaEnZona(ZONA, ahora);
  const minutosAhora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(ahora).split(':').reduce((h, m) => Number(h) * 60 + Number(m)));
  const filas = [];
  const poner = (userId, fecha, minutos, seg) => filas.push([userId, T, `${fecha} ${hora(minutos, seg)}`, RELOJ_IP]);
  for (let atras = DIAS_DE_HISTORIA; atras >= 0; atras--) {
    const fecha = fechaEnZona(ZONA, new Date(ahora.getTime() - atras * 86400000));
    const [a, m, d] = fecha.split('-').map(Number);
    const dow = new Date(a, m - 1, d).getDay();
    if (dow === 0 || dow === 6) continue; // sin fichajes el fin de semana
    for (const emp of empleados) {
      const r = azar(`${emp.i}-${fecha}`);
      const suerte = r();
      if (suerte < 0.06) continue; // ausente
      const tarde = suerte < 0.16; // ~10% llega tarde
      const entrada = emp.turno.inicio * 60 + (tarde ? 12 + Math.floor(r() * 35) : -Math.floor(r() * 12) - 1);
      const esHoy = fecha === hoy;
      if (esHoy && entrada > minutosAhora) continue; // todavia no llego
      poner(emp.userId, fecha, entrada, emp.i % 50);
      const fin = emp.turno.fin * 60;
      const haceExtra = HACEN_HORAS_EXTRA.has(emp.i) && (dow === 2 || dow === 4) && !tarde;
      if (haceExtra) {
        // Marcador 9 + fichaje = empieza la hora extra; marcador 10 + fichaje = termina.
        const duracion = 120 + Math.floor(r() * 3) * 30; // 2, 2:30 o 3 horas
        if (esHoy && fin + duracion + 12 > minutosAhora) continue;
        // Cada uno marca unos minutos despues que el anterior: dos personas no
        // aprietan el marcador en el mismo segundo (y la base no admite dos
        // fichajes identicos del mismo marcador).
        const turnoEnLaFila = [...HACEN_HORAS_EXTRA].indexOf(emp.i) * 3;
        const empieza = fin + turnoEnLaFila;
        poner(M9, fecha, empieza - 1, 55); poner(emp.userId, fecha, empieza, 0);
        poner(M10, fecha, empieza + duracion - 1, 55); poner(emp.userId, fecha, empieza + duracion, 0);
      } else {
        const salida = fin + Math.floor(r() * 11);
        if (esHoy && salida > minutosAhora) continue; // sigue trabajando
        poner(emp.userId, fecha, salida, emp.i % 50);
      }
    }
  }
  for (let k = 0; k < filas.length; k += 500) {
    await db.query('INSERT INTO Checkins (USERID, tenant_id, CHECKTIME, MACHINE_IP) VALUES ?', [filas.slice(k, k + 500)]);
  }

  // --- el reloj, con nombre y recien sincronizado
  await db.query(
    `INSERT INTO agent_sync_status (tenant_id, machine_ip, machine_sn, last_synced_at, last_checktime, fichajes_ultima_subida)
     VALUES (?, ?, NULL, NOW(), ?, ?)`, [T, RELOJ_IP, filas.length ? filas[filas.length - 1][2] : null, 24]);
  await db.query(`UPDATE agent_sync_status SET nombre = 'Reloj recepción' WHERE tenant_id = ?`, [T])
    .catch((err) => { if (err.code !== 'ER_BAD_FIELD_ERROR') throw err; }); // sin la migracion 20261013 se ve la IP

  console.log(`Listo: "${NOMBRE}" (empresa ${T}) con ${empleados.length} empleados y ${filas.length} fichajes hasta el ${hoy}.`);
  console.log('Siguiente paso: en Usuarios y Roles, crear un usuario para esa empresa (rol Administrador de Empresa) y entrar con él.');
  await db.end();
}

main().catch((err) => { console.error('ERROR creando la empresa de demostración:', err.message); process.exit(1); });
