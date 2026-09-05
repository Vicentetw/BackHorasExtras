// app_settings con scoping por tenant (Fase 8, seguridad/multi-tenant):
// cada fila puede tener tenant_id NULL (default global) o un tenant_id
// puntual (override de esa empresa) -- mismo patron ya usado en
// payroll_regime_settings/holidays/vacation_scale: se prefiere la fila
// especifica del tenant si existe, si no la global.
//
// Antes app_settings no tenia tenant_id -- todo (corte de HE, tope de
// campana, limite de salida particular, modo de autorizacion de HE, tema,
// etc.) era una unica fila global compartida por TODAS las empresas del
// mismo backend: el admin de una empresa podia cambiarle sin querer la
// config a otra. Real solo si varias empresas comparten un mismo
// backend/base (multi-tenant compartido, la decision tomada para este
// sistema) -- con un backend por cliente no hacia falta esto.
//
// UNIQUE KEY real sobre (name, tenant_key) -- tenant_key es una columna
// generada (COALESCE(tenant_id, -1)) porque MySQL trata cada NULL como
// distinto en una UNIQUE KEY normal, lo que hubiera dejado duplicar la
// fila global sin querer. Con la UNIQUE KEY real, el upsert de abajo es
// atomico (un solo INSERT ... ON DUPLICATE KEY UPDATE, sin race entre
// DELETE e INSERT como en la primera version de este archivo -- esa
// version SIN unique key dejo pasar un caso real: dos filas globales para
// 'overtimeAuthorizationMode' con valores distintos, y el motor de horas
// extra eligiendo una al azar). Ver migrations/20260905b_app_settings_unique_key.sql.

async function getAppSetting(name, tenantId, db) {
  const [rows] = await db.query(
    `SELECT value FROM app_settings
     WHERE name = ? AND (tenant_id <=> ? OR tenant_id IS NULL)
     ORDER BY (tenant_id IS NULL) ASC
     LIMIT 1`,
    [name, tenantId]
  );
  return rows[0] ? rows[0].value : null;
}

async function setAppSetting(name, tenantId, value, db) {
  await db.query(
    `INSERT INTO app_settings (name, tenant_id, value) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP`,
    [name, tenantId, value]
  );
}

module.exports = { getAppSetting, setAppSetting };
