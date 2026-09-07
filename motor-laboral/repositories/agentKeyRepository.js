// Fase 18 -- claves de agente por tenant (ver migrations/20260913_tenant_agent_keys.sql
// para el porque). Formato de la clave: "hda_<prefix>_<secret>" -- "hda"
// identifica el tipo de credencial de un vistazo en logs/config files,
// `prefix` (12 hex) permite buscarla rapido sin tener que hashear contra
// TODAS las filas, `secret` (32 bytes / 64 hex) es la parte que se hashea
// y nunca se guarda en texto plano.
const crypto = require('crypto');

const KEY_PREFIX_LABEL = 'hda';

function generateKeyMaterial() {
  const prefix = crypto.randomBytes(6).toString('hex'); // 12 chars
  const secret = crypto.randomBytes(32).toString('hex'); // 64 chars
  const plaintext = `${KEY_PREFIX_LABEL}_${prefix}_${secret}`;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, prefix, hash };
}

// Se guarda el hash del string COMPLETO (no solo del secret) -- asi un
// cambio en el prefix tambien invalidaria la clave, mas simple de razonar
// que hashear partes por separado.
async function createAgentKey({ tenantId, label, createdBy }, db) {
  const { plaintext, prefix, hash } = generateKeyMaterial();
  const [result] = await db.query(
    `INSERT INTO tenant_agent_keys (tenant_id, label, key_prefix, key_hash, created_by) VALUES (?, ?, ?, ?, ?)`,
    [tenantId, label || null, prefix, hash, createdBy || null]
  );
  // El plaintext SOLO se devuelve aca, en el momento de crearla -- no hay
  // forma de recuperarlo despues (mismo criterio que un token de GitHub).
  return { id: result.insertId, plaintext };
}

async function getAgentKeysForTenant(tenantId, db) {
  const [rows] = await db.query(
    `SELECT id, tenant_id, label, key_prefix, status, created_at, last_used_at
     FROM tenant_agent_keys WHERE tenant_id = ? ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

async function getAllAgentKeys(db) {
  const [rows] = await db.query(
    `SELECT k.id, k.tenant_id, k.label, k.key_prefix, k.status, k.created_at, k.last_used_at, t.name AS tenant_name
     FROM tenant_agent_keys k
     JOIN tenants t ON t.id = k.tenant_id
     ORDER BY t.name ASC, k.created_at DESC`
  );
  return rows;
}

async function setAgentKeyStatus(id, status, db) {
  await db.query(`UPDATE tenant_agent_keys SET status = ? WHERE id = ?`, [status, id]);
}

// Verifica una clave presentada por el agente. Devuelve el tenant_id si es
// valida y esta 'active', o null en cualquier otro caso (no encontrada,
// pausada, revocada) -- a proposito sin distinguir el motivo en la
// respuesta al agente (no darle pistas a quien intente adivinar claves).
async function verifyAgentKey(plaintextKey, db) {
  if (!plaintextKey || typeof plaintextKey !== 'string') return null;
  const parts = plaintextKey.split('_');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX_LABEL) return null;
  const prefix = parts[1];

  const [[row]] = await db.query(
    `SELECT id, tenant_id, key_hash, status FROM tenant_agent_keys WHERE key_prefix = ? LIMIT 1`,
    [prefix]
  );
  if (!row) return null;

  const hash = crypto.createHash('sha256').update(plaintextKey).digest('hex');
  const hashBuf = Buffer.from(hash, 'hex');
  const rowBuf = Buffer.from(row.key_hash, 'hex');
  // Comparacion en tiempo constante -- evita timing attacks sobre el hash.
  if (hashBuf.length !== rowBuf.length || !crypto.timingSafeEqual(hashBuf, rowBuf)) return null;
  if (row.status !== 'active') return null;

  db.query(`UPDATE tenant_agent_keys SET last_used_at = NOW() WHERE id = ?`, [row.id]).catch(() => {});
  return row.tenant_id;
}

module.exports = {
  createAgentKey,
  getAgentKeysForTenant,
  getAllAgentKeys,
  setAgentKeyStatus,
  verifyAgentKey
};
