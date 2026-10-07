// Control de aislamiento por empresa (AISLAMIENTO_POR_EMPRESA.md, letra A).
//
// Recorre TODAS las tablas que tienen tenant_id y avisa si hay filas sin
// empresa donde no deberia haberlas. Solo LEE: se puede correr contra
// produccion con las mismas variables MYSQL_ADDON_* que run-sql.js.
//
//   node scripts/verificar-aislamiento.js
//
// Por que existe: los datos "globales" que habia eran de AVP cargados sin
// empresa (feriados, horario, escala de vacaciones...) y se le aplicaban a
// cualquier empresa sin que nadie lo notara. Esto lo hace visible.
//
// Lo que SI puede no tener empresa, a proposito (no es de ninguna):
const PERMITIDOS = {
  // el usuario superadmin es de la plataforma
  app_users: 'is_superadmin = 1',
  // valores de la plataforma: Telegram del dueño, contador del chat de
  // ventas, firewall de la landing
  app_settings: "name IN ('telegramChatIds','chatVentasContadorDiario','firewallAllowedCountries','firewallAllowedIps')",
  // pedidos de alta: no tienen empresa hasta que el superadmin los aprueba
  signup_leads: '1 = 1',
  // avisos de MercadoPago que no se pudieron asociar (se revisan aparte)
  mercadopago_events: '1 = 1'
};

require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST, port: Number(process.env.MYSQL_ADDON_PORT || 3306),
    user: process.env.MYSQL_ADDON_USER, password: process.env.MYSQL_ADDON_PASSWORD, database: process.env.MYSQL_ADDON_DB
  });
  const [tablas] = await db.query(
    `SELECT TABLE_NAME AS t FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' ORDER BY TABLE_NAME`
  );
  let problemas = 0;
  for (const { t } of tablas) {
    const permitido = PERMITIDOS[t] ? ` AND NOT (${PERMITIDOS[t]})` : '';
    const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE (tenant_id IS NULL OR tenant_id = 0)${permitido}`);
    if (n > 0) {
      problemas++;
      console.log(`⚠️  ${t}: ${n} fila(s) sin empresa`);
    }
  }
  console.log(problemas === 0
    ? `✅ Base ${process.env.MYSQL_ADDON_DB}: ninguna fila sin empresa fuera de lo permitido.`
    : `\n${problemas} tabla(s) con filas sin empresa. Revisar antes de que una se le aplique a todas las empresas.`);
  await db.end();
  process.exit(problemas === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
