// Horario de empresa para las empresas de prueba.
//
// Hasta P3 (2026-10-08), un empleado sin ningún horario se medía contra uno
// inventado: 07:00 a 13:40, de lunes a viernes. Muchos tests armaban su
// empresa SIN plantilla y contaban con ese horario para que "no fichó un
// martes" diera "Ausente". Desde P3, sin horario el estado es "Sin horario"
// (NoSchedule): ya no se inventa nada.
//
// Este helper le da a la empresa de prueba ese mismo horario, pero cargado
// de verdad (una plantilla por defecto), así esos tests siguen probando lo que
// probaban -- ausencias, licencias, campañas -- y no dependen de un horario
// que el sistema ya no supone.
//
// Sirve con el pool de ../db y con una conexión de mysql2 (las dos tienen
// .query que devuelve [filas]).
const NOMBRE = 'Horario de prueba 07:00-13:40 (test)';

async function quitarHorarioDeEmpresa(db, tenantId) {
  await db.query(
    `DELETE sb FROM shift_blocks sb JOIN work_schedule_templates t ON t.id = sb.template_id
      WHERE t.tenant_id = ? AND t.name = ?`, [tenantId, NOMBRE]);
  await db.query('DELETE FROM work_schedule_templates WHERE tenant_id = ? AND name = ?', [tenantId, NOMBRE]);
}

// Lunes (1) a viernes (5), 07:00 a 13:40. Devuelve el id de la plantilla.
async function darHorarioDeEmpresa(db, tenantId) {
  await quitarHorarioDeEmpresa(db, tenantId);
  const [r] = await db.query(
    `INSERT INTO work_schedule_templates (tenant_id, name, type, active, is_default) VALUES (?, ?, 'FIXED', 1, 1)`,
    [tenantId, NOMBRE]);
  for (let dow = 1; dow <= 5; dow++) {
    await db.query(
      `INSERT INTO shift_blocks (template_id, day_of_week, block_name, start_time, end_time, block_type, crosses_midnight, active)
       VALUES (?, ?, 'Jornada', '07:00:00', '13:40:00', 'WORK', 0, 1)`, [r.insertId, dow]);
  }
  return r.insertId;
}

module.exports = { darHorarioDeEmpresa, quitarHorarioDeEmpresa };
