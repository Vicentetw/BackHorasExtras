// ============================================================================
// ¿Quién usa cada plantilla de horario? ¿Se puede borrar, desactivar, archivar?
// ============================================================================
//
// E + F (2026-10-16). Auditoría sobre el backup de producción del 15/10:
//
// - El cálculo (scheduleRepository) solo usa asignaciones a plantillas que
//   EXISTEN y están ACTIVAS (JOIN ... AND t.active = 1), para TODAS las fechas.
//   No hay FK de employee_work_calendars a la plantilla. Por eso borrar o
//   desactivar una plantilla que alguien tuvo asignada le cambia el horario a
//   esa persona también en días pasados (Presentismo, detalle, Salidas, horas
//   extra, portal), sin ningún aviso. Pasó: 10 asignaciones de 3 personas de
//   AVP apuntan a plantillas de empresas de prueba que ya no existen.
// - La plantilla "por defecto" (la marcada, o si no la más nueva activa y no
//   rotativa: findTenantTemplate) mide a todos los que no tienen horario
//   propio. Borrarla o desactivarla cambia ese horario para todos ellos.
//
// Este módulo NO cambia el cálculo: solo cuenta, y decide qué acciones
// dejan el pasado intacto.
//
//   borrar     solo si NUNCA se usó y no tiene referencias (reglas de horas
//              extra, historial de configuración, categorías, diferencias del
//              motor sombra) y no es la por defecto.
//   activa     no se puede cambiar si tuvo asignaciones (en ningún sentido:
//              volver a activar también cambia el pasado) ni si es la por
//              defecto que rige.
//   archivar   la plantilla sigue igual para el cálculo; solo deja de
//              ofrecerse para asignar. Se puede si HOY y en adelante nadie la
//              tiene asignada, no es la por defecto y ninguna categoría la
//              sugiere.
//
// Función pura `decisiones` + una consulta en lote (`usoDePlantillas`) para
// todas las plantillas de una empresa (no una consulta por plantilla).

const { esRotativa } = require('./cicloDeTurnos');

// Igual que scheduleRepository.findTenantTemplate (si cambia uno, cambiar el
// otro): la marcada por defecto o la más nueva activa; nunca una rotativa.
function plantillaPorDefectoQueRige(plantillas) {
  const candidatas = plantillas
    .filter((t) => Number(t.active) === 1 && !esRotativa(t))
    .sort((a, b) => Number(!!Number(b.is_default)) - Number(!!Number(a.is_default)) || b.id - a.id);
  return candidatas[0] || null;
}

const q = async (db, sql, params) => {
  try {
    const [rows] = await db.query(sql, params);
    return rows;
  } catch (err) {
    // Tablas opcionales (migraciones viejas): sin la tabla no hay referencias.
    if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR') return [];
    throw err;
  }
};

/**
 * Uso de todas las plantillas de una empresa.
 * @returns {Promise<{plantillas: Map<number, object>, porDefectoId: number|null,
 *   personasPorDefecto: number, asignacionesRotas: number}>}
 */
async function usoDePlantillas(db, tenantId, hoy) {
  const plantillas = await q(db, 'SELECT * FROM work_schedule_templates WHERE tenant_id = ?', [tenantId]);
  const ids = plantillas.map((t) => t.id);
  const uso = new Map(plantillas.map((t) => [t.id, {
    hoy: 0, antes: 0, futuras: 0, algunaVez: 0, asignaciones: 0,
    reglas: 0, historial: 0, categorias: 0, sombra: 0,
  }]));
  if (ids.length) {
    // Personas distintas por plantilla: hoy, solo antes, desde una fecha futura.
    const filas = await q(db, `
      SELECT c.template_id AS id,
             COUNT(*) AS asignaciones,
             COUNT(DISTINCT c.employee_id) AS algunaVez,
             COUNT(DISTINCT CASE WHEN c.valid_from <= ? AND (c.valid_to IS NULL OR c.valid_to >= ?) THEN c.employee_id END) AS hoy,
             COUNT(DISTINCT CASE WHEN c.valid_from > ? THEN c.employee_id END) AS futuras
        FROM employee_work_calendars c
        JOIN employees e ON e.id = c.employee_id AND e.tenant_id = ?
       WHERE c.template_id IN (?)
       GROUP BY c.template_id`, [hoy, hoy, hoy, tenantId, ids]);
    // "Antes": la tuvieron pero hoy ya no (ni la tendrán desde una fecha futura).
    const antes = await q(db, `
      SELECT c.template_id AS id, COUNT(DISTINCT c.employee_id) AS antes
        FROM employee_work_calendars c
        JOIN employees e ON e.id = c.employee_id AND e.tenant_id = ?
       WHERE c.template_id IN (?)
         AND NOT EXISTS (SELECT 1 FROM employee_work_calendars x
                          WHERE x.employee_id = c.employee_id AND x.template_id = c.template_id
                            AND (x.valid_to IS NULL OR x.valid_to >= ?))
       GROUP BY c.template_id`, [tenantId, ids, hoy]);
    for (const f of filas) Object.assign(uso.get(f.id), {
      asignaciones: Number(f.asignaciones), algunaVez: Number(f.algunaVez), hoy: Number(f.hoy), futuras: Number(f.futuras),
    });
    for (const f of antes) uso.get(f.id).antes = Number(f.antes);
    const contar = async (campo, sql) => {
      for (const f of await q(db, sql, [ids])) uso.get(f.id)[campo] = Number(f.n);
    };
    await contar('reglas', 'SELECT template_id AS id, COUNT(*) AS n FROM day_type_overtime_rules WHERE template_id IN (?) GROUP BY template_id');
    await contar('historial', 'SELECT template_id AS id, COUNT(*) AS n FROM work_schedule_template_config_history WHERE template_id IN (?) GROUP BY template_id');
    await contar('categorias', 'SELECT plantilla_sugerida_id AS id, COUNT(*) AS n FROM employee_categories WHERE plantilla_sugerida_id IN (?) GROUP BY plantilla_sugerida_id');
    await contar('sombra', 'SELECT template_id AS id, COUNT(*) AS n FROM rule_engine_shadow_diffs WHERE template_id IN (?) GROUP BY template_id');
  }

  // A quiénes mide hoy la plantilla por defecto: activos sin una asignación
  // vigente a una plantilla activa de su empresa (mismo criterio que el cálculo).
  const def = plantillaPorDefectoQueRige(plantillas);
  let personasPorDefecto = 0;
  if (def) {
    const [r] = await q(db, `
      SELECT COUNT(*) AS n FROM employees e
       WHERE e.tenant_id = ? AND COALESCE(e.activo, 1) = 1
         AND NOT EXISTS (
           SELECT 1 FROM employee_work_calendars c
             JOIN work_schedule_templates t ON t.id = c.template_id AND t.active = 1
                  AND (t.tenant_id = e.tenant_id OR t.tenant_id = 0 OR t.tenant_id IS NULL)
            WHERE c.employee_id = e.id AND c.valid_from <= ? AND (c.valid_to IS NULL OR c.valid_to >= ?))`,
      [tenantId, hoy, hoy]);
    personasPorDefecto = r ? Number(r.n) : 0;
  }

  // Asignaciones de personas de esta empresa que el cálculo ignora porque su
  // plantilla no existe o es de otra empresa. Solo se muestran: no se reparan.
  const [rotas] = await q(db, `
    SELECT COUNT(*) AS n FROM employee_work_calendars c
      JOIN employees e ON e.id = c.employee_id AND e.tenant_id = ?
      LEFT JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE ${CONDICION_ROTA}`, [tenantId]);

  return {
    plantillas: uso,
    filas: plantillas,
    porDefectoId: def ? def.id : null,
    personasPorDefecto,
    asignacionesRotas: rotas ? Number(rotas.n) : 0,
  };
}

// ---------------------------------------------------------------------------
// Asignaciones "rotas": apuntan a una plantilla que ya no existe o que es de
// otra empresa. El cálculo YA las ignora (scheduleRepository: JOIN con la
// plantilla y misma empresa), así que quitarlas no cambia ningún número.
// Caso real (backup 15/10): 10 asignaciones de 3 personas de AVP a
// plantillas de las empresas de prueba 3 y 4, borradas con esas empresas.
// El administrador las puede ver y quitar él mismo (pedido del dueño
// 2026-10-16: "¿cómo lo soluciona sin llamarme?").
// La condición es la contraria a la del cálculo: si una cambia, cambiar la otra.
const CONDICION_ROTA = `(t.id IS NULL OR (t.tenant_id <> e.tenant_id AND t.tenant_id <> 0))`;

async function listarAsignacionesRotas(db, tenantId) {
  return q(db, `
    SELECT c.id, e.employee_id AS legajo, e.nombre, c.template_id AS plantillaId,
           LEFT(c.valid_from, 10) AS desde, LEFT(c.valid_to, 10) AS hasta,
           CASE WHEN t.id IS NULL THEN 'La plantilla ya no existe' ELSE 'La plantilla es de otra empresa' END AS motivo
      FROM employee_work_calendars c
      JOIN employees e ON e.id = c.employee_id AND e.tenant_id = ?
      LEFT JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE ${CONDICION_ROTA}
     ORDER BY e.nombre, c.valid_from`, [tenantId]);
}

// Borra SOLO las que siguen rotas y son de personas de esta empresa (si
// alguien pasa el id de una asignación válida o ajena, no se toca).
async function quitarAsignacionesRotas(db, tenantId, ids) {
  const limpios = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!limpios.length) return 0;
  const [r] = await db.query(`
    DELETE c FROM employee_work_calendars c
      JOIN employees e ON e.id = c.employee_id AND e.tenant_id = ?
      LEFT JOIN work_schedule_templates t ON t.id = c.template_id
     WHERE c.id IN (?) AND ${CONDICION_ROTA}`, [tenantId, limpios]);
  return r.affectedRows;
}

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Qué se puede hacer con una plantilla sin cambiar el pasado. Pura.
 * @param {object} u     uso de la plantilla (ver usoDePlantillas)
 * @param {boolean} esPorDefecto  es la plantilla por defecto que rige hoy
 * @param {boolean} archivada
 */
function decisiones(u, esPorDefecto, archivada = false) {
  const referencias = [];
  if (u.reglas) referencias.push(plural(u.reglas, 'regla de horas extra', 'reglas de horas extra'));
  if (u.historial) referencias.push(plural(u.historial, 'cambio de configuración guardado', 'cambios de configuración guardados'));
  if (u.categorias) referencias.push(plural(u.categorias, 'categoría que la sugiere', 'categorías que la sugieren'));
  if (u.sombra) referencias.push('resultados del motor de reglas nuevo');

  const porDefecto = esPorDefecto
    ? 'Es la plantilla por defecto: mide a todos los que no tienen horario propio. Primero marcá otra como "por defecto".'
    : null;
  const usada = u.asignaciones > 0
    ? `${u.algunaVez === 1 ? 'La tuvo asignada 1 persona' : `La tuvieron asignada ${u.algunaVez} personas`}. Si se borra o se desactiva, ${u.algunaVez === 1 ? 'esa persona pierde' : 'esas personas pierden'} este horario también en los días pasados, y cambian sus llegadas tarde, ausencias y horas extra ya calculadas.`
    : null;

  const borrar = porDefecto || usada
    || (referencias.length ? `Tiene ${referencias.join(', ')}. Sacalas primero o archivá la plantilla.` : null);
  const cambiarActiva = porDefecto || usada;
  const archivar = archivada ? null
    : porDefecto
      || (u.hoy > 0 || u.futuras > 0
        ? `Hoy la ${u.hoy + u.futuras === 1 ? 'tiene asignada 1 persona' : `tienen asignada ${u.hoy + u.futuras} personas`}. Asignales otro horario desde una fecha (lo anterior queda como estaba) y después archivala.`
        : null)
      // Una categoría que la sugiere la seguiría ofreciendo al asignar.
      || (u.categorias ? `La sugiere ${plural(u.categorias, 'categoría', 'categorías')} de empleados: cambiá esa sugerencia primero.` : null);

  return {
    puedeBorrarse: !borrar, motivoNoBorrar: borrar,
    puedeCambiarActiva: !cambiarActiva, motivoNoCambiarActiva: cambiarActiva,
    puedeArchivarse: !archivada && !archivar, motivoNoArchivar: archivar,
  };
}

module.exports = { usoDePlantillas, decisiones, plantillaPorDefectoQueRige, listarAsignacionesRotas, quitarAsignacionesRotas };
