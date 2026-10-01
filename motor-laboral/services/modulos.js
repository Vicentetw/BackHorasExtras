// Modulos que el SUPERADMIN habilita empresa por empresa (segun lo que
// contrato cada una). Apagados por defecto: publicar un modulo nuevo no le
// cambia nada a ninguna empresa hasta que el superadmin lo prenda.
//
// Se guardan en app_settings (una fila por empresa), asi que no necesitan
// migracion. Valor '1' = habilitado; cualquier otra cosa o sin fila = apagado.
const { getAppSetting, setAppSetting } = require('../repositories/appSettingsRepository');

const MODULOS = {
  portalEmpleado: 'modulo_portal_empleado', // portal del empleado (PORTAL_EMPLEADO.md)
};

async function moduloHabilitado(db, tenantId, modulo) {
  if (tenantId == null || !MODULOS[modulo]) return false;
  // Solo la fila de ESA empresa: una fila global (tenant NULL) no habilita
  // nada, para que nunca se prenda un modulo para todos por accidente.
  const [[fila]] = await db.query('SELECT value FROM app_settings WHERE name = ? AND tenant_id = ?', [MODULOS[modulo], tenantId]);
  return !!fila && String(fila.value) === '1';
}

async function modulosDe(db, tenantId) {
  const out = {};
  for (const m of Object.keys(MODULOS)) out[m] = await moduloHabilitado(db, tenantId, m);
  return out;
}

async function setModulo(db, tenantId, modulo, habilitado) {
  if (!MODULOS[modulo]) throw new Error(`Modulo desconocido: ${modulo}`);
  await setAppSetting(MODULOS[modulo], tenantId, habilitado ? '1' : '0', db);
}

module.exports = { MODULOS, moduloHabilitado, modulosDe, setModulo, getAppSetting };
